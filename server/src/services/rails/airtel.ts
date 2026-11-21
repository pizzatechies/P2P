import { constants, publicEncrypt } from "node:crypto";
import { badRequest, HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import { msisdn, plainAmount, providerMessage, railFetch, railJson, tokenCache } from "./http.js";
import type { PaymentRail } from "./types.js";

/**
 * Airtel Money through the Airtel Africa Open API.
 * - Deposits: Collections "USSD push" (POST /merchant/v1/payments/). The payer approves with their
 *   Airtel Money PIN on their phone.
 * - Payouts: Disbursements (POST /standard/v1/disbursements/), authorised with the merchant's PIN
 *   encrypted with Airtel's RSA public key. Only on when AIRTEL_DISBURSEMENT_PIN and AIRTEL_PUBLIC_KEY
 *   are set; test them in Airtel's staging environment first.
 * The transaction id Airtel stores is Aurex's own transfer id, so a retry can't pay twice. Results are
 * read back from Airtel (GET .../{id}) before the ledger moves; callbacks only trigger that check.
 * Status codes: TS success, TF failed, TE expired, TIP/TA in progress or ambiguous (kept pending).
 * Portal: https://developers.airtel.africa
 */
export interface AirtelOptions {
  baseUrl: string;
  sandbox: boolean;
  clientId: string;
  clientSecret: string;
  /** ISO country of the Airtel account, e.g. KE, UG, ZM. */
  country: string;
  currency: string;
  disbursementPin?: string;
  /** Airtel's RSA public key for encrypting the PIN (PEM, or the base64 body Airtel's portal shows). */
  publicKey?: string;
}

/** International dialling codes for Airtel Africa's markets, to turn +254712... into the local number Airtel expects. */
const DIAL: Record<string, string> = {
  KE: "254", UG: "256", TZ: "255", ZM: "260", MW: "265", RW: "250", NG: "234", CD: "243", CG: "242",
  GA: "241", MG: "261", NE: "227", TD: "235", SC: "248",
};

interface AirtelTxn {
  data?: { transaction?: { id?: string; status?: string; message?: string; airtel_money_id?: string } };
  status?: { code?: string; message?: string; success?: boolean; response_code?: string; result_code?: string };
}

export function airtelRail(opts: AirtelOptions): PaymentRail {
  const country = opts.country.toUpperCase();
  const dial = DIAL[country];

  const token = tokenCache(async () => {
    const res = await railJson<{ access_token?: string; expires_in?: number | string }>("Airtel Money", `${opts.baseUrl}/auth/oauth2/token`, {
      method: "POST",
      body: { client_id: opts.clientId, client_secret: opts.clientSecret, grant_type: "client_credentials" },
    });
    if (!res.access_token) throw new HttpError(502, "rail_error", "Airtel Money didn't return an access token");
    return { token: res.access_token, expiresIn: Number(res.expires_in ?? 180) };
  });
  const headers = async () => ({ Authorization: `Bearer ${await token()}`, "X-Country": country, "X-Currency": opts.currency });

  /** The subscriber's number without the country code, as Airtel expects (e.g. 712345678). */
  function localNumber(input: string | undefined): string | null {
    const d = msisdn(input) ?? (input ?? "").replace(/[^\d]/g, "");
    if (!d) return null;
    let local = dial && d.startsWith(dial) ? d.slice(dial.length) : d;
    if (local.startsWith("0")) local = local.slice(1);
    return /^\d{7,10}$/.test(local) ? local : null;
  }

  const outcome = (r: { ok: boolean; json: AirtelTxn }) => {
    if (!r.ok) return "pending" as const;
    const s = r.json.data?.transaction?.status;
    if (s === "TS") return "completed" as const;
    if (s === "TF" || s === "TE") return "failed" as const;
    return "pending" as const;
  };

  function encryptedPin() {
    const key = opts.publicKey!.includes("BEGIN") ? opts.publicKey! : `-----BEGIN PUBLIC KEY-----\n${opts.publicKey!.replace(/\s+/g, "").match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
    return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(opts.disbursementPin!)).toString("base64");
  }

  const canPay = Boolean(opts.disbursementPin && opts.publicKey);
  const example = dial ? `${dial}7XXXXXXXX` : "with country code";

  return {
    id: "airtel",
    name: "Airtel Money",
    description: `Pay from Airtel Money with a PIN prompt on your phone${canPay ? ", and withdraw to Airtel Money" : ""}.`,
    simulated: opts.sandbox,
    supportsDeposit: true,
    supportsWithdrawal: canPay,
    currencies: [opts.currency],
    depositInput: "phone",
    payoutInput: "phone",
    phoneHint: `Airtel Money number, e.g. ${example}`,

    async createDeposit(input) {
      const phone = localNumber(input.phone);
      if (!phone) throw badRequest(`Enter your Airtel Money number, e.g. ${example}`);
      const res = await railFetch<AirtelTxn>("Airtel Money", `${opts.baseUrl}/merchant/v1/payments/`, {
        headers: await headers(),
        body: {
          reference: "Aurex wallet top-up",
          subscriber: { country, currency: opts.currency, msisdn: phone },
          transaction: { amount: Number(plainAmount(fromMinor(input.amount, input.currency))), country, currency: opts.currency, id: input.externalId },
        },
      });
      if (!res.ok || res.json.status?.success === false) {
        throw new HttpError(502, "rail_error", `Airtel Money: ${res.json.status?.message ?? providerMessage(res.json) ?? `HTTP ${res.status}`}`);
      }
      return { status: "pending", providerRef: input.externalId, instructions: "Check your phone and approve the payment with your Airtel Money PIN." };
    },

    async checkDeposit({ externalId }) {
      const res = await railFetch<AirtelTxn>("Airtel Money", `${opts.baseUrl}/standard/v1/payments/${encodeURIComponent(externalId)}`, { headers: await headers() }).catch(() => null);
      return res ? outcome(res) : "pending";
    },

    async createPayout(input) {
      if (!canPay) return { status: "failed", failureReason: "Airtel Money payouts aren't set up" };
      const phone = localNumber(input.destination.accountNumber);
      if (!phone) return { status: "failed", failureReason: `Enter the Airtel Money number, e.g. ${example}` };
      const res = await railFetch<AirtelTxn>("Airtel Money", `${opts.baseUrl}/standard/v1/disbursements/`, {
        headers: await headers(),
        body: {
          payee: { msisdn: phone },
          reference: "Aurex withdrawal",
          pin: encryptedPin(),
          transaction: { amount: Number(plainAmount(fromMinor(input.amount, input.currency))), id: input.externalId },
        },
      });
      if (!res.ok || res.json.status?.success === false) {
        return { status: "failed", failureReason: `Airtel Money: ${res.json.status?.message ?? providerMessage(res.json) ?? `HTTP ${res.status}`}` };
      }
      const now = outcome(res);
      return { status: now === "completed" ? "completed" : now === "failed" ? "failed" : "pending", providerRef: input.externalId, failureReason: now === "failed" ? `Airtel Money: ${res.json.data?.transaction?.message ?? "payout failed"}` : undefined };
    },

    async checkPayout({ externalId }) {
      if (!canPay) return "pending";
      const res = await railFetch<AirtelTxn>("Airtel Money", `${opts.baseUrl}/standard/v1/disbursements/${encodeURIComponent(externalId)}`, { headers: await headers() }).catch(() => null);
      return res ? outcome(res) : "pending";
    },
  };
}
