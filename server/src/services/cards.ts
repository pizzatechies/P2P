import { createHmac, randomBytes } from "node:crypto";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency, fromMinor, toMinor } from "../lib/money.js";
import * as bitnob from "./cardIssuers/bitnob.js";
import { approvedIdentity } from "./kyc.js";
import { assertIdentityCurrent } from "./kycRefresh.js";
import { InsufficientFundsError, postJournal, systemAccount, userAccount } from "./ledger.js";
import { notifyAdmins } from "./monitoring.js";
import { checkLimits } from "./payments.js";
import { notify } from "./push.js";
import { formEncode } from "./rails/stripe.js";
import { underSanctionsReview } from "./sanctions.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Aurex cards: a virtual debit card on Stripe Issuing that spends from the customer's Aurex wallet.
 *
 * Every card payment is decided here, in real time: Stripe asks (the `issuing_authorization.request`
 * webhook) and Aurex answers within two seconds, approving only if the card and account are in good
 * standing, the payment fits the customer's limits, and the money is in the wallet. Approved amounts
 * are held (wallet → card_holds); when the shop settles, the held money moves to card_settlement (paid
 * from the operator's Issuing balance), and refunds come back the same way.
 *
 * The card can be added to Apple Pay, Google Pay and Samsung Pay: by hand (the customer types the
 * card number, shown in Stripe's secure fields so it never touches Aurex's servers), or with "Add to
 * wallet" buttons once Stripe, Apple and Google approve push provisioning.
 *
 * On a test-money server (CARD_ISSUING=sandbox) the issuer is Aurex itself: customers get a test card
 * with a number from the well-known 4242 test range, and "test payments" run through exactly the same
 * approval, hold and settlement steps as real ones. Another issuer (for example one for Kenya and the
 * rest of Africa) plugs in where the "stripe" and "sandbox" branches are.
 */

export const cardsConfigured = (ctx: Ctx) => ctx.config.cardIssuer !== null;
const isSandbox = (c: { provider: string }) => c.provider === "sandbox";
/** Prepaid cards (Bitnob) hold their own balance, loaded from the wallet; the others spend the wallet directly. */
const isPrefunded = (c: { provider: string }) => c.provider === "bitnob";

/** The check digit that makes a card number pass the Luhn check. */
function luhnDigit(body: string) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** A test card's number and CVC, worked out from its id with the server's key: nothing to store or leak. */
function sandboxNumbers(ctx: Ctx, providerCardId: string) {
  const h = createHmac("sha256", ctx.config.masterKey).update(`sandbox-card:${providerCardId}`).digest();
  const body = `424242${Array.from(h.subarray(0, 9), (b) => String(b % 10)).join("")}`;
  return { number: body + luhnDigit(body), cvc: Array.from(h.subarray(9, 12), (b) => String(b % 10)).join("") };
}

interface CardRow {
  id: string;
  user_id: string;
  provider: string;
  provider_card_id: string;
  provider_cardholder_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  currency: string;
  status: "active" | "frozen" | "canceled";
  daily_limit: number | null;
  design: CardDesign;
  /** Prepaid cards only: what's loaded on the card. */
  balance: number | null;
  created_at: string;
  updated_at: string;
}
export type CardDesign = "gold" | "black";
export const CARD_DESIGNS: CardDesign[] = ["gold", "black"];
interface AuthRow {
  id: string;
  card_id: string;
  user_id: string;
  currency: string;
  amount: number;
  held: number;
  merchant_name: string | null;
  merchant_city: string | null;
  merchant_country: string | null;
  merchant_category: string | null;
  wallet: string | null;
  approved: number;
  decline_reason: string | null;
  status: "pending" | "closed" | "reversed" | "declined";
  created_at: string;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
async function stripe<T>(ctx: Ctx, method: "GET" | "POST", path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.config.STRIPE_BASE_URL.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.config.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: body ? formEncode(body).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, "card_provider_error", `Couldn't reach the card provider: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, "card_provider_error", `Card provider: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

// ---------------------------------------------------------------------------
// The customer's card
// ---------------------------------------------------------------------------
const activeCard = (ctx: Ctx, userId: string) => one<CardRow>(ctx.db, "SELECT * FROM cards WHERE user_id = ? AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1", userId);
function ownCard(ctx: Ctx, userId: string, cardId: string) {
  const c = one<CardRow>(ctx.db, "SELECT * FROM cards WHERE id = ? AND user_id = ?", cardId, userId);
  if (!c) throw notFound("Card not found");
  return c;
}

function cardView(c: CardRow) {
  return {
    id: c.id,
    brand: c.brand,
    last4: c.last4,
    expMonth: c.exp_month,
    expYear: c.exp_year,
    currency: c.currency,
    status: c.status,
    design: c.design,
    dailyLimit: c.daily_limit === null ? null : fromMinor(c.daily_limit, c.currency),
    prefunded: isPrefunded(c),
    balance: c.balance === null ? null : fromMinor(c.balance, c.currency),
    createdAt: c.created_at,
  };
}

/** Why this customer can't have a card yet (empty when they can). */
function blockers(ctx: Ctx, userId: string) {
  const u = getUserRow(ctx, userId);
  const out: string[] = [];
  if (u.status !== "active") out.push("Your account is frozen.");
  if (u.kyc_level < ctx.config.cardMinKycLevel) out.push(`Verify your identity to level ${ctx.config.cardMinKycLevel} (Account → Verification).`);
  if (ctx.config.requireEmailVerification && !u.email_verified_at) out.push("Confirm your email address.");
  if (underSanctionsReview(ctx, userId)) out.push("Your account is being reviewed.");
  try {
    assertIdentityCurrent(ctx, userId);
  } catch (e) {
    out.push((e as Error).message);
  }
  return out;
}

export function cardOverview(ctx: Ctx, userId: string) {
  const card = activeCard(ctx, userId);
  const tokens = card
    ? all<{ id: string; wallet: string | null; status: string; device: string | null; updated_at: string }>(
        ctx.db,
        "SELECT id, wallet, status, device, updated_at FROM card_wallet_tokens WHERE card_id = ? AND status <> 'deleted' ORDER BY updated_at DESC",
        card.id,
      ).map((t) => ({ id: t.id, wallet: t.wallet, status: t.status, device: t.device, updatedAt: t.updated_at }))
    : [];
  const activity = card
    ? all<AuthRow>(ctx.db, "SELECT * FROM card_authorizations WHERE card_id = ? ORDER BY created_at DESC LIMIT 30", card.id).map((a) => ({
        id: a.id,
        amount: fromMinor(a.amount, a.currency),
        currency: a.currency,
        merchant: a.merchant_name,
        city: a.merchant_city,
        country: a.merchant_country,
        wallet: a.wallet,
        approved: Boolean(a.approved),
        declineReason: a.decline_reason,
        status: a.status,
        createdAt: a.created_at,
      }))
    : [];
  const available = cardsConfigured(ctx);
  const app = card ? undefined : one<AppRow>(ctx.db, "SELECT * FROM card_applications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", userId);
  const fees = issuerFees(ctx);
  const pendingFunding = card
    ? one<{ type: string; amount: number }>(ctx.db, "SELECT type, amount FROM card_fundings WHERE card_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", card.id)
    : undefined;
  return {
    available,
    /** Prepaid cards: the customer loads money onto the card (Bitnob). */
    prefunded: ctx.config.cardIssuer === "bitnob",
    application: app && app.status !== "done" ? { status: app.status, reason: app.reason, link: app.link, opening: fromMinor(app.opening, app.currency), createdAt: app.created_at } : null,
    pendingFunding: pendingFunding && card ? { type: pendingFunding.type, amount: fromMinor(pendingFunding.amount, card.currency) } : null,
    fees: fees ? { issue: fromMinor(fees.issue, "USD"), loadMin: fromMinor(fees.loadMin, "USD"), loadBps: fees.loadBps } : null,
    /** "sandbox": test cards and test payments; nothing can be spent in shops. */
    issuer: ctx.config.cardIssuer,
    currency: assertCurrency(ctx.config.CARD_CURRENCY).code,
    blockers: available ? blockers(ctx, userId) : [],
    card: card ? cardView(card) : null,
    wallets: tokens,
    activity,
    walletButtons: ctx.config.CARD_WALLET_BUTTONS,
    publishableKey: ctx.config.STRIPE_PUBLISHABLE_KEY ?? null,
  };
}

export interface CardApplication {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  /** Gold (the default) or Black. */
  design?: CardDesign;
  // Prepaid cards (Bitnob) only: what the card issuer's own check asks for, and the first load.
  occupation?: string;
  employmentStatus?: "employed" | "self_employed" | "unemployed" | "retired" | "student";
  yearlyIncomeUsd?: number;
  monthlySpendUsd?: number;
  purpose?: string;
  openingAmount?: string;
}

/** Issues the customer's virtual card (one at a time). */
export async function issueCard(ctx: Ctx, userId: string, input: CardApplication, ip?: string) {
  if (!cardsConfigured(ctx)) throw new HttpError(503, "cards_unavailable", "Cards aren't available on this server yet");
  const reasons = blockers(ctx, userId);
  if (reasons.length) throw unprocessable("card_not_allowed", reasons.join(" "));
  if (activeCard(ctx, userId)) throw unprocessable("card_exists", "You already have an Aurex card");
  if (ctx.config.cardIssuer === "bitnob") return applyForPrepaidCard(ctx, userId, input, ip);
  if (ctx.config.cardIssuer === "sandbox") {
    const providerCardId = `sbx_card_${randomBytes(12).toString("hex")}`;
    const { number } = sandboxNumbers(ctx, providerCardId);
    const exp = new Date();
    return saveIssuedCard(ctx, userId, input, ip, "sandbox", `sbx_ch_${userId}`, {
      id: providerCardId, brand: "Visa", last4: number.slice(-4), exp_month: exp.getUTCMonth() + 1, exp_year: exp.getUTCFullYear() + 3,
    });
  }

  const user = getUserRow(ctx, userId);
  const currency = assertCurrency(ctx.config.CARD_CURRENCY).code;

  // One cardholder per customer, kept across replacement cards.
  let cardholderId = one<{ provider_cardholder_id: string }>(ctx.db, "SELECT provider_cardholder_id FROM cards WHERE user_id = ? AND provider = 'stripe' ORDER BY created_at DESC LIMIT 1", userId)?.provider_cardholder_id;
  if (!cardholderId) {
    const name = input.name.trim();
    const space = name.lastIndexOf(" ");
    const holder = await stripe<{ id: string }>(ctx, "POST", "/issuing/cardholders", {
      type: "individual",
      name,
      email: user.email,
      phone_number: input.phone?.trim() || undefined,
      billing: { address: { line1: input.line1, line2: input.line2 || undefined, city: input.city, state: input.state || undefined, postal_code: input.postalCode || undefined, country: input.country.toUpperCase() } },
      individual: {
        first_name: space > 0 ? name.slice(0, space) : name,
        last_name: space > 0 ? name.slice(space + 1) : name,
        card_issuing: { user_terms_acceptance: { date: Math.floor(Date.now() / 1000), ip: ip ?? undefined } },
      },
      metadata: { aurex_user_id: userId },
    });
    cardholderId = holder.id;
  }
  const card = await stripe<{ id: string; brand?: string; last4?: string; exp_month?: number; exp_year?: number }>(ctx, "POST", "/issuing/cards", {
    cardholder: cardholderId,
    currency: currency.toLowerCase(),
    type: "virtual",
    status: "active",
    metadata: { aurex_user_id: userId },
  });
  return saveIssuedCard(ctx, userId, input, ip, "stripe", cardholderId, card);
}

type IssuedCard = { id: string; brand?: string; last4?: string; exp_month?: number; exp_year?: number };

function saveIssuedCard(ctx: Ctx, userId: string, input: CardApplication, ip: string | undefined, provider: string, cardholderId: string, card: IssuedCard) {
  const currency = assertCurrency(ctx.config.CARD_CURRENCY).code;
  const id = newId("card");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO cards (id, user_id, provider, provider_card_id, provider_cardholder_id, brand, last4, exp_month, exp_year, currency, status, design, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id, userId, provider, card.id, cardholderId, card.brand ?? null, card.last4 ?? null, card.exp_month ?? null, card.exp_year ?? null, currency, input.design ?? "gold", now, now,
  );
  audit(ctx, userId, "card.issued", { card: id, provider }, ip);
  addAlert(ctx, userId, "card", `Your ${provider === "sandbox" ? "test " : ""}Aurex card ending ${card.last4 ?? ""} is ready. It spends from your ${currency} wallet.`, ip);
  return cardOverview(ctx, userId);
}

/** Freeze (instantly stops new payments), unfreeze, or cancel for good. */
export async function setCardStatus(ctx: Ctx, userId: string, cardId: string, action: "freeze" | "unfreeze" | "cancel", ip?: string) {
  const c = ownCard(ctx, userId, cardId);
  if (c.status === "canceled") throw unprocessable("card_canceled", "This card is cancelled");
  const status = action === "freeze" ? "frozen" : action === "unfreeze" ? "active" : "canceled";
  if (action === "unfreeze") {
    const reasons = blockers(ctx, userId);
    if (reasons.length) throw unprocessable("card_not_allowed", reasons.join(" "));
  }
  if (isPrefunded(c)) {
    // The issuer holds the card's money and decides its payments, so a change only counts once it has it.
    if (action === "cancel") {
      await bitnob.terminate(ctx, c.provider_card_id, "Cancelled by the cardholder");
      closePrepaidCard(ctx, c.id, "Card cancelled");
    } else {
      await bitnob.setStatus(ctx, c.provider_card_id, status === "frozen" ? "frozen" : "active");
      run(ctx.db, "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), c.id);
    }
    audit(ctx, userId, `card.${action}`, { card: c.id }, ip);
    if (action !== "unfreeze") addAlert(ctx, userId, "card", action === "freeze" ? `Your card ending ${c.last4} is frozen. Unfreeze it any time in Aurex.` : `Your card ending ${c.last4} is cancelled. What was on it is back in your wallet.`, ip);
    return cardOverview(ctx, userId);
  }
  // Freezing takes effect here first: Aurex declines every payment on a frozen card even if the
  // provider can't be reached.
  run(ctx.db, "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), c.id);
  try {
    if (!isSandbox(c)) await stripe(ctx, "POST", `/issuing/cards/${encodeURIComponent(c.provider_card_id)}`, { status: status === "frozen" ? "inactive" : status === "active" ? "active" : "canceled" });
  } catch (err) {
    if (action !== "freeze") {
      run(ctx.db, "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?", c.status, nowIso(), c.id);
      throw err;
    }
  }
  audit(ctx, userId, `card.${action}`, { card: c.id }, ip);
  if (action !== "unfreeze") addAlert(ctx, userId, "card", action === "freeze" ? `Your card ending ${c.last4} is frozen. Unfreeze it any time in Aurex.` : `Your card ending ${c.last4} is cancelled.`, ip);
  return cardOverview(ctx, userId);
}

/** Switch between the Gold and the Black card. */
export function setCardDesign(ctx: Ctx, userId: string, cardId: string, design: CardDesign) {
  const c = ownCard(ctx, userId, cardId);
  if (!CARD_DESIGNS.includes(design)) throw badRequest("Choose gold or black");
  run(ctx.db, "UPDATE cards SET design = ?, updated_at = ? WHERE id = ?", design, nowIso(), c.id);
  return cardOverview(ctx, userId);
}

export function setCardLimit(ctx: Ctx, userId: string, cardId: string, limitMinor: number | null) {
  const c = ownCard(ctx, userId, cardId);
  if (isPrefunded(c)) throw unprocessable("not_supported", "A prepaid card can only spend what you load onto it, so it doesn't need a daily limit.");
  if (limitMinor !== null && limitMinor <= 0) throw badRequest("The limit must be more than zero");
  run(ctx.db, "UPDATE cards SET daily_limit = ?, updated_at = ? WHERE id = ?", limitMinor, nowIso(), c.id);
  return cardOverview(ctx, userId);
}

/**
 * A short-lived key that lets the customer's own browser show the card number and CVC in Stripe's
 * secure fields (the `nonce` comes from Stripe.js), or add the card to a phone wallet. The number never
 * reaches Aurex.
 */
export async function cardKey(ctx: Ctx, userId: string, cardId: string, nonce: string | undefined, ip?: string) {
  const c = ownCard(ctx, userId, cardId);
  if (c.status === "canceled") throw unprocessable("card_canceled", "This card is cancelled");
  if (isSandbox(c)) {
    audit(ctx, userId, "card.details_shown", { card: c.id }, ip);
    return { sandbox: true as const, ...sandboxNumbers(ctx, c.provider_card_id), expMonth: c.exp_month, expYear: c.exp_year };
  }
  if (isPrefunded(c)) {
    // Passed straight to the cardholder's app and never stored or logged.
    const d = await bitnob.revealCard(ctx, c.provider_card_id);
    audit(ctx, userId, "card.details_shown", { card: c.id }, ip);
    return { provider: "bitnob" as const, ...d };
  }
  if (!ctx.config.STRIPE_PUBLISHABLE_KEY) throw new HttpError(503, "cards_unavailable", "Card details can't be shown yet: STRIPE_PUBLISHABLE_KEY isn't set");
  const key = await stripe<{ secret: string }>(ctx, "POST", "/ephemeral_keys", { issuing_card: c.provider_card_id, nonce }, { "Stripe-Version": ctx.config.STRIPE_API_VERSION });
  audit(ctx, userId, "card.details_shown", { card: c.id }, ip);
  return { ephemeralKeySecret: key.secret, providerCardId: c.provider_card_id, publishableKey: ctx.config.STRIPE_PUBLISHABLE_KEY, apiVersion: ctx.config.STRIPE_API_VERSION };
}

/** Closing an account cancels its card (best effort; payments are declined from now on regardless). */
export async function cancelCardsForUser(ctx: Ctx, userId: string) {
  for (const c of all<CardRow>(ctx.db, "SELECT * FROM cards WHERE user_id = ? AND status <> 'canceled'", userId)) {
    if (isPrefunded(c)) {
      await bitnob.terminate(ctx, c.provider_card_id, "Account closed").catch(() => undefined);
      closePrepaidCard(ctx, c.id, "Account closed");
      continue;
    }
    run(ctx.db, "UPDATE cards SET status = 'canceled', updated_at = ? WHERE id = ?", nowIso(), c.id);
    if (ctx.config.cardIssuer === "stripe" && !isSandbox(c)) await stripe(ctx, "POST", `/issuing/cards/${encodeURIComponent(c.provider_card_id)}`, { status: "canceled" }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Card payments (Stripe Issuing webhooks)
// ---------------------------------------------------------------------------
export interface StripeAuthorization {
  id: string;
  card?: { id?: string } | string;
  amount?: number;
  currency?: string;
  approved?: boolean;
  status?: string;
  wallet?: string | null;
  pending_request?: { amount?: number; currency?: string } | null;
  merchant_data?: { name?: string | null; city?: string | null; country?: string | null; category?: string | null };
  request_history?: { approved?: boolean; reason?: string }[];
}

const DECLINE_TEXT: Record<string, string> = {
  card_frozen: "your card is frozen",
  card_canceled: "your card is cancelled",
  account_frozen: "your account is frozen",
  under_review: "your account is being reviewed",
  identity_update: "your identity details need updating",
  card_limit: "it's over your card's daily limit",
  account_limit: "it's over your account limits",
  insufficient_funds: "there wasn't enough in your wallet",
  currency: "the card currency didn't match",
};

const cardIdOf = (a: StripeAuthorization) => (typeof a.card === "string" ? a.card : a.card?.id) ?? "";
const findCard = (ctx: Ctx, providerCardId: string) => one<CardRow>(ctx.db, "SELECT * FROM cards WHERE provider_card_id = ?", providerCardId);

function recordAuthorization(ctx: Ctx, a: StripeAuthorization, card: CardRow, amount: number, currency: string, approved: boolean, reason: string | null, held: number) {
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO card_authorizations (id, card_id, user_id, currency, amount, held, merchant_name, merchant_city, merchant_country, merchant_category, wallet, approved, decline_reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, card.id, card.user_id, currency, amount, held,
    a.merchant_data?.name ?? null, a.merchant_data?.city ?? null, a.merchant_data?.country ?? null, a.merchant_data?.category ?? null,
    a.wallet ?? null, approved ? 1 : 0, reason, approved ? "pending" : "declined", now, now,
  );
}

const merchantOf = (a: { merchant_name?: string | null }) => a.merchant_name || "a shop";

/** Answers Stripe's real-time question: approve this card payment? Holds the money if so. */
export async function decideAuthorization(ctx: Ctx, a: StripeAuthorization): Promise<{ approved: boolean; reason?: string }> {
  const existing = one<AuthRow>(ctx.db, "SELECT * FROM card_authorizations WHERE id = ?", a.id);
  if (existing) return { approved: Boolean(existing.approved), reason: existing.decline_reason ?? undefined };
  const card = findCard(ctx, cardIdOf(a));
  if (!card) return { approved: false, reason: "unknown_card" };
  const amount = a.pending_request?.amount ?? a.amount ?? 0;
  const currency = (a.pending_request?.currency ?? a.currency ?? card.currency).toUpperCase();
  const decline = (reason: string) => {
    recordAuthorization(ctx, a, card, amount, currency, false, reason, 0);
    void notify(ctx, card.user_id, {
      category: "payments",
      title: "Card payment declined",
      message: `${currency} ${fromMinor(Math.max(0, amount), currency)} at ${a.merchant_data?.name || "a shop"} was declined because ${DECLINE_TEXT[reason] ?? "it couldn't be approved"}.`,
      path: "/app/card",
      tags: ["no_entry"],
      priority: 4,
    });
    return { approved: false, reason };
  };

  if (amount <= 0) {
    // A zero-amount check (e.g. a card verification) costs nothing: approve it if the card is usable.
    if (card.status !== "active" || getUserRow(ctx, card.user_id).status !== "active") return decline(card.status === "active" ? "account_frozen" : `card_${card.status}`);
    recordAuthorization(ctx, a, card, 0, currency, true, null, 0);
    return { approved: true };
  }
  if (currency !== card.currency) return decline("currency");
  if (card.status !== "active") return decline(card.status === "frozen" ? "card_frozen" : "card_canceled");
  const user = getUserRow(ctx, card.user_id);
  if (user.status !== "active") return decline("account_frozen");
  if (underSanctionsReview(ctx, user.id)) return decline("under_review");
  try {
    assertIdentityCurrent(ctx, user.id);
  } catch {
    return decline("identity_update");
  }
  if (card.daily_limit !== null) {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const spent = one<{ n: number }>(ctx.db, "SELECT COALESCE(SUM(amount), 0) AS n FROM card_authorizations WHERE card_id = ? AND approved = 1 AND created_at >= ?", card.id, since)!.n;
    if (spent + amount > card.daily_limit) return decline("card_limit");
  }
  try {
    await checkLimits(ctx, user.id, currency, amount);
  } catch {
    return decline("account_limit");
  }
  try {
    tx(ctx.db, () => {
      postJournal(ctx, {
        kind: "card_hold",
        initiatorId: user.id,
        memo: `Card · ${a.merchant_data?.name ?? "payment"}`,
        metadata: { authorizationId: a.id, cardId: card.id, merchant: a.merchant_data?.name ?? null },
        postings: [
          { accountId: userAccount(ctx, user.id, currency).id, amount: -amount, currency },
          { accountId: systemAccount(ctx, "card_holds", currency).id, amount, currency },
        ],
      });
      recordAuthorization(ctx, a, card, amount, currency, true, null, amount);
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return decline("insufficient_funds");
    throw err;
  }
  void notify(ctx, user.id, {
    category: "payments",
    title: "Card payment",
    message: `${currency} ${fromMinor(amount, currency)} at ${a.merchant_data?.name || "a shop"}${a.wallet ? ` with ${walletName(a.wallet)}` : ""}.`,
    path: "/app/card",
    tags: ["credit_card"],
  });
  return { approved: true };
}

const walletName = (w: string) => (w === "apple_pay" ? "Apple Pay" : w === "google_pay" ? "Google Pay" : w === "samsung_pay" ? "Samsung Pay" : w);

/** Gives back whatever is still held for an authorisation (it was reversed, expired, or fully settled). */
function release(ctx: Ctx, auth: AuthRow, amount: number, why: string) {
  if (amount <= 0) return;
  postJournal(ctx, {
    kind: "card_release",
    initiatorId: auth.user_id,
    memo: `Card · ${merchantOf(auth)} · ${why}`,
    metadata: { authorizationId: auth.id, cardId: auth.card_id },
    postings: [
      { accountId: systemAccount(ctx, "card_holds", auth.currency).id, amount: -amount, currency: auth.currency },
      { accountId: userAccount(ctx, auth.user_id, auth.currency).id, amount, currency: auth.currency },
    ],
  });
  run(ctx.db, "UPDATE card_authorizations SET held = held - ?, updated_at = ? WHERE id = ?", amount, nowIso(), auth.id);
}

/** `issuing_authorization.created` / `.updated`: reversals, partial reversals, expiry, and decisions Stripe made without us. */
export function applyAuthorizationUpdate(ctx: Ctx, a: StripeAuthorization) {
  tx(ctx.db, () => {
    const row = one<AuthRow>(ctx.db, "SELECT * FROM card_authorizations WHERE id = ?", a.id);
    if (!row) {
      // Stripe decided without hearing from Aurex (a timeout or an outage): record it, and tell the team
      // if it approved a payment nothing was held for.
      const card = findCard(ctx, cardIdOf(a));
      if (!card) return;
      const amount = a.amount ?? a.pending_request?.amount ?? 0;
      const reason = a.approved ? null : a.request_history?.[a.request_history.length - 1]?.reason ?? "declined";
      recordAuthorization(ctx, a, card, amount, (a.currency ?? card.currency).toUpperCase(), Boolean(a.approved), reason, 0);
      if (a.approved && amount > 0) notifyAdmins(ctx, `A card payment (${a.id}) was approved by Stripe's fallback without a hold in Aurex. It will be charged to the customer's wallet when it settles.`);
      return;
    }
    if (row.status !== "pending") return;
    if (a.status === "reversed" || a.status === "expired") {
      release(ctx, row, row.held, a.status === "reversed" ? "cancelled by the shop" : "expired");
      run(ctx.db, "UPDATE card_authorizations SET status = 'reversed', updated_at = ? WHERE id = ?", nowIso(), row.id);
      return;
    }
    if (a.status === "closed") {
      // Fully settled: any settlement already moved the held money; give back the rest.
      const settled = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM card_transactions WHERE authorization_id = ? AND type = 'capture'", row.id)!.n;
      if (settled > 0) release(ctx, row, row.held, "settled for less");
      run(ctx.db, "UPDATE card_authorizations SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), row.id);
      return;
    }
    // Still pending, but for less (a partial reversal): hold only what's still authorised.
    if (typeof a.amount === "number" && a.amount >= 0 && a.amount < row.held) release(ctx, row, row.held - a.amount, "partly cancelled by the shop");
  });
}

export interface StripeTransaction {
  id: string;
  type?: "capture" | "refund";
  amount?: number;
  currency?: string;
  card?: { id?: string } | string;
  authorization?: { id?: string } | string | null;
  merchant_data?: { name?: string | null };
}

/** `issuing_transaction.created`: the shop settled a payment, or refunded one. */
export function applyTransaction(ctx: Ctx, t: StripeTransaction) {
  const card = findCard(ctx, (typeof t.card === "string" ? t.card : t.card?.id) ?? "");
  if (!card) return;
  if (one(ctx.db, "SELECT 1 FROM card_transactions WHERE id = ?", t.id)) return;
  const currency = (t.currency ?? card.currency).toUpperCase();
  const amount = Math.abs(t.amount ?? 0);
  if (amount === 0) return;
  const authId = (typeof t.authorization === "string" ? t.authorization : t.authorization?.id) ?? null;
  const merchant = t.merchant_data?.name ?? null;
  let shortfall = 0;
  tx(ctx.db, () => {
    let journalId: string;
    if (t.type === "refund") {
      journalId = postJournal(ctx, {
        kind: "card_refund",
        initiatorId: card.user_id,
        memo: `Card refund · ${merchant ?? "shop"}`,
        metadata: { transactionId: t.id, cardId: card.id, authorizationId: authId },
        postings: [
          { accountId: systemAccount(ctx, "card_settlement", currency).id, amount: -amount, currency },
          { accountId: userAccount(ctx, card.user_id, currency).id, amount, currency },
        ],
      }).id;
    } else {
      const auth = authId ? one<AuthRow>(ctx.db, "SELECT * FROM card_authorizations WHERE id = ?", authId) : undefined;
      const fromHold = Math.min(auth?.held ?? 0, amount);
      // More than was held (a tip, a currency difference, or a payment settled without approval) is taken
      // from the wallet; anything the wallet can't cover is recorded against "external" for the team to
      // collect, since the shop has already been paid.
      const wallet = userAccount(ctx, card.user_id, currency);
      const extra = amount - fromHold;
      const fromWallet = Math.min(extra, Math.max(0, wallet.balance));
      shortfall = extra - fromWallet;
      journalId = postJournal(ctx, {
        kind: "card_capture",
        initiatorId: card.user_id,
        memo: `Card · ${merchant ?? auth?.merchant_name ?? "payment"}`,
        metadata: { transactionId: t.id, cardId: card.id, authorizationId: authId, ...(shortfall ? { shortfall } : {}) },
        postings: [
          { accountId: systemAccount(ctx, "card_holds", currency).id, amount: -fromHold, currency },
          { accountId: wallet.id, amount: -fromWallet, currency },
          { accountId: systemAccount(ctx, "external", currency).id, amount: -shortfall, currency },
          { accountId: systemAccount(ctx, "card_settlement", currency).id, amount, currency },
        ],
      }).id;
      if (auth && fromHold > 0) run(ctx.db, "UPDATE card_authorizations SET held = held - ?, updated_at = ? WHERE id = ?", fromHold, nowIso(), auth.id);
    }
    run(
      ctx.db,
      "INSERT INTO card_transactions (id, card_id, user_id, authorization_id, type, currency, amount, merchant_name, journal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.id, card.id, card.user_id, authId, t.type === "refund" ? "refund" : "capture", currency, amount, merchant, journalId, nowIso(),
    );
  });
  if (shortfall > 0) notifyAdmins(ctx, `Card payment ${t.id} settled for ${currency} ${fromMinor(shortfall, currency)} more than the customer's wallet held. Follow up with the customer.`);
  if (t.type === "refund") {
    void notify(ctx, card.user_id, { category: "payments", title: "Card refund", message: `${currency} ${fromMinor(amount, currency)} from ${merchant ?? "a shop"} is back in your wallet.`, path: "/app/card", tags: ["moneybag"] });
  }
}

export interface StripeToken {
  id: string;
  card?: { id?: string } | string;
  status?: string;
  wallet_provider?: string | null;
  network_data?: { device?: { name?: string | null; type?: string | null } | null } | null;
}

/** `issuing_token.created` / `.updated`: the card was added to (or removed from) a phone wallet. */
export function applyToken(ctx: Ctx, t: StripeToken) {
  const card = findCard(ctx, (typeof t.card === "string" ? t.card : t.card?.id) ?? "");
  if (!card) return;
  const status = t.status ?? "active";
  const wallet = t.wallet_provider ?? null;
  const device = t.network_data?.device?.name ?? t.network_data?.device?.type ?? null;
  const now = nowIso();
  const before = one<{ status: string }>(ctx.db, "SELECT status FROM card_wallet_tokens WHERE id = ?", t.id);
  if (before) run(ctx.db, "UPDATE card_wallet_tokens SET status = ?, wallet = COALESCE(?, wallet), device = COALESCE(?, device), updated_at = ? WHERE id = ?", status, wallet, device, now, t.id);
  else run(ctx.db, "INSERT INTO card_wallet_tokens (id, card_id, wallet, status, device, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", t.id, card.id, wallet, status, device, now, now);
  // Adding a card to a phone is how stolen card details get used, so the customer always hears about it.
  if (status === "active" && before?.status !== "active") {
    addAlert(ctx, card.user_id, "card_wallet", `Your Aurex card ending ${card.last4} was added to ${wallet ? walletName(wallet) : "a phone wallet"}${device ? ` on ${device}` : ""}. If this wasn't you, freeze the card in Aurex now.`);
  }
}

/** `issuing_card.updated`: keep a freeze or cancellation made in the Stripe Dashboard in step. */
export function applyCardUpdate(ctx: Ctx, c: { id: string; status?: string }) {
  const card = findCard(ctx, c.id);
  if (!card || card.status === "canceled") return;
  const status = c.status === "canceled" ? "canceled" : c.status === "inactive" ? "frozen" : c.status === "active" ? "active" : null;
  if (status && status !== card.status) run(ctx.db, "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), card.id);
}

// ---------------------------------------------------------------------------
// Test payments (sandbox cards only)
// ---------------------------------------------------------------------------
export interface TestPayment {
  amountMinor: number;
  merchant: string;
  city?: string;
  country?: string;
  wallet?: "apple_pay" | "google_pay" | "samsung_pay" | null;
}

/**
 * Pays a pretend shop with a test card. It goes through the same real-time decision as a real card
 * payment (frozen card, limits, identity, balance), then settles straight away.
 */
export async function testCardPayment(ctx: Ctx, userId: string, cardId: string, p: TestPayment) {
  const c = ownCard(ctx, userId, cardId);
  if (!isSandbox(c)) throw unprocessable("not_a_test_card", "Test payments are only for test cards");
  if (p.amountMinor <= 0) throw badRequest("Enter an amount");
  const authId = `sbx_auth_${randomBytes(12).toString("hex")}`;
  const merchant_data = { name: p.merchant, city: p.city ?? null, country: p.country ?? null, category: "test" };
  const decision = await decideAuthorization(ctx, {
    id: authId,
    card: c.provider_card_id,
    amount: p.amountMinor,
    currency: c.currency,
    pending_request: { amount: p.amountMinor, currency: c.currency },
    merchant_data,
    wallet: p.wallet ?? null,
  });
  if (decision.approved) {
    applyTransaction(ctx, { id: `sbx_tx_${randomBytes(12).toString("hex")}`, type: "capture", amount: p.amountMinor, currency: c.currency, card: c.provider_card_id, authorization: authId, merchant_data });
    applyAuthorizationUpdate(ctx, { id: authId, status: "closed" });
  }
  return {
    approved: decision.approved,
    message: decision.approved ? null : `Declined: ${DECLINE_TEXT[decision.reason ?? ""] ?? "it couldn't be approved"}.`,
    overview: cardOverview(ctx, userId),
  };
}

/** Holds Stripe never resolved (no settlement or reversal in 31 days) go back to the wallet. */
export function releaseStaleHolds(ctx: Ctx, now = Date.now()) {
  const cutoff = new Date(now - 31 * 24 * 3600_000).toISOString();
  let n = 0;
  for (const auth of all<AuthRow>(ctx.db, "SELECT * FROM card_authorizations WHERE status = 'pending' AND held > 0 AND created_at < ?", cutoff)) {
    tx(ctx.db, () => {
      release(ctx, auth, auth.held, "expired");
      run(ctx.db, "UPDATE card_authorizations SET status = 'reversed', updated_at = ? WHERE id = ?", nowIso(), auth.id);
    });
    n++;
  }
  return n;
}

export function startCardJob(ctx: Ctx, everyMs = 6 * 3600_000) {
  if (!cardsConfigured(ctx) || ctx.config.isTest) return () => undefined;
  const t = setInterval(() => {
    try {
      releaseStaleHolds(ctx);
    } catch (err) {
      console.error(`[cards] ${(err as Error).message}`);
    }
    // Prepaid cards: catch up with anything the issuer's webhooks didn't tell us.
    if (ctx.config.cardIssuer === "bitnob") void syncPrepaidCards(ctx).catch((err) => console.error(`[cards] ${(err as Error).message}`));
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

// ---------------------------------------------------------------------------
// Prepaid cards (Bitnob): applications, loading, moving money back, and the issuer's webhooks
// ---------------------------------------------------------------------------
interface AppRow {
  id: string;
  user_id: string;
  provider: string;
  customer_id: string | null;
  status: "kyc_pending" | "creating" | "failed" | "done";
  reason: string | null;
  link: string | null;
  name: string;
  design: CardDesign;
  currency: string;
  opening: number;
  fee: number;
  journal_id: string | null;
  provider_card_id: string | null;
  card_id: string | null;
  created_at: string;
}
interface FundingRow {
  id: string;
  card_id: string;
  user_id: string;
  type: "fund" | "withdraw";
  currency: string;
  amount: number;
  fee: number;
  status: "pending" | "completed" | "failed";
}

/** Bitnob's published card fees, passed on to the customer unless CARD_ISSUER_FEES=false. */
export function issuerFees(ctx: Ctx) {
  if (ctx.config.cardIssuer !== "bitnob" || !ctx.config.CARD_ISSUER_FEES) return null;
  return { issue: 100, loadMin: 100, loadBps: 100 };
}
const loadFee = (ctx: Ctx, amount: number) => {
  const f = issuerFees(ctx);
  return f ? Math.max(f.loadMin, Math.round((amount * f.loadBps) / 10_000)) : 0;
};
const MIN_LOAD = 200; // $2, Bitnob's minimum
const MAX_LOAD = 250_000; // $2,500
const webhookUrl = (ctx: Ctx) => `${ctx.config.appOrigin}/api/webhooks/bitnob`;
const usd = (minor: number) => `$${fromMinor(minor, "USD")}`;

/** Wallet → card (and the issuer's fee → fee income). */
function loadJournal(ctx: Ctx, userId: string, currency: string, amount: number, fee: number, memo: string, metadata: Record<string, unknown>) {
  return postJournal(ctx, {
    kind: "card_load",
    initiatorId: userId,
    memo,
    metadata,
    postings: [
      { accountId: userAccount(ctx, userId, currency).id, amount: -(amount + fee), currency },
      { accountId: systemAccount(ctx, "card_funding", currency).id, amount, currency },
      ...(fee ? [{ accountId: systemAccount(ctx, "fees", currency).id, amount: fee, currency }] : []),
    ],
  }).id;
}
/** Card → wallet (and, when a load is undone, its fee back too). */
function unloadJournal(ctx: Ctx, userId: string, currency: string, amount: number, fee: number, memo: string, metadata: Record<string, unknown>) {
  return postJournal(ctx, {
    kind: "card_unload",
    initiatorId: userId,
    memo,
    metadata,
    postings: [
      { accountId: systemAccount(ctx, "card_funding", currency).id, amount: -amount, currency },
      ...(fee ? [{ accountId: systemAccount(ctx, "fees", currency).id, amount: -fee, currency }] : []),
      { accountId: userAccount(ctx, userId, currency).id, amount: amount + fee, currency },
    ],
  }).id;
}

async function applyForPrepaidCard(ctx: Ctx, userId: string, input: CardApplication, ip?: string) {
  if (one(ctx.db, "SELECT 1 FROM card_applications WHERE user_id = ? AND status IN ('kyc_pending','creating')", userId)) {
    throw unprocessable("card_pending", "Your card is on its way: the card issuer is still checking your details.");
  }
  const identity = approvedIdentity(ctx, userId);
  if (!identity) throw unprocessable("identity_needed", "Verify your identity first (Account → Verification): the card issuer checks the same details.");
  const country = input.country.toUpperCase();
  const place = bitnob.countryInfo(country);
  if (!place) throw badRequest("This card issuer doesn't serve that country yet");
  const phone = bitnob.splitPhone(input.phone || identity.phone || "", country);
  if (!phone?.phone || phone.phone.length < 6) throw badRequest("Enter your mobile number with its country code, e.g. +254 712 345 678");
  if (!input.state?.trim() || !input.postalCode?.trim()) throw badRequest("Enter your county or state, and your postcode");
  if (!input.occupation || !input.employmentStatus || !input.yearlyIncomeUsd || !input.monthlySpendUsd) {
    throw badRequest("The card issuer asks for your occupation, work and income: please fill them in");
  }
  if (input.yearlyIncomeUsd < input.monthlySpendUsd) throw badRequest("Your yearly income can't be less than what you expect to spend in a month");
  const currency = "USD";
  const opening = toMinor(input.openingAmount ?? "2", currency);
  if (opening < MIN_LOAD || opening > MAX_LOAD) throw badRequest(`Load between ${usd(MIN_LOAD)} and ${usd(MAX_LOAD)} to start`);
  const fee = (issuerFees(ctx)?.issue ?? 0) + loadFee(ctx, opening);
  await checkLimits(ctx, userId, currency, opening + fee);

  const id = newId("capp");
  const now = nowIso();
  try {
    tx(ctx.db, () => {
      const journalId = loadJournal(ctx, userId, currency, opening, fee, "Your new Aurex card", { applicationId: id, fee });
      run(
        ctx.db,
        `INSERT INTO card_applications (id, user_id, provider, status, name, design, currency, opening, fee, journal_id, created_at, updated_at)
         VALUES (?, ?, 'bitnob', 'kyc_pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, userId, input.name.trim(), input.design ?? "gold", currency, opening, fee, journalId, now, now,
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw unprocessable("insufficient_funds", `You need ${usd(opening + fee)} in your USD wallet: ${usd(opening)} to put on the card${fee ? ` and ${usd(fee)} in card fees` : ""}.`);
    }
    throw err;
  }
  audit(ctx, userId, "card.applied", { application: id, provider: "bitnob" }, ip);

  try {
    // A customer the issuer has already approved keeps their customer record for a replacement card.
    let customerId = one<{ customer_id: string }>(ctx.db, "SELECT customer_id FROM card_applications WHERE user_id = ? AND provider = 'bitnob' AND status = 'done' AND customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", userId)?.customer_id;
    let kyc = "approved";
    if (!customerId) {
      const user = getUserRow(ctx, userId);
      const legal = identity.legalName.trim();
      const space = legal.lastIndexOf(" ");
      const k = await bitnob.submitKyc(
        ctx,
        {
          customer: {
            firstName: space > 0 ? legal.slice(0, space) : legal,
            lastName: space > 0 ? legal.slice(space + 1) : legal,
            dateOfBirth: identity.dateOfBirth,
            idType: bitnob.idTypeFor(identity.idType, identity.idCountry),
            idNumber: identity.idNumber,
            email: user.email,
            phone: phone.phone,
            dialCode: phone.dialCode,
            line1: input.line1,
            line2: input.line2,
            city: input.city,
            state: input.state.trim(),
            postalCode: input.postalCode.trim(),
            country: place.alpha3,
          },
          occupation: input.occupation,
          employmentStatus: input.employmentStatus,
          accountPurpose: input.purpose?.trim() || "everyday spending",
          annualSalary: String(Math.round(input.yearlyIncomeUsd)),
          expectedMonthlyVolume: String(Math.round(input.monthlySpendUsd)),
          idFrontImage: identity.idFront,
          idBackImage: identity.idType === "passport" ? null : identity.idBack,
        },
        webhookUrl(ctx),
      );
      customerId = k.customer_id;
      kyc = (k.normalized_status ?? k.status ?? "pending").toLowerCase();
      run(ctx.db, "UPDATE card_applications SET customer_id = ?, link = ?, updated_at = ? WHERE id = ?", customerId, k.verification_link ?? k.completion_link ?? null, nowIso(), id);
    } else {
      run(ctx.db, "UPDATE card_applications SET customer_id = ?, updated_at = ? WHERE id = ?", customerId, nowIso(), id);
    }
    if (kyc === "approved") await createPrepaidCard(ctx, id);
    else if (kyc === "rejected") failApplication(ctx, id, "The card issuer couldn't verify your details.");
  } catch (err) {
    failApplication(ctx, id, (err as Error).message);
    throw err;
  }
  return cardOverview(ctx, userId);
}

const getApp = (ctx: Ctx, id: string) => one<AppRow>(ctx.db, "SELECT * FROM card_applications WHERE id = ?", id);

/** Asks the issuer for the card, loaded with the opening amount. It usually arrives by webhook a moment later. */
async function createPrepaidCard(ctx: Ctx, appId: string) {
  const app = getApp(ctx, appId);
  if (!app || app.status !== "kyc_pending" || !app.customer_id) return;
  run(ctx.db, "UPDATE card_applications SET status = 'creating', updated_at = ? WHERE id = ?", nowIso(), app.id);
  const card = await bitnob.createCard(ctx, { customerId: app.customer_id, amountCents: app.opening, reference: app.id, name: app.name, webhookUrl: webhookUrl(ctx) });
  run(ctx.db, "UPDATE card_applications SET provider_card_id = ?, updated_at = ? WHERE id = ?", card.id, nowIso(), app.id);
  if (card.status === "active" || card.created_status === "completed") finishApplication(ctx, app.id, { id: card.id, brand: card.card_brand, last4: card.last_four_digit });
}

function finishApplication(ctx: Ctx, appId: string, card: { id: string; brand?: string | null; last4?: string | null }) {
  const app = getApp(ctx, appId);
  if (!app || app.status === "done" || app.status === "failed") return;
  const id = newId("card");
  const now = nowIso();
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1).toLowerCase() : null;
  tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO cards (id, user_id, provider, provider_card_id, provider_cardholder_id, brand, last4, exp_month, exp_year, currency, status, design, balance, created_at, updated_at)
       VALUES (?, ?, 'bitnob', ?, ?, ?, ?, NULL, NULL, ?, 'active', ?, ?, ?, ?)`,
      id, app.user_id, card.id, app.customer_id ?? "", brand, card.last4 ?? null, app.currency, app.design, app.opening, now, now,
    );
    run(ctx.db, "UPDATE card_applications SET status = 'done', card_id = ?, provider_card_id = ?, updated_at = ? WHERE id = ?", id, card.id, now, app.id);
  });
  addAlert(ctx, app.user_id, "card", `Your Aurex card${card.last4 ? ` ending ${card.last4}` : ""} is ready, with ${usd(app.opening)} on it.`);
  void notify(ctx, app.user_id, { category: "payments", title: "Your Aurex card is ready", message: `${usd(app.opening)} is on it. Add it to your phone's wallet to tap and pay.`, path: "/app/card", tags: ["credit_card"] });
}

/** The application didn't go through: everything taken from the wallet goes back. */
function failApplication(ctx: Ctx, appId: string, reason: string) {
  const app = getApp(ctx, appId);
  if (!app || app.status === "done" || app.status === "failed") return;
  tx(ctx.db, () => {
    if (app.journal_id) unloadJournal(ctx, app.user_id, app.currency, app.opening, app.fee, "Card application returned", { applicationId: app.id });
    run(ctx.db, "UPDATE card_applications SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?", reason.slice(0, 300), nowIso(), app.id);
  });
  void notify(ctx, app.user_id, { category: "payments", title: "Card application", message: `We couldn't get your card: ${reason} The money is back in your wallet.`, path: "/app/card", tags: ["warning"] });
}

const pendingFundingOn = (ctx: Ctx, cardId: string) => one(ctx.db, "SELECT 1 FROM card_fundings WHERE card_id = ? AND status = 'pending'", cardId);

/** Puts money from the wallet onto the card. */
export async function loadCard(ctx: Ctx, userId: string, cardId: string, amount: number, ip?: string) {
  const c = ownCard(ctx, userId, cardId);
  if (!isPrefunded(c)) throw unprocessable("not_prefunded", "This card spends straight from your wallet: there's nothing to load.");
  if (c.status !== "active") throw unprocessable("card_inactive", c.status === "frozen" ? "Unfreeze the card first" : "This card is cancelled");
  const reasons = blockers(ctx, userId);
  if (reasons.length) throw unprocessable("card_not_allowed", reasons.join(" "));
  if (amount < MIN_LOAD || amount > MAX_LOAD) throw badRequest(`Load between ${usd(MIN_LOAD)} and ${usd(MAX_LOAD)} at a time`);
  if (pendingFundingOn(ctx, c.id)) throw unprocessable("card_busy", "Money is still moving on this card. Try again in a couple of minutes.");
  const fee = loadFee(ctx, amount);
  await checkLimits(ctx, userId, c.currency, amount + fee);
  const id = newId("cfund");
  const now = nowIso();
  try {
    tx(ctx.db, () => {
      const journalId = loadJournal(ctx, userId, c.currency, amount, fee, `Loaded onto card ${c.last4 ?? ""}`.trim(), { cardId: c.id, fundingId: id, fee });
      run(
        ctx.db,
        "INSERT INTO card_fundings (id, card_id, user_id, type, currency, amount, fee, status, journal_id, created_at, updated_at) VALUES (?, ?, ?, 'fund', ?, ?, ?, 'pending', ?, ?, ?)",
        id, c.id, userId, c.currency, amount, fee, journalId, now, now,
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw unprocessable("insufficient_funds", `You need ${usd(amount + fee)} in your wallet${fee ? ` (including the ${usd(fee)} fee)` : ""}.`);
    throw err;
  }
  try {
    const t = await bitnob.moveBalance(ctx, c.provider_card_id, "fund", amount, id);
    settleFunding(ctx, id, t.status);
  } catch (err) {
    finishFunding(ctx, id, "failed", (err as Error).message);
    throw err;
  }
  audit(ctx, userId, "card.loaded", { card: c.id, amount }, ip);
  return cardOverview(ctx, userId);
}

/** Moves money from the card back to the wallet. */
export async function unloadCard(ctx: Ctx, userId: string, cardId: string, amount: number, ip?: string) {
  const c = ownCard(ctx, userId, cardId);
  if (!isPrefunded(c)) throw unprocessable("not_prefunded", "This card spends straight from your wallet: there's nothing on it to move.");
  if (c.status === "canceled") throw unprocessable("card_canceled", "This card is cancelled");
  const max = Math.max(0, (c.balance ?? 0) - 100);
  if (amount <= 0) throw badRequest("Enter an amount");
  if (amount > max) throw badRequest(max > 0 ? `You can move up to ${usd(max)}: the card keeps at least $1.00` : "The card keeps at least $1.00, so there's nothing to move yet");
  if (pendingFundingOn(ctx, c.id)) throw unprocessable("card_busy", "Money is still moving on this card. Try again in a couple of minutes.");
  const id = newId("cfund");
  const now = nowIso();
  run(ctx.db, "INSERT INTO card_fundings (id, card_id, user_id, type, currency, amount, fee, status, created_at, updated_at) VALUES (?, ?, ?, 'withdraw', ?, ?, 0, 'pending', ?, ?)", id, c.id, userId, c.currency, amount, now, now);
  try {
    const t = await bitnob.moveBalance(ctx, c.provider_card_id, "withdraw", amount, id);
    settleFunding(ctx, id, t.status);
  } catch (err) {
    finishFunding(ctx, id, "failed", (err as Error).message);
    throw err;
  }
  audit(ctx, userId, "card.unloaded", { card: c.id, amount }, ip);
  return cardOverview(ctx, userId);
}

function settleFunding(ctx: Ctx, id: string, status: string | undefined) {
  const s = (status ?? "").toLowerCase();
  if (s === "completed") finishFunding(ctx, id, "completed");
  else if (s === "failed" || s === "declined" || s === "reversed") finishFunding(ctx, id, "failed", `The card issuer reported it ${s}.`);
  // pending / processing: the issuer's webhook finishes it.
}

/** A load or withdrawal is done (or didn't happen): the books follow. Safe to call twice. */
export function finishFunding(ctx: Ctx, fundingId: string, outcome: "completed" | "failed", reason?: string) {
  const f = one<FundingRow>(ctx.db, "SELECT * FROM card_fundings WHERE id = ?", fundingId);
  if (!f || f.status !== "pending") return;
  tx(ctx.db, () => {
    if (f.type === "fund") {
      if (outcome === "completed") run(ctx.db, "UPDATE cards SET balance = COALESCE(balance, 0) + ?, updated_at = ? WHERE id = ?", f.amount, nowIso(), f.card_id);
      else unloadJournal(ctx, f.user_id, f.currency, f.amount, f.fee, "Card load returned", { cardId: f.card_id, fundingId: f.id });
    } else if (outcome === "completed") {
      unloadJournal(ctx, f.user_id, f.currency, f.amount, 0, "Moved back from your card", { cardId: f.card_id, fundingId: f.id });
      run(ctx.db, "UPDATE cards SET balance = COALESCE(balance, 0) - ?, updated_at = ? WHERE id = ?", f.amount, nowIso(), f.card_id);
    }
    run(ctx.db, "UPDATE card_fundings SET status = ?, reason = ?, updated_at = ? WHERE id = ?", outcome, reason?.slice(0, 300) ?? null, nowIso(), f.id);
  });
  if (outcome === "failed") {
    void notify(ctx, f.user_id, {
      category: "payments",
      title: f.type === "fund" ? "Card load didn't go through" : "Couldn't move money from your card",
      message: f.type === "fund" ? `${usd(f.amount)} is back in your wallet.` : `${usd(f.amount)} is still on your card.`,
      path: "/app/card",
      tags: ["warning"],
    });
  }
}

/** The card is closed: whatever was on it comes back to the wallet. */
function closePrepaidCard(ctx: Ctx, cardId: string, why: string) {
  tx(ctx.db, () => {
    const c = one<CardRow>(ctx.db, "SELECT * FROM cards WHERE id = ?", cardId);
    if (!c || c.status === "canceled") return;
    if ((c.balance ?? 0) > 0) unloadJournal(ctx, c.user_id, c.currency, c.balance!, 0, `${why}: card balance returned`, { cardId: c.id });
    run(ctx.db, "UPDATE cards SET status = 'canceled', balance = 0, updated_at = ? WHERE id = ?", nowIso(), c.id);
  });
}

/**
 * Brings the card's balance in line with the issuer's: money spent at shops (or fees the issuer took
 * from the card) moves to card_settlement, refunds come back. Skipped while a load or withdrawal is in
 * flight, since the two sides could briefly disagree about it.
 */
export async function syncPrepaidCard(ctx: Ctx, cardId: string, merchant?: string | null) {
  const before = one<CardRow>(ctx.db, "SELECT * FROM cards WHERE id = ?", cardId);
  if (!before || !isPrefunded(before) || before.status === "canceled" || pendingFundingOn(ctx, cardId)) return;
  const remote = await bitnob.getCard(ctx, before.provider_card_id);
  const status = (remote.status ?? "").toLowerCase();
  if (status === "terminated" || status === "blocked" || status === "pending_termination") {
    // The issuer closed the card (for example after too many declines) and swept its balance back.
    closePrepaidCard(ctx, cardId, "Card closed by the issuer");
    addAlert(ctx, before.user_id, "card", `Your card ending ${before.last4} was closed by the card issuer. What was on it is back in your wallet.`);
    return;
  }
  const issuer = bitnob.fromMicro(remote.balance_amount);
  tx(ctx.db, () => {
    const c = one<CardRow>(ctx.db, "SELECT * FROM cards WHERE id = ?", cardId)!;
    const delta = (c.balance ?? 0) - issuer;
    if (delta !== 0) {
      postJournal(ctx, {
        kind: delta > 0 ? "card_capture" : "card_refund",
        initiatorId: c.user_id,
        memo: `Card · ${merchant ?? (delta > 0 ? "payments" : "refund")}`,
        metadata: { cardId: c.id, prepaid: true, issuerBalance: issuer },
        postings: [
          { accountId: systemAccount(ctx, "card_funding", c.currency).id, amount: -delta, currency: c.currency },
          { accountId: systemAccount(ctx, "card_settlement", c.currency).id, amount: delta, currency: c.currency },
        ],
      });
    }
    const local = status === "frozen" ? "frozen" : status === "active" ? "active" : c.status;
    run(ctx.db, "UPDATE cards SET balance = ?, status = ?, last4 = COALESCE(last4, ?), updated_at = ? WHERE id = ?", issuer, local, remote.last_four_digit ?? null, nowIso(), c.id);
  });
}

async function syncPrepaidCards(ctx: Ctx) {
  for (const c of all<{ id: string }>(ctx.db, "SELECT id FROM cards WHERE provider = 'bitnob' AND status <> 'canceled'")) {
    await syncPrepaidCard(ctx, c.id).catch((err) => console.error(`[cards] sync ${c.id}: ${(err as Error).message}`));
  }
}

/** One of Bitnob's `virtualcard.transaction.*` events: shown in the card's activity, then the balance is checked. */
async function recordPrepaidTransaction(ctx: Ctx, event: string, d: Record<string, unknown>) {
  const card = findCard(ctx, String(d.cardId ?? ""));
  if (!card || !isPrefunded(card)) return;
  const type = String(d.transaction_type ?? "").toLowerCase();
  const amount = Math.abs(bitnob.fromMicro(d.amount as number));
  const merchant = typeof d.merchant_name === "string" && d.merchant_name ? d.merchant_name : null;
  const id = `bn_${String(d.id ?? newId("tx"))}`;
  const now = nowIso();
  const insert = (status: AuthRow["status"], approved: boolean, reason: string | null) =>
    run(
      ctx.db,
      `INSERT OR IGNORE INTO card_authorizations (id, card_id, user_id, currency, amount, held, merchant_name, merchant_city, merchant_country, merchant_category, wallet, approved, decline_reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      id, card.id, card.user_id, card.currency, amount, merchant, typeof d.merchant_country === "string" ? d.merchant_country : null,
      typeof d.merchant_mcc === "string" ? d.merchant_mcc : null, approved ? 1 : 0, reason, status, now, now,
    );
  // The settlement (or reversal) of an earlier authorisation: same card, shop and amount.
  const pendingMatch = () =>
    one<{ id: string }>(ctx.db, "SELECT id FROM card_authorizations WHERE card_id = ? AND status = 'pending' AND amount = ? AND COALESCE(merchant_name, '') = ? ORDER BY created_at LIMIT 1", card.id, amount, merchant ?? "");

  if (event === "virtualcard.transaction.declined" || type === "authorization_declined" || d.status === "decline") {
    const reason = typeof d.reason === "string" && d.reason ? d.reason : "Declined by the card issuer";
    insert("declined", false, reason);
    void notify(ctx, card.user_id, { category: "payments", title: "Card payment declined", message: `${usd(amount)} at ${merchant ?? "a shop"}: ${reason}.`, path: "/app/card", tags: ["no_entry"], priority: 4 });
  } else if (["authorization", "pre_auth_approved", "contactless_pending", "cross_border_pending"].includes(type)) {
    insert("pending", true, null);
  } else if (["settlement", "contactless_settled", "cross_border_settled"].includes(type)) {
    const match = pendingMatch();
    if (match) run(ctx.db, "UPDATE card_authorizations SET status = 'closed', updated_at = ? WHERE id = ?", now, match.id);
    else insert("closed", true, null);
    void notify(ctx, card.user_id, { category: "payments", title: "Card payment", message: `${usd(amount)} at ${merchant ?? "a shop"}.`, path: "/app/card", tags: ["credit_card"] });
  } else if (["reversal", "reversal_settled", "cross_border_reversal"].includes(type)) {
    const match = pendingMatch();
    if (match) run(ctx.db, "UPDATE card_authorizations SET status = 'reversed', updated_at = ? WHERE id = ?", now, match.id);
  } else if (type === "refund_settled") {
    insert("reversed", true, null);
    void notify(ctx, card.user_id, { category: "payments", title: "Card refund", message: `${usd(amount)} from ${merchant ?? "a shop"} is back on your card.`, path: "/app/card", tags: ["moneybag"] });
  }
  await syncPrepaidCard(ctx, card.id, merchant);
}

export interface BitnobEvent {
  event?: string;
  event_id?: string;
  data?: Record<string, unknown>;
}

/** Bitnob's card webhooks (signature already checked). Each event is handled once. */
export async function handleBitnobEvent(ctx: Ctx, e: BitnobEvent) {
  const eventId = e.event_id ?? null;
  if (eventId && one(ctx.db, "SELECT 1 FROM card_issuer_events WHERE id = ?", eventId)) return;
  const d = e.data ?? {};
  const appByRef = () => (typeof d.reference === "string" ? getApp(ctx, d.reference) : undefined);
  switch (e.event) {
    case "virtualcard.user.kyc.complete":
    case "virtualcard.user.kyc.failed": {
      const customerId = String(d.customerId ?? d.id ?? "");
      const passed = e.event === "virtualcard.user.kyc.complete" && d.kycPassed !== false;
      for (const app of all<AppRow>(ctx.db, "SELECT * FROM card_applications WHERE customer_id = ? AND status = 'kyc_pending'", customerId)) {
        if (passed) await createPrepaidCard(ctx, app.id).catch((err) => failApplication(ctx, app.id, (err as Error).message));
        else failApplication(ctx, app.id, `The card issuer couldn't verify your details${typeof d.reason === "string" && d.reason ? ` (${d.reason})` : ""}.`);
      }
      break;
    }
    case "virtualcard.created.completed": {
      const app = appByRef();
      if (app) {
        let last4 = typeof d.lastFour === "string" ? d.lastFour : null;
        let brand = typeof d.cardBrand === "string" ? d.cardBrand : null;
        if (!last4) {
          const card = await bitnob.getCard(ctx, String(d.id)).catch(() => null);
          last4 = card?.last_four_digit ?? null;
          brand ??= card?.card_brand ?? null;
        }
        finishApplication(ctx, app.id, { id: String(d.id), brand, last4 });
      }
      break;
    }
    case "virtualcard.created.failed": {
      const app = appByRef();
      if (app) failApplication(ctx, app.id, `The card couldn't be created${typeof d.failureReason === "string" && d.failureReason ? `: ${d.failureReason}` : ""}.`);
      break;
    }
    case "virtualcard.topup.completed":
    case "virtualcard.withdrawal.completed":
      if (typeof d.reference === "string") finishFunding(ctx, d.reference, "completed");
      break;
    case "virtualcard.topup.failed":
    case "virtualcard.withdrawal.failed":
      if (typeof d.reference === "string") finishFunding(ctx, d.reference, "failed", typeof d.reason === "string" ? d.reason : undefined);
      break;
    case "virtualcard.terminated.refund": {
      const card = findCard(ctx, String(d.cardId ?? ""));
      if (card && isPrefunded(card)) closePrepaidCard(ctx, card.id, "Card closed");
      break;
    }
    case "virtualcard.tokenization": {
      // The card was added to Apple Pay or Google Pay: the customer always hears about it.
      const card = findCard(ctx, String(d.cardId ?? ""));
      if (card) addAlert(ctx, card.user_id, "card_wallet", `Your Aurex card ending ${card.last4} was added to a phone wallet. If this wasn't you, freeze the card in Aurex now.`);
      break;
    }
    default:
      if (e.event?.startsWith("virtualcard.transaction.")) await recordPrepaidTransaction(ctx, e.event, d);
  }
  if (eventId) run(ctx.db, "INSERT OR IGNORE INTO card_issuer_events (id, type, received_at) VALUES (?, ?, ?)", eventId, e.event ?? "", nowIso());
}

/** The issuer's occupation list for the card application. */
export async function cardOccupations(ctx: Ctx) {
  if (ctx.config.cardIssuer !== "bitnob") return [];
  return bitnob.occupations(ctx);
}
