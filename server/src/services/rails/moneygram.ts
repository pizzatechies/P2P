import { HttpError } from "../../lib/errors.js";
import { fromMinor } from "../../lib/money.js";
import { providerMessage, railFetch, railJson, tokenCache, uuidFromSeed } from "./http.js";
import type { PaymentRail } from "./types.js";

/**
 * MoneyGram business disbursements: send a withdrawal for cash pickup at MoneyGram locations in 200+
 * countries. Flow: quote → update (recipient details, validated and compliance-screened by MoneyGram)
 * → commit, which returns the reference number the recipient shows, with their ID, to collect the
 * cash. Status is read from the Status API ("RECEIVED" means it has been picked up).
 * Docs: https://developer.moneygram.com/moneygram-developer/docs/disbursement
 */

/** Receive countries offered in the form, ISO 3166 alpha-2 → alpha-3 (MoneyGram uses alpha-3). */
export const MONEYGRAM_COUNTRIES: Record<string, string> = {
  NG: "NGA", GH: "GHA", KE: "KEN", UG: "UGA", TZ: "TZA", ZM: "ZMB", ZW: "ZWE", ZA: "ZAF", RW: "RWA", CM: "CMR", CI: "CIV", SN: "SEN",
  ET: "ETH", MA: "MAR", EG: "EGY", MW: "MWI", MZ: "MOZ", CD: "COD", LR: "LBR", SL: "SLE", BJ: "BEN", TG: "TGO", ML: "MLI", BF: "BFA",
  IN: "IND", PK: "PAK", BD: "BGD", PH: "PHL", VN: "VNM", ID: "IDN", NP: "NPL", LK: "LKA", CN: "CHN", TH: "THA", MY: "MYS",
  MX: "MEX", GT: "GTM", HN: "HND", SV: "SLV", NI: "NIC", DO: "DOM", HT: "HTI", JM: "JAM", CO: "COL", PE: "PER", EC: "ECU", BO: "BOL",
  BR: "BRA", US: "USA", CA: "CAN", GB: "GBR", FR: "FRA", DE: "DEU", ES: "ESP", IT: "ITA", PT: "PRT", NL: "NLD", PL: "POL", RO: "ROU",
  UA: "UKR", TR: "TUR", AE: "ARE", SA: "SAU", JO: "JOR", LB: "LBN",
};

const FAILED = new Set(["REFUNDED", "CANCELED", "CANCELLED", "REJECTED", "REVERSED", "DECLINED", "CLOSED"]);

interface QuoteResponse {
  transactions?: { transactionId?: string; serviceOptionCode?: string; receiveAmount?: { total?: { value?: number; currencyCode?: string } } }[];
}

export function moneygramRail(opts: { baseUrl: string; sandbox: boolean; clientId: string; clientSecret: string; partnerId: string; sendCurrencies: string[] }): PaymentRail {
  const token = tokenCache(async () => {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const res = await railJson<{ access_token?: string; expires_in?: number | string }>("MoneyGram", `${opts.baseUrl}/oauth/accesstoken?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.access_token) throw new HttpError(502, "rail_error", "MoneyGram didn't return an access token");
    return { token: res.access_token, expiresIn: Number(res.expires_in ?? 3599) };
  });
  const headers = async (requestId: string) => ({ Authorization: `Bearer ${await token()}`, "X-MG-ClientRequestId": requestId });
  const business = { agentPartnerId: opts.partnerId, targetAudience: "AGENT_FACING", userLanguage: "en-US" };

  return {
    id: "moneygram",
    name: "Cash pickup (MoneyGram)",
    description: "Send a withdrawal for cash pickup at MoneyGram locations in 200+ countries. You get a reference number to collect it.",
    simulated: opts.sandbox,
    supportsDeposit: false,
    supportsWithdrawal: true,
    currencies: opts.sendCurrencies,
    payoutInput: "cash_pickup",

    async createPayout(input) {
      const d = input.destination;
      const country = MONEYGRAM_COUNTRIES[(d.country ?? "").toUpperCase()];
      const firstName = d.firstName?.trim();
      const lastName = d.lastName?.trim();
      if (!country) return { status: "failed", failureReason: "Choose the country where the cash will be collected" };
      if (!firstName || !lastName) return { status: "failed", failureReason: "Enter the recipient's first and last name exactly as on their ID" };

      const order = {
        ...business,
        destinationCountryCode: country,
        serviceOptionCode: "WILL_CALL",
        beneficiaryTypeCode: "Consumer",
        sendAmount: { currencyCode: input.currency, value: Number(fromMinor(input.amount, input.currency)) },
      };
      const quote = await railFetch<QuoteResponse>("MoneyGram", `${opts.baseUrl}/disbursement/v1/transactions/quote`, {
        headers: await headers(uuidFromSeed(`mg-quote:${input.externalId}`)),
        body: order,
      });
      const option = quote.json.transactions?.find((t) => t.serviceOptionCode === "WILL_CALL") ?? quote.json.transactions?.[0];
      if (!quote.ok || !option?.transactionId) return { status: "failed", failureReason: `MoneyGram: ${providerMessage(quote.json) ?? "no cash pickup option for that country"}` };
      const id = option.transactionId;

      // MoneyGram validates and screens the recipient here; problems come back as errors to show the user.
      const update = await railFetch<{ readyForCommit?: boolean; readyToCommit?: boolean }>("MoneyGram", `${opts.baseUrl}/disbursement/v1/transactions/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: await headers(uuidFromSeed(`mg-update:${input.externalId}`)),
        body: {
          ...order,
          initiator: { method: "api", userId: input.userId, userType: "consumer" },
          receiver: { name: { firstName, middleName: "", lastName, secondLastName: "" } },
        },
      });
      if (!update.ok || !(update.json.readyForCommit ?? update.json.readyToCommit)) {
        return { status: "failed", providerRef: id, failureReason: `MoneyGram: ${providerMessage(update.json) ?? "the recipient details weren't accepted"}` };
      }

      const commit = await railFetch<{ referenceNumber?: string; expectedPayoutDate?: string }>("MoneyGram", `${opts.baseUrl}/disbursement/v1/transactions/${encodeURIComponent(id)}/commit`, {
        method: "PUT",
        headers: await headers(uuidFromSeed(`mg-commit:${input.externalId}`)),
        body: { partnerTransactionId: input.externalId },
      });
      if (!commit.ok || !commit.json.referenceNumber) {
        return { status: "failed", providerRef: id, failureReason: `MoneyGram: ${providerMessage(commit.json) ?? "the payout couldn't be completed"}` };
      }
      // Funds are now waiting for pickup; the transfer completes when the recipient collects them.
      return { status: "pending", providerRef: id, reference: commit.json.referenceNumber };
    },

    async checkPayout({ providerRef }) {
      if (!providerRef) return "pending";
      const url = new URL(`${opts.baseUrl}/status/v1/transactions/${encodeURIComponent(providerRef)}`);
      for (const [k, v] of Object.entries(business)) url.searchParams.set(k, v);
      const res = await railFetch<{ transactionStatus?: string }>("MoneyGram", url.toString(), { headers: await headers(uuidFromSeed(`mg-status:${providerRef}:${Date.now()}`)) }).catch(() => null);
      const status = res?.ok ? (res.json.transactionStatus ?? "").toUpperCase() : "";
      if (status === "RECEIVED") return "completed";
      return FAILED.has(status) ? "failed" : "pending";
    },
  };
}
