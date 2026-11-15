import { badRequest, HttpError } from "../../lib/errors.js";
import { kenyanMsisdn, providerMessage, railFetch, railJson, tokenCache } from "./http.js";
import type { PaymentRail } from "./types.js";

/**
 * M-Pesa direct through Safaricom's Daraja API.
 * - Deposits: M-Pesa Express (STK Push). The customer gets a PIN prompt on their phone; the result is
 *   confirmed with the STK Push Query API, so the callback is only a trigger.
 * - Payouts: B2C (v3). Safaricom has no synchronous status lookup for B2C, so the result callback
 *   settles it. That callback URL carries a secret derived from MASTER_KEY, and its
 *   OriginatorConversationID and ConversationID must match the payout Aurex sent.
 * M-Pesa only moves whole shillings.
 * Docs: https://developer.safaricom.co.ke/APIs
 */
export interface MpesaOptions {
  baseUrl: string;
  sandbox: boolean;
  consumerKey: string;
  consumerSecret: string;
  shortcode?: string;
  passkey?: string;
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  partyB?: string;
  b2cShortcode?: string;
  initiatorName?: string;
  securityCredential?: string;
  /** e.g. https://app.example.com/api/webhooks/mpesa/<secret> */
  callbackBase: string;
}

/** YYYYMMDDHHmmss in Nairobi time (UTC+3, no daylight saving), as Daraja expects. */
export function darajaTimestamp(now = Date.now()) {
  return new Date(now + 3 * 3_600_000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function wholeShillings(amountMinor: number) {
  if (amountMinor % 100 !== 0) throw badRequest("M-Pesa only accepts whole shillings");
  return amountMinor / 100;
}

export function mpesaRail(opts: MpesaOptions): PaymentRail {
  const token = tokenCache(async () => {
    const basic = Buffer.from(`${opts.consumerKey}:${opts.consumerSecret}`).toString("base64");
    const res = await railJson<{ access_token?: string; expires_in?: string | number }>(
      "M-Pesa",
      `${opts.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.access_token) throw new HttpError(502, "rail_error", "M-Pesa didn't return an access token");
    return { token: res.access_token, expiresIn: Number(res.expires_in ?? 3599) };
  });
  const auth = async () => ({ Authorization: `Bearer ${await token()}` });
  const stkPassword = (timestamp: string) => Buffer.from(`${opts.shortcode}${opts.passkey}${timestamp}`).toString("base64");
  const canDeposit = Boolean(opts.shortcode && opts.passkey);
  const canPayout = Boolean(opts.initiatorName && opts.securityCredential && (opts.b2cShortcode ?? opts.shortcode));

  return {
    id: "mpesa",
    name: "M-Pesa",
    description: "Pay from M-Pesa with a PIN prompt on your phone, and withdraw straight to M-Pesa.",
    simulated: opts.sandbox,
    supportsDeposit: canDeposit,
    supportsWithdrawal: canPayout,
    currencies: ["KES"],
    depositInput: "phone",
    payoutInput: "phone",
    phoneHint: "07XX XXX XXX",

    async createDeposit(input) {
      const phone = kenyanMsisdn(input.phone);
      if (!phone) throw badRequest("Enter a Safaricom number, e.g. 0712 345 678");
      const amount = wholeShillings(input.amount);
      const timestamp = darajaTimestamp();
      const res = await railFetch<{ CheckoutRequestID?: string; ResponseCode?: string; CustomerMessage?: string }>(
        "M-Pesa",
        `${opts.baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          headers: await auth(),
          body: {
            BusinessShortCode: opts.shortcode,
            Password: stkPassword(timestamp),
            Timestamp: timestamp,
            TransactionType: opts.transactionType,
            Amount: amount,
            PartyA: phone,
            PartyB: opts.partyB ?? opts.shortcode,
            PhoneNumber: phone,
            CallBackURL: `${opts.callbackBase}/stk`,
            AccountReference: "Aurex",
            TransactionDesc: "Wallet top-up",
          },
        },
      );
      if (!res.ok || res.json.ResponseCode !== "0" || !res.json.CheckoutRequestID) {
        throw new HttpError(502, "rail_error", `M-Pesa: ${providerMessage(res.json) ?? `HTTP ${res.status}`}`);
      }
      return {
        status: "pending",
        providerRef: res.json.CheckoutRequestID,
        instructions: "Check your phone and enter your M-Pesa PIN to approve the payment.",
      };
    },

    async checkDeposit({ providerRef }) {
      if (!providerRef) return "pending";
      const timestamp = darajaTimestamp();
      const res = await railFetch<{ ResultCode?: string | number }>("M-Pesa", `${opts.baseUrl}/mpesa/stkpushquery/v1/query`, {
        headers: await auth(),
        body: { BusinessShortCode: opts.shortcode, Password: stkPassword(timestamp), Timestamp: timestamp, CheckoutRequestID: providerRef },
      }).catch(() => null);
      // Errors here usually mean "still being processed" (or a transient outage): ask again later.
      if (!res?.ok || res.json.ResultCode === undefined) return "pending";
      const code = String(res.json.ResultCode);
      if (code === "0") return "completed";
      if (code === "4999") return "pending"; // still under processing
      return "failed"; // 1032 cancelled, 1037 unreachable, 2001 wrong PIN, 1 insufficient funds, ...
    },

    async createPayout(input) {
      const phone = kenyanMsisdn(input.destination.accountNumber);
      if (!phone) return { status: "failed", failureReason: "Enter a Safaricom number, e.g. 0712 345 678" };
      if (input.amount % 100 !== 0) return { status: "failed", failureReason: "M-Pesa only accepts whole shillings" };
      const res = await railFetch<{ ConversationID?: string; ResponseCode?: string }>("M-Pesa", `${opts.baseUrl}/mpesa/b2c/v3/paymentrequest`, {
        headers: await auth(),
        body: {
          OriginatorConversationID: input.externalId,
          InitiatorName: opts.initiatorName,
          SecurityCredential: opts.securityCredential,
          CommandID: "BusinessPayment",
          Amount: input.amount / 100,
          PartyA: opts.b2cShortcode ?? opts.shortcode,
          PartyB: phone,
          Remarks: "Aurex withdrawal",
          QueueTimeOutURL: `${opts.callbackBase}/b2c/timeout`,
          ResultURL: `${opts.callbackBase}/b2c/result`,
          Occassion: "Withdrawal", // sic: Daraja's spelling
        },
      });
      if (!res.ok || res.json.ResponseCode !== "0" || !res.json.ConversationID) {
        return { status: "failed", failureReason: `M-Pesa: ${providerMessage(res.json) ?? `HTTP ${res.status}`}` };
      }
      return { status: "pending", providerRef: res.json.ConversationID };
    },

    // B2C results arrive only by callback (see routes/webhooks.ts); there is nothing to poll.
    async checkPayout() {
      return "pending";
    },
  };
}
