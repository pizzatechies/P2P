import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency, bps, fromMinor } from "../lib/money.js";
import { isMerchant } from "./business.js";
import { postJournal, systemAccount, userAccount } from "./ledger.js";
import { notify } from "./push.js";
import { formEncode } from "./rails/stripe.js";
import { audit, getUserRow } from "./users.js";

/**
 * Tap to Pay: an approved business takes contactless card and phone payments (Apple Pay, Google Pay,
 * Samsung Pay, contactless cards) on its own phone, through Stripe Terminal's Tap to Pay on iPhone and
 * Android. Aurex creates the card-present payment for the merchant; the phone collects it; when Stripe
 * confirms it succeeded, the amount (less TAP_TO_PAY_FEE_BPS) lands in the merchant's Aurex wallet.
 */

export const tapConfigured = (ctx: Ctx) => Boolean(ctx.config.TAP_TO_PAY && ctx.config.STRIPE_SECRET_KEY && ctx.config.STRIPE_TERMINAL_LOCATION);

interface TapRow {
  id: string;
  user_id: string;
  provider_ref: string;
  currency: string;
  amount: number;
  fee: number;
  note: string | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
  journal_id: string | null;
  created_at: string;
  updated_at: string;
}

async function stripe<T>(ctx: Ctx, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.config.STRIPE_BASE_URL.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.config.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body ? formEncode(body).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, "tap_provider_error", `Couldn't reach Stripe: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, "tap_provider_error", `Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

function assertCanTake(ctx: Ctx, userId: string) {
  if (!tapConfigured(ctx)) throw new HttpError(503, "tap_unavailable", "Tap to Pay isn't set up on this server yet");
  if (!isMerchant(ctx, userId)) throw unprocessable("not_merchant", "Tap to Pay is for approved business accounts (Account → Business)");
  if (getUserRow(ctx, userId).status !== "active") throw unprocessable("account_frozen", "Your account is frozen");
}

const view = (r: TapRow) => ({
  id: r.id,
  amount: fromMinor(r.amount, r.currency),
  currency: r.currency,
  fee: fromMinor(r.fee, r.currency),
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
});

export function tapOverview(ctx: Ctx, userId: string) {
  const recent = all<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", userId).map(view);
  return {
    available: tapConfigured(ctx),
    merchant: isMerchant(ctx, userId),
    locationId: tapConfigured(ctx) ? ctx.config.STRIPE_TERMINAL_LOCATION : null,
    simulated: (ctx.config.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_"),
    feeBps: ctx.config.TAP_TO_PAY_FEE_BPS,
    recent,
  };
}

/** A connection token for the Stripe Terminal SDK on the merchant's phone. */
export async function connectionToken(ctx: Ctx, userId: string) {
  assertCanTake(ctx, userId);
  const t = await stripe<{ secret: string }>(ctx, "POST", "/terminal/connection_tokens", { location: ctx.config.STRIPE_TERMINAL_LOCATION });
  return { secret: t.secret };
}

/** Creates the card-present payment the merchant's phone will collect. */
export async function startTapPayment(ctx: Ctx, userId: string, input: { amountMinor: number; currency: string; note?: string }, ip?: string) {
  assertCanTake(ctx, userId);
  const currency = assertCurrency(input.currency).code;
  if (input.amountMinor <= 0) throw badRequest("Amount must be greater than zero");
  const id = newId("tap");
  const fee = bps(input.amountMinor, ctx.config.TAP_TO_PAY_FEE_BPS);
  const intent = await stripe<{ id: string; client_secret: string }>(ctx, "POST", "/payment_intents", {
    amount: input.amountMinor,
    currency: currency.toLowerCase(),
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    description: input.note?.trim() ? `Aurex Tap to Pay: ${input.note.trim().slice(0, 100)}` : "Aurex Tap to Pay",
    metadata: { aurex_tap_payment: id, aurex_user_id: userId },
  });
  const now = nowIso();
  run(
    ctx.db,
    "INSERT INTO tap_payments (id, user_id, provider_ref, currency, amount, fee, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    id, userId, intent.id, currency, input.amountMinor, fee, input.note?.trim() || null, now, now,
  );
  audit(ctx, userId, "tap.started", { id, amount: input.amountMinor, currency }, ip);
  return { ...view(one<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE id = ?", id)!), clientSecret: intent.client_secret, paymentIntentId: intent.id };
}

function own(ctx: Ctx, userId: string, id: string) {
  const r = one<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Payment not found");
  return r;
}

/** Applies what Stripe says about the payment (from the webhook, or when the phone asks). Idempotent. */
export function applyTapPayment(ctx: Ctx, intent: { id: string; status?: string; metadata?: Record<string, string> }) {
  const r = one<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE provider_ref = ?", intent.id);
  if (!r || r.status !== "pending") return r ? view(r) : null;
  // A declined tap leaves the payment waiting for another try, so only success and cancellation are final.
  const status = intent.status === "succeeded" ? "succeeded" : intent.status === "canceled" ? "canceled" : null;
  if (!status) return view(r);
  let credited = false;
  tx(ctx.db, () => {
    const fresh = one<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE id = ?", r.id)!;
    if (fresh.status !== "pending") return;
    let journalId: string | null = null;
    if (status === "succeeded") {
      journalId = postJournal(ctx, {
        kind: "card_sale",
        initiatorId: r.user_id,
        memo: r.note ? `Tap to Pay · ${r.note}` : "Tap to Pay",
        metadata: { tapPaymentId: r.id, paymentIntent: r.provider_ref, fee: r.fee, currency: r.currency },
        postings: [
          { accountId: systemAccount(ctx, "external", r.currency).id, amount: -r.amount, currency: r.currency },
          { accountId: userAccount(ctx, r.user_id, r.currency).id, amount: r.amount - r.fee, currency: r.currency },
          { accountId: systemAccount(ctx, "fees", r.currency).id, amount: r.fee, currency: r.currency },
        ],
      }).id;
      credited = true;
    }
    run(ctx.db, "UPDATE tap_payments SET status = ?, journal_id = ?, updated_at = ? WHERE id = ?", status, journalId, nowIso(), r.id);
  });
  if (credited) {
    void notify(ctx, r.user_id, {
      category: "payments",
      title: "Card payment received",
      message: `${r.currency} ${fromMinor(r.amount, r.currency)} by Tap to Pay${r.note ? `: ${r.note}` : ""}.`,
      path: "/app/payments",
      tags: ["moneybag"],
    });
  }
  return view(one<TapRow>(ctx.db, "SELECT * FROM tap_payments WHERE id = ?", r.id)!);
}

/** The phone checks the result after collecting; Aurex asks Stripe rather than trusting the phone. */
export async function refreshTapPayment(ctx: Ctx, userId: string, id: string) {
  const r = own(ctx, userId, id);
  if (r.status !== "pending") return view(r);
  const intent = await stripe<{ id: string; status: string; metadata?: Record<string, string> }>(ctx, "GET", `/payment_intents/${encodeURIComponent(r.provider_ref)}`);
  return applyTapPayment(ctx, intent)!;
}

export async function cancelTapPayment(ctx: Ctx, userId: string, id: string) {
  const r = own(ctx, userId, id);
  if (r.status !== "pending") return view(r);
  const intent = await stripe<{ id: string; status: string }>(ctx, "POST", `/payment_intents/${encodeURIComponent(r.provider_ref)}/cancel`, {});
  return applyTapPayment(ctx, { id: r.provider_ref, status: intent.status === "succeeded" ? "succeeded" : "canceled" })!;
}
