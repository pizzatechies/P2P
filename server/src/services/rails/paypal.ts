import { HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import { providerMessage, railFetch, railJson, tokenCache } from "./http.js";
import type { PaymentRail } from "./types.js";

/**
 * PayPal and Venmo.
 * - Deposits: Orders v2. The user approves on PayPal, comes back, and Aurex captures the order. The
 *   capture's amount and currency are checked before the wallet is credited.
 * - Payouts: the Payouts API to a PayPal account (email or phone) or a Venmo account (US, USD).
 * Webhooks only trigger a re-check through the API.
 * Docs: https://developer.paypal.com/docs/api/orders/v2/ and https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
 */
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "MXN"];

interface Capture {
  status?: string;
  amount?: { currency_code?: string; value?: string };
}
interface Order {
  id?: string;
  status?: string;
  links?: { rel?: string; href?: string }[];
  purchase_units?: { reference_id?: string; custom_id?: string; payments?: { captures?: Capture[] } }[];
}

export function paypalRail(opts: { baseUrl: string; sandbox: boolean; clientId: string; clientSecret: string; appUrl: string }): PaymentRail {
  const token = tokenCache(async () => {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const res = await railJson<{ access_token?: string; expires_in?: number }>("PayPal", `${opts.baseUrl}/v1/oauth2/token`, {
      headers: { Authorization: `Basic ${basic}` },
      form: { grant_type: "client_credentials" },
    });
    if (!res.access_token) throw new HttpError(502, "rail_error", "PayPal didn't return an access token");
    return { token: res.access_token, expiresIn: Number(res.expires_in ?? 3600) };
  });
  const auth = async (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${await token()}`, ...extra });

  function judge(order: Order, externalId: string, currency: string, amount: number): "completed" | "pending" | "failed" {
    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (!capture) return order.status === "VOIDED" ? "failed" : "pending";
    if (capture.status === "PENDING") return "pending";
    if (capture.status !== "COMPLETED") return "failed";
    if ((unit?.custom_id ?? unit?.reference_id) !== externalId) return "failed";
    const expected = Number(fromMinor(amount, currency));
    return capture.amount?.currency_code === currency && Number(capture.amount.value) >= expected ? "completed" : "failed";
  }

  return {
    id: "paypal",
    name: "PayPal",
    description: "Pay with your PayPal balance, bank or card. Withdraw to PayPal or Venmo.",
    simulated: opts.sandbox,
    supportsDeposit: true,
    supportsWithdrawal: true,
    currencies: CURRENCIES,
    depositInput: "none",
    payoutInput: "email",
    walletOptions: ["paypal", "venmo"],

    async createDeposit(input) {
      const back = (state: string) => {
        const u = new URL("/app/wallet", opts.appUrl);
        u.searchParams.set("deposit", state);
        u.searchParams.set("ref", input.externalId);
        return u.toString();
      };
      const order = await railJson<Order>("PayPal", `${opts.baseUrl}/v2/checkout/orders`, {
        headers: await auth({ "PayPal-Request-Id": `order-${input.externalId}` }),
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: input.externalId,
              custom_id: input.externalId,
              description: "Aurex wallet top-up",
              amount: { currency_code: input.currency, value: fromMinor(input.amount, input.currency) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "Aurex",
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                return_url: back("return"),
                cancel_url: back("canceled"),
              },
            },
          },
        },
      });
      const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
      if (!order.id || !link) throw new HttpError(502, "rail_error", "PayPal didn't return an approval link");
      return { status: "pending", providerRef: order.id, redirectUrl: link };
    },

    async checkDeposit({ externalId, providerRef, currency, amount }) {
      if (!providerRef) return "pending";
      const url = `${opts.baseUrl}/v2/checkout/orders/${encodeURIComponent(providerRef)}`;
      const got = await railFetch<Order>("PayPal", url, { headers: await auth() }).catch(() => null);
      if (!got) return "pending";
      if (got.status === 404) return "failed"; // expired before approval
      if (!got.ok) return "pending";
      let order = got.json;
      if (order.status === "APPROVED") {
        // The buyer approved: capture now. PayPal-Request-Id makes a repeated capture harmless.
        const cap = await railFetch<Order>("PayPal", `${url}/capture`, {
          headers: await auth({ "PayPal-Request-Id": `capture-${externalId}` }),
          body: {},
        });
        if (cap.ok) order = cap.json;
        else {
          const again = await railFetch<Order>("PayPal", url, { headers: await auth() });
          if (!again.ok) return "pending";
          order = again.json;
          if (order.status === "APPROVED") {
            const msg = providerMessage(cap.json) ?? "";
            return /DECLINED|INSTRUMENT/i.test(JSON.stringify(cap.json)) || /declined/i.test(msg) ? "failed" : "pending";
          }
        }
      }
      if (order.status === "COMPLETED" || order.status === "VOIDED") return judge(order, externalId, currency, amount);
      return "pending";
    },

    async createPayout(input) {
      const d = input.destination;
      const receiver = (d.email ?? d.accountNumber ?? "").trim();
      const venmo = d.wallet === "venmo";
      if (!receiver) return { status: "failed", failureReason: "Enter the PayPal or Venmo email or phone number" };
      if (venmo && input.currency !== "USD") return { status: "failed", failureReason: "Venmo payouts are only available in USD" };
      const isEmail = receiver.includes("@");
      const res = await railFetch<{ batch_header?: { payout_batch_id?: string; batch_status?: string } }>("PayPal", `${opts.baseUrl}/v1/payments/payouts`, {
        headers: await auth(),
        body: {
          sender_batch_header: {
            sender_batch_id: input.externalId,
            email_subject: "You have a payment from Aurex",
            email_message: "Your Aurex withdrawal has been sent.",
          },
          items: [
            {
              recipient_type: isEmail ? "EMAIL" : "PHONE",
              receiver: isEmail ? receiver : receiver.replace(/[^\d+]/g, ""),
              amount: { value: fromMinor(input.amount, input.currency), currency: input.currency },
              note: "Aurex withdrawal",
              sender_item_id: input.externalId,
              recipient_wallet: venmo ? "VENMO" : "PAYPAL",
            },
          ],
        },
      });
      const batch = res.json.batch_header;
      if (!res.ok || !batch?.payout_batch_id) return { status: "failed", failureReason: `PayPal: ${providerMessage(res.json) ?? `HTTP ${res.status}`}` };
      if (batch.batch_status === "DENIED") return { status: "failed", providerRef: batch.payout_batch_id, failureReason: "PayPal denied the payout" };
      return { status: "pending", providerRef: batch.payout_batch_id };
    },

    async checkPayout({ providerRef }) {
      if (!providerRef) return "pending";
      const res = await railFetch<{ batch_header?: { batch_status?: string }; items?: { transaction_status?: string }[] }>(
        "PayPal",
        `${opts.baseUrl}/v1/payments/payouts/${encodeURIComponent(providerRef)}`,
        { headers: await auth() },
      ).catch(() => null);
      if (!res?.ok) return "pending";
      if (res.json.batch_header?.batch_status === "DENIED") return "failed";
      const s = res.json.items?.[0]?.transaction_status;
      if (s === "SUCCESS") return "completed";
      if (s && ["FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED", "DENIED"].includes(s)) return "failed";
      return "pending"; // PENDING, UNCLAIMED (PayPal returns it after 30 days), ONHOLD, NEW
    },
  };
}
