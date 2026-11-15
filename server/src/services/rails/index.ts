import { createHmac } from "node:crypto";
import type { Ctx } from "../../context.js";
import { badRequest } from "../../lib/errors.js";
import { CURRENCIES } from "../../lib/money.js";
import { flutterwaveRail } from "./flutterwave.js";
import { moneygramRail } from "./moneygram.js";
import { mpesaRail } from "./mpesa.js";
import { mtnMomoRail } from "./mtnmomo.js";
import { paypalRail } from "./paypal.js";
import { sandboxRail } from "./sandbox.js";
import { skrillRail } from "./skrill.js";
import { stripeRail } from "./stripe.js";
import { wiseRail } from "./wise.js";
import type { PaymentRail } from "./types.js";

export type { PaymentRail } from "./types.js";

const registries = new WeakMap<Ctx["config"], Map<string, PaymentRail>>();

export function getRails(ctx: Ctx): Map<string, PaymentRail> {
  let rails = registries.get(ctx.config);
  if (rails) return rails;
  rails = new Map();
  const c = ctx.config;
  for (const id of c.rails) {
    if (id === "sandbox") rails.set(id, sandboxRail);
    else if (id === "stripe" && ctx.config.STRIPE_SECRET_KEY) {
      rails.set(id, stripeRail({ secretKey: ctx.config.STRIPE_SECRET_KEY, appUrl: ctx.config.APP_URL }));
    } else if (id === "flutterwave" && ctx.config.FLUTTERWAVE_SECRET_KEY) {
      rails.set(id, flutterwaveRail({ secretKey: ctx.config.FLUTTERWAVE_SECRET_KEY, appUrl: ctx.config.APP_URL, baseUrl: ctx.config.FLUTTERWAVE_BASE_URL }));
    } else if (id === "mpesa" && c.MPESA_CONSUMER_KEY && c.MPESA_CONSUMER_SECRET) {
      rails.set(
        id,
        mpesaRail({
          baseUrl: c.MPESA_BASE_URL ?? (c.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke"),
          sandbox: c.MPESA_ENV !== "production",
          consumerKey: c.MPESA_CONSUMER_KEY,
          consumerSecret: c.MPESA_CONSUMER_SECRET,
          shortcode: c.MPESA_SHORTCODE,
          passkey: c.MPESA_PASSKEY,
          transactionType: c.MPESA_TRANSACTION_TYPE,
          partyB: c.MPESA_PARTY_B,
          b2cShortcode: c.MPESA_B2C_SHORTCODE,
          initiatorName: c.MPESA_INITIATOR_NAME,
          securityCredential: c.MPESA_SECURITY_CREDENTIAL,
          callbackBase: new URL(`/api/webhooks/mpesa/${mpesaCallbackToken(ctx)}`, c.APP_URL).toString(),
        }),
      );
    } else if (id === "mtn-momo" && (c.MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY || c.MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY)) {
      const keys = (sub?: string, user?: string, key?: string) => (sub && user && key ? { subscriptionKey: sub, userId: user, apiKey: key } : undefined);
      const currency = c.MTN_MOMO_CURRENCY.toUpperCase();
      if (!CURRENCIES[currency]) console.warn(`[rails] MTN MoMo currency ${currency} isn't one Aurex holds; the rail will refuse every amount`);
      rails.set(
        id,
        mtnMomoRail({
          baseUrl: c.MTN_MOMO_BASE_URL ?? (c.MTN_MOMO_ENV === "production" ? "https://proxy.momoapi.mtn.com" : "https://sandbox.momodeveloper.mtn.com"),
          sandbox: c.MTN_MOMO_ENV !== "production",
          targetEnvironment: c.MTN_MOMO_TARGET_ENVIRONMENT,
          currency,
          collection: keys(c.MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY, c.MTN_MOMO_COLLECTION_USER_ID, c.MTN_MOMO_COLLECTION_API_KEY),
          disbursement: keys(c.MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY, c.MTN_MOMO_DISBURSEMENT_USER_ID, c.MTN_MOMO_DISBURSEMENT_API_KEY),
          callbackUrl: new URL("/api/webhooks/mtn-momo", c.APP_URL).toString(),
        }),
      );
    } else if (id === "paypal" && c.PAYPAL_CLIENT_ID && c.PAYPAL_CLIENT_SECRET) {
      rails.set(
        id,
        paypalRail({
          baseUrl: c.PAYPAL_BASE_URL ?? (c.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"),
          sandbox: c.PAYPAL_ENV !== "live",
          clientId: c.PAYPAL_CLIENT_ID,
          clientSecret: c.PAYPAL_CLIENT_SECRET,
          appUrl: c.APP_URL,
        }),
      );
    } else if (id === "wise" && c.WISE_API_TOKEN && c.WISE_PROFILE_ID) {
      rails.set(
        id,
        wiseRail({
          baseUrl: c.WISE_BASE_URL ?? (c.WISE_ENV === "production" ? "https://api.wise.com/2026Q4" : "https://api.wise-sandbox.com/2026Q4"),
          sandbox: c.WISE_ENV !== "production",
          token: c.WISE_API_TOKEN,
          profileId: c.WISE_PROFILE_ID,
          fundingCurrency: c.WISE_FUNDING_CURRENCY.toUpperCase(),
        }),
      );
    } else if (id === "skrill" && c.SKRILL_EMAIL && c.SKRILL_SECRET_WORD) {
      rails.set(
        id,
        skrillRail({
          email: c.SKRILL_EMAIL,
          secretWord: c.SKRILL_SECRET_WORD,
          apiPassword: c.SKRILL_API_PASSWORD,
          payUrl: c.SKRILL_PAY_URL,
          apiUrl: c.SKRILL_API_URL,
          appUrl: c.APP_URL,
        }),
      );
    } else if (id === "moneygram" && c.MONEYGRAM_CLIENT_ID && c.MONEYGRAM_CLIENT_SECRET && c.MONEYGRAM_PARTNER_ID) {
      rails.set(
        id,
        moneygramRail({
          baseUrl: c.MONEYGRAM_BASE_URL ?? (c.MONEYGRAM_ENV === "production" ? "https://api.moneygram.com" : "https://sandboxapi.moneygram.com"),
          sandbox: c.MONEYGRAM_ENV !== "production",
          clientId: c.MONEYGRAM_CLIENT_ID,
          clientSecret: c.MONEYGRAM_CLIENT_SECRET,
          partnerId: c.MONEYGRAM_PARTNER_ID,
          sendCurrencies: c.MONEYGRAM_SEND_CURRENCIES.split(",").map((x) => x.trim().toUpperCase()).filter((x) => CURRENCIES[x]),
        }),
      );
    } else console.warn(`[rails] unknown or unconfigured payment rail "${id}" ignored`);
  }
  registries.set(ctx.config, rails);
  return rails;
}

export function getRail(ctx: Ctx, id: string, purpose: "deposit" | "withdrawal", currency: string): PaymentRail {
  const rail = getRails(ctx).get(id);
  if (!rail) throw badRequest(`Payment method "${id}" is not available`);
  if (purpose === "deposit" && !rail.supportsDeposit) throw badRequest(`${rail.name} can't be used to add money`);
  if (purpose === "withdrawal" && !rail.supportsWithdrawal) throw badRequest(`${rail.name} can't be used to withdraw`);
  if (rail.currencies !== "*" && !rail.currencies.includes(currency)) {
    throw badRequest(`${rail.name} doesn't support ${currency}`);
  }
  return rail;
}

export function describeRails(ctx: Ctx) {
  return [...getRails(ctx).values()].map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    simulated: r.simulated,
    supportsDeposit: r.supportsDeposit,
    supportsWithdrawal: r.supportsWithdrawal,
    currencies: r.currencies,
    depositInput: r.depositInput ?? "none",
    payoutInput: r.payoutInput ?? "bank",
    phoneHint: r.phoneHint ?? null,
    walletOptions: r.walletOptions ?? null,
    payoutLabel: r.payoutLabel ?? null,
  }));
}

/**
 * Secret path segment for M-Pesa callbacks. Safaricom doesn't sign callbacks, so B2C results (which
 * can't be re-checked through the API) are only accepted on this unguessable URL.
 */
export function mpesaCallbackToken(ctx: Ctx) {
  return createHmac("sha256", ctx.config.masterKey).update("aurex:mpesa-callback").digest("hex").slice(0, 40);
}
