import { badRequest, HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import { providerMessage, railFetch, railJson, uuidFromSeed } from "./http.js";
import type { PaymentRail, RequirementGroup } from "./types.js";

/**
 * Wise payouts to bank accounts in 160+ countries.
 * Flow per withdrawal: create the recipient → quote (recipient gets exactly the amount withdrawn)
 * → transfer (customerTransactionId derived from Aurex's id, so retries never duplicate) → fund from
 * the operator's Wise balance. The payout is funded from a balance in the same currency when the
 * profile holds one, otherwise from WISE_FUNDING_CURRENCY (Wise converts).
 * Recipient fields differ by country, so the web app renders the form Wise describes
 * (account requirements).
 * Docs: https://docs.wise.com/api-reference
 */
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "INR", "AED", "BRL", "MXN", "ZAR", "NGN", "KES", "GHS", "UGX", "TZS", "CNY"];
const FAILED = new Set(["cancelled", "funds_refunded", "bounced_back", "charged_back"]);

/** {"address.city": "Lusaka"} → { address: { city: "Lusaka" } } */
export function nestDetails(flat: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = out;
    parts.slice(0, -1).forEach((p) => {
      node[p] = typeof node[p] === "object" && node[p] !== null ? node[p] : {};
      node = node[p] as Record<string, unknown>;
    });
    node[parts.at(-1)!] = value;
  }
  return out;
}

function sanitize(raw: unknown): RequirementGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((g: Record<string, unknown>) => ({
    type: String(g.type ?? ""),
    title: String(g.title ?? g.type ?? ""),
    fields: (Array.isArray(g.fields) ? g.fields : []).map((f: Record<string, unknown>) => ({
      name: String(f.name ?? ""),
      group: (Array.isArray(f.group) ? f.group : []).map((x: Record<string, unknown>) => ({
        key: String(x.key ?? ""),
        name: String(x.name ?? x.key ?? ""),
        type: String(x.type ?? "text"),
        required: Boolean(x.required),
        refreshRequirementsOnChange: Boolean(x.refreshRequirementsOnChange),
        example: typeof x.example === "string" ? x.example : null,
        minLength: typeof x.minLength === "number" ? x.minLength : null,
        maxLength: typeof x.maxLength === "number" ? x.maxLength : null,
        validationRegexp: typeof x.validationRegexp === "string" ? x.validationRegexp : null,
        valuesAllowed: Array.isArray(x.valuesAllowed)
          ? (x.valuesAllowed as Record<string, unknown>[]).slice(0, 400).map((v) => ({ key: String(v.key ?? ""), name: String(v.name ?? v.key ?? "") }))
          : null,
      })),
    })),
  }));
}

