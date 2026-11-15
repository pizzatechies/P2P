import { badRequest, HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import { msisdn, plainAmount, providerMessage, railFetch, railJson, tokenCache, uuidFromSeed } from "./http.js";
import type { PaymentRail } from "./types.js";

/**
 * MTN MoMo direct through the MoMo Open API.
 * - Deposits: Collection "Request to Pay". The payer approves with their MoMo PIN on their phone.
 * - Payouts: Disbursement "Transfer".
 * Each request's X-Reference-Id is derived from Aurex's transfer id, so a retry can't pay twice. Every
 * result is read back with GET .../{referenceId} before the ledger moves; callbacks only trigger that.
 * Collections and disbursements are separate MoMo products with their own keys.
 * Docs: https://momodeveloper.mtn.com/api-documentation
 */
interface ProductKeys {
  subscriptionKey: string;
  userId: string;
  apiKey: string;
}

export interface MtnMomoOptions {
  baseUrl: string;
  sandbox: boolean;
  targetEnvironment: string;
  currency: string;
  collection?: ProductKeys;
  disbursement?: ProductKeys;
  /** Only sent when it's https, which MoMo requires. */
  callbackUrl?: string;
}

interface MomoStatus {
  amount?: string;
  currency?: string;
  externalId?: string;
  status?: "PENDING" | "SUCCESSFUL" | "FAILED" | string;
  reason?: string | { code?: string; message?: string };
}

export function mtnMomoRail(opts: MtnMomoOptions): PaymentRail {
  function product(name: "collection" | "disbursement") {
    const keys = opts[name];
    if (!keys) return null;
    const token = tokenCache(async () => {
      const basic = Buffer.from(`${keys.userId}:${keys.apiKey}`).toString("base64");
      const res = await railJson<{ access_token?: string; expires_in?: number }>("MTN MoMo", `${opts.baseUrl}/${name}/token/`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Ocp-Apim-Subscription-Key": keys.subscriptionKey },
      });
      if (!res.access_token) throw new HttpError(502, "rail_error", "MTN MoMo didn't return an access token");
      return { token: res.access_token, expiresIn: Number(res.expires_in ?? 3600) };
    });
    return async (referenceId?: string) => ({
      Authorization: `Bearer ${await token()}`,
      "X-Target-Environment": opts.targetEnvironment,
      "Ocp-Apim-Subscription-Key": keys.subscriptionKey,
      ...(referenceId ? { "X-Reference-Id": referenceId } : {}),
      ...(referenceId && opts.callbackUrl?.startsWith("https://") ? { "X-Callback-Url": opts.callbackUrl } : {}),
    });
  }
  const collection = product("collection");
  const disbursement = product("disbursement");

  const settled = (s: MomoStatus, externalId: string, currency: string, amount: number) => {
    if (s.status === "FAILED") return "failed" as const;
    if (s.status !== "SUCCESSFUL") return "pending" as const;
    if (s.externalId && s.externalId !== externalId) return "failed" as const;
    const expected = Number(fromMinor(amount, currency));
    return s.currency === currency && Number(s.amount) >= expected ? ("completed" as const) : ("failed" as const);
  };

  return {
    id: "mtn-momo",
    name: "MTN MoMo",
    description: "Pay from MTN Mobile Money with a PIN prompt on your phone, and withdraw to MoMo.",
    simulated: opts.sandbox,
    supportsDeposit: Boolean(collection),
    supportsWithdrawal: Boolean(disbursement),
    currencies: [opts.currency],
    depositInput: "phone",
    payoutInput: "phone",
    phoneHint: "Number with country code, e.g. 260971234567",

    async createDeposit(input) {
      const phone = msisdn(input.phone);
      if (!phone) throw badRequest("Enter the MoMo number with its country code, e.g. 260971234567");
      const ref = uuidFromSeed(`momo:${input.externalId}`);
      const res = await railFetch("MTN MoMo", `${opts.baseUrl}/collection/v1_0/requesttopay`, {
        headers: await collection!(ref),
        body: {
          amount: plainAmount(fromMinor(input.amount, input.currency)),
          currency: input.currency,
          externalId: input.externalId,
          payer: { partyIdType: "MSISDN", partyId: phone },
          payerMessage: "Aurex wallet top-up",
          payeeNote: "Aurex wallet top-up",
        },
      });
      if (!res.ok && res.status !== 409) throw new HttpError(502, "rail_error", `MTN MoMo: ${providerMessage(res.json) ?? `HTTP ${res.status}`}`);
      return { status: "pending", providerRef: ref, instructions: "Check your phone and approve the payment with your MoMo PIN." };
    },

    async checkDeposit({ externalId, providerRef, currency, amount }) {
      if (!providerRef || !collection) return "pending";
      const res = await railFetch<MomoStatus>("MTN MoMo", `${opts.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(providerRef)}`, {
        headers: await collection(),
      }).catch(() => null);
      if (!res?.ok) return "pending";
      return settled(res.json, externalId, currency, amount);
    },

    async createPayout(input) {
      const phone = msisdn(input.destination.accountNumber);
      if (!phone) return { status: "failed", failureReason: "Enter the MoMo number with its country code, e.g. 260971234567" };
      const ref = uuidFromSeed(`momo:${input.externalId}`);
      const res = await railFetch("MTN MoMo", `${opts.baseUrl}/disbursement/v1_0/transfer`, {
        headers: await disbursement!(ref),
        body: {
          amount: plainAmount(fromMinor(input.amount, input.currency)),
          currency: input.currency,
          externalId: input.externalId,
          payee: { partyIdType: "MSISDN", partyId: phone },
          payerMessage: "Aurex withdrawal",
          payeeNote: "Aurex withdrawal",
        },
      });
      if (!res.ok && res.status !== 409) return { status: "failed", failureReason: `MTN MoMo: ${providerMessage(res.json) ?? `HTTP ${res.status}`}` };
      return { status: "pending", providerRef: ref };
    },

    async checkPayout({ externalId, providerRef }) {
      if (!providerRef || !disbursement) return "pending";
      const res = await railFetch<MomoStatus>("MTN MoMo", `${opts.baseUrl}/disbursement/v1_0/transfer/${encodeURIComponent(providerRef)}`, {
        headers: await disbursement(),
      }).catch(() => null);
      if (!res?.ok) return "pending";
      if (res.json.externalId && res.json.externalId !== externalId) return "failed";
      if (res.json.status === "SUCCESSFUL") return "completed";
      if (res.json.status === "FAILED") return "failed";
      return "pending";
    },
  };
}
