import { createHash } from "node:crypto";
import { badRequest, HttpError } from "../../lib/errors.js";
import { safeEqual } from "../../lib/crypto.js";
import { fromMinor } from "../../lib/money.js";
import type { PaymentRail } from "./types.js";

/**
 * Skrill (Paysafe digital wallet).
 * - Deposits: Quick Checkout. Aurex asks pay.skrill.com for a session (prepare_only=1) and sends the
 *   user there. The result is confirmed with the Merchant Query Interface (query.pl status_trn), or,
 *   without an API password, by the status notification after its md5sig is verified.
 * - Payouts: the Automated Payments Interface "send money" (prepare → transfer) to the user's Skrill
 *   account email. frn_trn_id is Aurex's transfer id, so Skrill refuses a duplicate.
 * Docs: https://docs.paysafe.com/docs/digital-wallets
 */
const CURRENCIES = ["EUR", "USD", "GBP", "CAD", "AUD", "CHF", "JPY", "INR", "AED", "ZAR"];

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export interface SkrillOptions {
  email: string;
  secretWord: string;
  apiPassword?: string;
  payUrl: string;
  apiUrl: string;
  appUrl: string;
}

/**
 * Checks the md5sig Skrill posts to status_url:
 * MD5(merchant_id + transaction_id + UPPER(MD5(secret word)) + mb_amount + mb_currency + status), uppercase.
 */
export function verifySkrillSignature(fields: URLSearchParams, secretWord: string) {
  const expected = md5(
    `${fields.get("merchant_id") ?? ""}${fields.get("transaction_id") ?? ""}${md5(secretWord).toUpperCase()}${fields.get("mb_amount") ?? ""}${fields.get("mb_currency") ?? ""}${fields.get("status") ?? ""}`,
  ).toUpperCase();
  return safeEqual(expected, (fields.get("md5sig") ?? "").toUpperCase());
}

/** Skrill status codes: 2 processed, 0 pending, -1 cancelled, -2 failed, -3 chargeback. */
export function skrillOutcome(status: string | null, sentCurrency: string | null, sentAmount: string | null, currency: string, amountMinor: number) {
  if (status === "-1" || status === "-2" || status === "-3") return "failed" as const;
  if (status !== "2") return "pending" as const;
  return sentCurrency === currency && Number(sentAmount) >= Number(fromMinor(amountMinor, currency)) ? ("completed" as const) : ("failed" as const);
}

/** Reads the first XML element with this name (Skrill's API answers are tiny, flat XML documents). */
function xmlValue(xml: string, tag: string) {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml);
  return m ? m[1] : null;
}

export function skrillRail(opts: SkrillOptions): PaymentRail {
  const apiPasswordMd5 = opts.apiPassword ? md5(opts.apiPassword) : null;

  async function post(url: string, form: Record<string, string>) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HttpError(502, "rail_error", `Couldn't reach Skrill: ${(err as Error).message}`);
    }
    return { status: res.status, text: (await res.text()).trim() };
  }

  /** Merchant Query Interface: the transaction's real state, as a query string. */
  async function query(params: Record<string, string>) {
    if (!apiPasswordMd5) return null;
    const res = await post(`${opts.apiUrl}/query.pl`, { action: "status_trn", email: opts.email, password: apiPasswordMd5, ...params }).catch(() => null);
    if (!res || res.status !== 200) return null;
    const line = res.text.split(/\r?\n/).find((l) => l.includes("status="));
    return line ? new URLSearchParams(line.trim()) : null;
  }

  return {
    id: "skrill",
    name: "Skrill",
    description: "Pay with your Skrill wallet, card or local method, and withdraw to your Skrill account.",
    simulated: false,
    supportsDeposit: true,
    supportsWithdrawal: Boolean(apiPasswordMd5),
    currencies: CURRENCIES,
    depositInput: "none",
    payoutInput: "email",
    payoutLabel: "Skrill account email",

    async createDeposit(input) {
      const back = (state: string) => {
        const u = new URL("/app/wallet", opts.appUrl);
        u.searchParams.set("deposit", state);
        u.searchParams.set("ref", input.externalId);
        return u.toString();
      };
      const res = await post(opts.payUrl, {
        pay_to_email: opts.email,
        recipient_description: "Aurex",
        transaction_id: input.externalId,
        return_url: back("return"),
        cancel_url: back("canceled"),
        status_url: new URL("/api/webhooks/skrill", opts.appUrl).toString(),
        language: "EN",
        amount: fromMinor(input.amount, input.currency),
        currency: input.currency,
        detail1_description: "Aurex wallet top-up",
        detail1_text: input.externalId,
        prepare_only: "1",
      });
      // Success is a bare session id; errors come back as JSON or an HTML page.
      if (res.status !== 200 || !/^[A-Za-z0-9_-]{8,128}$/.test(res.text)) {
        const msg = /"message"\s*:\s*"([^"]+)"/.exec(res.text)?.[1] ?? `HTTP ${res.status}`;
        throw new HttpError(502, "rail_error", `Skrill: ${msg}`);
      }
      const redirect = new URL(opts.payUrl);
      redirect.searchParams.set("sid", res.text);
      return { status: "pending", providerRef: input.externalId, redirectUrl: redirect.toString() };
    },

    async checkDeposit({ externalId, currency, amount }) {
      const r = await query({ trn_id: externalId });
      if (!r) return "pending";
      if (r.get("transaction_id") && r.get("transaction_id") !== externalId) return "pending";
      return skrillOutcome(r.get("status"), r.get("currency"), r.get("amount"), currency, amount);
    },

    async createPayout(input) {
      const to = (input.destination.email ?? "").trim();
      if (!to.includes("@")) return { status: "failed", failureReason: "Enter the email address of your Skrill account" };
      if (!apiPasswordMd5) throw badRequest("Skrill payouts aren't set up on this server");
      const prep = await post(`${opts.apiUrl}/pay.pl`, {
        action: "prepare",
        email: opts.email,
        password: apiPasswordMd5,
        amount: fromMinor(input.amount, input.currency),
        currency: input.currency,
        bnf_email: to,
        subject: "Your Aurex withdrawal",
        note: "Money withdrawn from your Aurex wallet.",
        frn_trn_id: input.externalId,
      });
      const sid = xmlValue(prep.text, "sid");
      if (!sid) return { status: "failed", failureReason: `Skrill: ${xmlValue(prep.text, "error_msg") ?? `HTTP ${prep.status}`}` };

      const done = await post(`${opts.apiUrl}/pay.pl`, { action: "transfer", sid });
      const error = xmlValue(done.text, "error_msg");
      const id = xmlValue(done.text, "id");
      if (error === "EXECUTION_PENDING") return { status: "pending" };
      if (error || !id) return { status: "failed", failureReason: `Skrill: ${error ?? `HTTP ${done.status}`}` };
      // 2 = processed; 1 = scheduled (the recipient hasn't registered yet; returned after 14 days).
      return { status: xmlValue(done.text, "status") === "2" ? "completed" : "pending", providerRef: id };
    },

    async checkPayout({ externalId, providerRef }) {
      const r = await query(providerRef ? { mb_trn_id: providerRef } : { trn_id: externalId });
      if (!r) return "pending";
      const status = r.get("status");
      if (status === "2") return "completed";
      if (status === "-1" || status === "-2") return "failed";
      return "pending";
    },
  };
}