export function wiseRail(opts: { baseUrl: string; sandbox: boolean; token: string; profileId: string; fundingCurrency: string }): PaymentRail {
  const headers = { Authorization: `Bearer ${opts.token}` };
  const api = (path: string) => `${opts.baseUrl}${path}`;
  const profile = encodeURIComponent(opts.profileId);

  let balanceCache: { at: number; currencies: Set<string> } | null = null;
  async function sourceCurrencyFor(target: string) {
    if (!balanceCache || Date.now() - balanceCache.at > 10 * 60_000) {
      const res = await railFetch<{ currency?: string }[]>("Wise", api(`/profiles/${profile}/balances?types=STANDARD`), { headers }).catch(() => null);
      balanceCache = { at: Date.now(), currencies: new Set(res?.ok && Array.isArray(res.json) ? res.json.map((b) => String(b.currency)) : []) };
    }
    return balanceCache.currencies.has(target) ? target : opts.fundingCurrency;
  }

  async function quote(target: string, amountMinor: number, recipientId?: number) {
    const q = await railJson<{ id?: string }>("Wise", api(`/profiles/${profile}/quotes`), {
      headers,
      body: {
        sourceCurrency: await sourceCurrencyFor(target),
        targetCurrency: target,
        targetAmount: Number(fromMinor(amountMinor, target)),
        payIn: "BALANCE",
        ...(recipientId ? { targetAccount: recipientId } : {}),
      },
    });
    if (!q.id) throw new HttpError(502, "rail_error", "Wise didn't return a quote");
    return q.id;
  }

  return {
    id: "wise",
    name: "Bank transfer worldwide (Wise)",
    description: "Withdraw to a bank account in 160+ countries. Wise asks for the details each country needs.",
    simulated: opts.sandbox,
    supportsDeposit: false,
    supportsWithdrawal: true,
    currencies: CURRENCIES,
    payoutInput: "requirements",

    async payoutRequirements({ currency, amount, quoteId, type, details }) {
      if (amount <= 0) throw badRequest("Enter an amount first");
      const id = quoteId ?? (await quote(currency, amount));
      const url = api(`/quotes/${encodeURIComponent(id)}/account-requirements`);
      const reqHeaders = { ...headers, "Accept-Minor-Version": "1" };
      const raw =
        details && type
          ? await railJson<unknown>("Wise", url, {
              headers: reqHeaders,
              body: { type, profile: Number(opts.profileId), currency, accountHolderName: details.accountHolderName, details: nestDetails(withoutTop(details)) },
            })
          : await railJson<unknown>("Wise", url, { headers: reqHeaders });
      return { quoteId: id, groups: sanitize(raw) };
    },

    async createPayout(input) {
      const d = input.destination;
      if (!d.wiseType || !d.details) return { status: "failed", failureReason: "Fill in the bank details Wise asks for" };
      const holder = d.details.accountHolderName ?? d.name;

      const recipient = await railFetch<{ id?: number }>("Wise", api("/accounts"), {
        headers,
        body: {
          currency: input.currency,
          type: d.wiseType,
          profile: Number(opts.profileId),
          accountHolderName: holder,
          ownedByCustomer: false,
          details: nestDetails(withoutTop(d.details)),
        },
      });
      if (!recipient.ok || !recipient.json.id) {
        return { status: "failed", failureReason: `Wise: ${providerMessage(recipient.json) ?? "the bank details were rejected"}` };
      }

      let transferId: number;
      try {
        const quoteId = await quote(input.currency, input.amount, recipient.json.id);
        const transfer = await railJson<{ id?: number; status?: string }>("Wise", api("/transfers"), {
          headers,
          body: {
            targetAccount: recipient.json.id,
            quoteUuid: quoteId,
            customerTransactionId: uuidFromSeed(`wise:${input.externalId}`),
            details: { reference: "Aurex" },
          },
        });
        if (!transfer.id) throw new HttpError(502, "rail_error", "Wise didn't create the transfer");
        transferId = transfer.id;
      } catch (err) {
        return { status: "failed", failureReason: (err as Error).message };
      }

      const fund = await railFetch<{ status?: string; errorCode?: string; errorMessage?: string }>(
        "Wise",
        api(`/profiles/${profile}/transfers/${transferId}/payments`),
        { headers, body: { type: "BALANCE" } },
      );
      if (!fund.ok || fund.json.status === "REJECTED") {
        // Don't leave an unfunded transfer behind.
        await railFetch("Wise", api(`/transfers/${transferId}/cancel`), { method: "PUT", headers }).catch(() => undefined);
        const why = fund.json.errorCode === "balance.insufficient-funds" ? "the payout account is short of funds; try again later" : providerMessage(fund.json) ?? fund.json.errorCode ?? "funding failed";
        return { status: "failed", providerRef: String(transferId), failureReason: `Wise: ${why}` };
      }
      return { status: "pending", providerRef: String(transferId) };
    },

    async checkPayout({ providerRef }) {
      if (!providerRef) return "pending";
      const res = await railFetch<{ status?: string }>("Wise", api(`/transfers/${encodeURIComponent(providerRef)}`), { headers }).catch(() => null);
      if (!res?.ok || !res.json.status) return "pending";
      if (res.json.status === "outgoing_payment_sent") return "completed";
      return FAILED.has(res.json.status) ? "failed" : "pending";
    },
  };
}

/** Requirement keys that belong at the top level of the recipient, not inside "details". */
function withoutTop(details: Record<string, string>) {
  const { accountHolderName: _holder, ...rest } = details;
  return rest;
}
