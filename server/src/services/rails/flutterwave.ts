import { HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import type { PaymentRail } from "./types.js";

/**
 * Flutterwave (v3): card, bank-transfer and mobile-money deposits through Flutterwave Standard
 * (hosted checkout), and payouts to bank accounts and mobile-money wallets through Transfers.
 * Deposits use tx_ref = Aurex's external transfer id; payouts use reference = the same id.
 * Every state change is confirmed with Flutterwave's API before the ledger moves.
 * Docs: https://developer.flutterwave.com/
 */
const CURRENCIES = ["NGN", "GHS", "KES", "UGX", "TZS", "ZAR", "ZMW", "USD", "EUR", "GBP"];

export function flutterwaveRail(opts: { secretKey: string; appUrl: string; baseUrl: string }): PaymentRail {
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${opts.secretKey}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HttpError(502, "rail_error", `Couldn't reach Flutterwave: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; data?: unknown };
    if (!res.ok || json.status === "error") throw new HttpError(502, "rail_error", `Flutterwave: ${json.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }

  return {
    id: "flutterwave",
    name: "Card, bank or mobile money (Flutterwave)",
    description: "Pay by card, bank transfer, M-Pesa, MTN MoMo, Airtel Money and more. Withdraw to banks and mobile wallets.",
    simulated: opts.secretKey.includes("_TEST"),
    supportsDeposit: true,
    supportsWithdrawal: true,
    currencies: CURRENCIES,
    depositInput: "none",
    payoutInput: "bank_code",

    async createDeposit(input) {
      const redirect = new URL("/app/wallet", opts.appUrl);
      redirect.searchParams.set("deposit", "return");
      redirect.searchParams.set("ref", input.externalId);
      const res = await call<{ data?: { link?: string } }>("/payments", {
        method: "POST",
        body: {
          tx_ref: input.externalId,
          amount: Number(fromMinor(input.amount, input.currency)),
          currency: input.currency,
          redirect_url: redirect.toString(),
          customer: { email: input.email },
          customizations: { title: "Aurex wallet top-up" },
          meta: { external_id: input.externalId, user_id: input.userId },
        },
      });
      if (!res.data?.link) throw new HttpError(502, "rail_error", "Flutterwave didn't return a checkout link");
      return { status: "pending", providerRef: input.externalId, redirectUrl: res.data.link };
    },

    async checkDeposit({ externalId, currency, amount }) {
      let res: { data?: { status?: string; amount?: number; currency?: string; tx_ref?: string } };
      try {
        res = await call(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(externalId)}`);
      } catch {
        return "pending"; // not found yet, or Flutterwave unreachable: try again later
      }
      const d = res.data;
      if (!d || d.tx_ref !== externalId) return "pending";
      if (d.status === "failed") return "failed";
      if (d.status !== "successful") return "pending";
      // Never credit more than was asked for, or in another currency.
      const expected = Number(fromMinor(amount, currency));
      return d.currency === currency && typeof d.amount === "number" && d.amount >= expected ? "completed" : "failed";
    },

    async createPayout(input) {
      const d = input.destination;
      if (!d.accountNumber) return { status: "failed", failureReason: "Enter the account or mobile-money number" };
      if (!d.bankCode) {
        return { status: "failed", failureReason: "Flutterwave needs the bank or mobile-network code (e.g. MPS for M-Pesa, MTN for MTN MoMo)" };
      }
      const res = await call<{ data?: { id?: number; status?: string; complete_message?: string } }>("/transfers", {
        method: "POST",
        body: {
          account_bank: d.bankCode,
          account_number: d.accountNumber.replace(/\s+/g, ""),
          amount: Number(fromMinor(input.amount, input.currency)),
          currency: input.currency,
          narration: "Aurex withdrawal",
          reference: input.externalId,
          beneficiary_name: d.name,
        },
      });
      if (!res.data?.id) return { status: "failed", failureReason: "Flutterwave didn't accept the transfer" };
      if (res.data.status === "FAILED") return { status: "failed", providerRef: String(res.data.id), failureReason: res.data.complete_message ?? "Transfer failed" };
      return { status: res.data.status === "SUCCESSFUL" ? "completed" : "pending", providerRef: String(res.data.id) };
    },

    async checkPayout({ providerRef }) {
      if (!providerRef) return "pending";
      try {
        const res = await call<{ data?: { status?: string } }>(`/transfers/${encodeURIComponent(providerRef)}`);
        if (res.data?.status === "SUCCESSFUL") return "completed";
        if (res.data?.status === "FAILED") return "failed";
      } catch {
        /* try again later */
      }
      return "pending";
    },
  };
}
