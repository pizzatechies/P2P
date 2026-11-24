import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency, fromMinor } from "../lib/money.js";
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
 */

export const cardsConfigured = (ctx: Ctx) => Boolean(ctx.config.CARD_ISSUING && ctx.config.STRIPE_SECRET_KEY);

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
    createdAt: c.created_at,
  };
}

/** Why this customer can't have a card yet (empty when they can). */
function blockers(ctx: Ctx, userId: string) {
  const u = getUserRow(ctx, userId);
  const out: string[] = [];
  if (u.status !== "active") out.push("Your account is frozen.");
  if (u.kyc_level < ctx.config.CARD_MIN_KYC_LEVEL) out.push(`Verify your identity to level ${ctx.config.CARD_MIN_KYC_LEVEL} (Account → Verification).`);
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
  return {
    available,
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
}

/** Issues the customer's virtual card (one at a time). */
export async function issueCard(ctx: Ctx, userId: string, input: CardApplication, ip?: string) {
  if (!cardsConfigured(ctx)) throw new HttpError(503, "cards_unavailable", "Cards aren't available on this server yet");
  const reasons = blockers(ctx, userId);
  if (reasons.length) throw unprocessable("card_not_allowed", reasons.join(" "));
  if (activeCard(ctx, userId)) throw unprocessable("card_exists", "You already have an Aurex card");
  const user = getUserRow(ctx, userId);
  const currency = assertCurrency(ctx.config.CARD_CURRENCY).code;

  // One cardholder per customer, kept across replacement cards.
  let cardholderId = one<{ provider_cardholder_id: string }>(ctx.db, "SELECT provider_cardholder_id FROM cards WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", userId)?.provider_cardholder_id;
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
  const id = newId("card");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO cards (id, user_id, provider, provider_card_id, provider_cardholder_id, brand, last4, exp_month, exp_year, currency, status, design, created_at, updated_at)
     VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id, userId, card.id, cardholderId, card.brand ?? null, card.last4 ?? null, card.exp_month ?? null, card.exp_year ?? null, currency, input.design ?? "gold", now, now,
  );
  audit(ctx, userId, "card.issued", { card: id }, ip);
  addAlert(ctx, userId, "card", `Your Aurex card ending ${card.last4 ?? ""} is ready. It spends from your ${currency} wallet.`, ip);
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
  // Freezing takes effect here first: Aurex declines every payment on a frozen card even if the
  // provider can't be reached.
  run(ctx.db, "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), c.id);
  try {
    await stripe(ctx, "POST", `/issuing/cards/${encodeURIComponent(c.provider_card_id)}`, { status: status === "frozen" ? "inactive" : status === "active" ? "active" : "canceled" });
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
  if (!ctx.config.STRIPE_PUBLISHABLE_KEY) throw new HttpError(503, "cards_unavailable", "Card details can't be shown yet: STRIPE_PUBLISHABLE_KEY isn't set");
  const key = await stripe<{ secret: string }>(ctx, "POST", "/ephemeral_keys", { issuing_card: c.provider_card_id, nonce }, { "Stripe-Version": ctx.config.STRIPE_API_VERSION });
  audit(ctx, userId, "card.details_shown", { card: c.id }, ip);
  return { ephemeralKeySecret: key.secret, providerCardId: c.provider_card_id, publishableKey: ctx.config.STRIPE_PUBLISHABLE_KEY, apiVersion: ctx.config.STRIPE_API_VERSION };
}

/** Closing an account cancels its card (best effort; payments are declined from now on regardless). */
export async function cancelCardsForUser(ctx: Ctx, userId: string) {
  for (const c of all<CardRow>(ctx.db, "SELECT * FROM cards WHERE user_id = ? AND status <> 'canceled'", userId)) {
    run(ctx.db, "UPDATE cards SET status = 'canceled', updated_at = ? WHERE id = ?", nowIso(), c.id);
    if (cardsConfigured(ctx)) await stripe(ctx, "POST", `/issuing/cards/${encodeURIComponent(c.provider_card_id)}`, { status: "canceled" }).catch(() => undefined);
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
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
