import { createHmac } from "node:crypto";
import { safeEqual } from "../../lib/crypto.js";
import { HttpError } from "../../lib/errors.js";
import type { PaymentRail } from "./types.js";

const STRIPE_API = "https://api.stripe.com/v1";

/** Flattens nested objects into Stripe's form encoding: a[b][c]=v */
function formEncode(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) formEncode(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      formEncode(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

/**
 * Card / wallet deposits through Stripe Checkout. The user is redirected to Stripe's hosted page;
 * the wallet is credited only when the signed `checkout.session.completed` webhook arrives.
 * Use test keys (sk_test_...) until you have the licences and agreements to hold customer funds.
 */
export function stripeRail(opts: { secretKey: string; appUrl: string }): PaymentRail {
  return {
    id: "stripe",
    name: "Card (Stripe)",
    description: "Pay by card, Apple Pay or Google Pay via Stripe Checkout.",
    simulated: opts.secretKey.startsWith("sk_test_"),
    supportsDeposit: true,
    // Payouts to third parties need Stripe Connect; add a Connect-based rail for that.
    supportsWithdrawal: false,
    currencies: ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "INR", "AED", "BRL", "MXN", "ZAR", "KES", "NGN"],
    async createDeposit(input) {
      const body = formEncode({
        mode: "payment",
        client_reference_id: input.externalId,
        customer_email: input.email,
        success_url: `${opts.appUrl}/app/wallet?deposit=success&ref=${input.externalId}`,
        cancel_url: `${opts.appUrl}/app/wallet?deposit=canceled&ref=${input.externalId}`,
        metadata: { external_id: input.externalId, user_id: input.userId },
        payment_intent_data: { metadata: { external_id: input.externalId } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amount,
              product_data: { name: "P2P Hub wallet top-up" },
            },
          },
        ],
      });
      const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `deposit-${input.externalId}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
      if (!res.ok || !json.id || !json.url) {
        throw new HttpError(502, "rail_error", `Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
      }
      return { status: "pending", providerRef: json.id, redirectUrl: json.url };
    },
  };
}

/**
 * Verifies a Stripe-Signature header (t=...,v1=...) against the raw request body.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return signatures.some((sig) => safeEqual(sig, expected));
}
