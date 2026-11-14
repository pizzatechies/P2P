import type { Ctx } from "../../context.js";
import { getProviderCustomer, saveProviderCustomer } from "./customers.js";
import { jsonRequest } from "./http.js";
import { ConnectorError, type Aggregator, type AccountSnapshot } from "./types.js";

/**
 * Salt Edge Account Information API v6: banks across Europe and many other countries, linked
 * through the Salt Edge Connect widget. Spec: https://docs.saltedge.com/v6/ (App-id / Secret headers).
 */
const headers = (ctx: Ctx) => ({ "App-id": ctx.config.SALTEDGE_APP_ID!, Secret: ctx.config.SALTEDGE_SECRET! });
const api = <T>(ctx: Ctx, path: string, init: { method?: string; body?: unknown } = {}) =>
  jsonRequest<T>("Salt Edge", `${ctx.config.SALTEDGE_BASE_URL}${path}`, { ...init, headers: headers(ctx) });

async function customerId(ctx: Ctx, userId: string): Promise<string> {
  const existing = getProviderCustomer(ctx, userId, "saltedge");
  if (existing) return existing.externalId;
  const identifier = `aurex-${userId}`;
  let id: string;
  try {
    const res = await api<{ data: { customer_id: string } }>(ctx, "/customers", { method: "POST", body: { data: { identifier } } });
    id = res.data.customer_id;
  } catch (err) {
    if ((err as ConnectorError).status !== 409) throw err;
    // Already registered (e.g. the local mapping was lost): look it up.
    const list = await api<{ data: { customer_id: string; identifier: string }[] }>(ctx, "/customers");
    const found = list.data.find((c) => c.identifier === identifier);
    if (!found) throw err;
    id = found.customer_id;
  }
  saveProviderCustomer(ctx, userId, "saltedge", id);
  return id;
}

function kindOf(nature: string): AccountSnapshot["kind"] {
  if (["card", "credit_card"].includes(nature)) return "card";
  if (["credit", "loan", "mortgage"].includes(nature)) return "loan";
  if (["savings"].includes(nature)) return "savings";
  if (["investment", "insurance"].includes(nature)) return "investment";
  if (["ewallet", "bonus"].includes(nature)) return "wallet";
  return "bank";
}

export const saltEdgeAggregator: Aggregator = {
  info: {
    id: "saltedge",
    name: "Salt Edge",
    category: "bank",
    kind: "aggregator",
    coverage: "Banks in dozens of countries across Europe, the Middle East, Asia, Latin America and Africa",
    regions: ["Europe", "Middle East", "Asia", "Latin America", "Africa"],
    countries: [],
    capabilities: ["balances", "transactions"],
    description: "Open-banking connections through Salt Edge's secure widget.",
    envKeys: ["SALTEDGE_APP_ID", "SALTEDGE_SECRET"],
    signupUrl: "https://www.saltedge.com/client_users/sign_up",
    docsUrl: "https://docs.saltedge.com/v6/",
  },
  configured: (ctx) => !!(ctx.config.SALTEDGE_APP_ID && ctx.config.SALTEDGE_SECRET),
  async start(ctx, user, _link, returnUrl) {
    const customer = await customerId(ctx, user.id);
    const res = await api<{ data: { connect_url: string; expires_at: string } }>(ctx, "/connections/connect", {
      method: "POST",
      body: {
        data: {
          customer_id: customer,
          consent: { scopes: ["accounts", "transactions"] },
          attempt: { return_to: returnUrl, fetch_scopes: ["accounts", "balance", "transactions"] },
          return_connection_id: true,
          return_error_class: true,
        },
      },
    });
    return { redirectUrl: res.data.connect_url, meta: { customerId: customer } };
  },
  async complete(ctx, _user, _link, params) {
    if (params.error_class) throw new ConnectorError(`Salt Edge: the connection failed (${params.error_class})`, "saltedge");
    if (!params.connection_id) return "pending";
    const conn = await api<{ data: { id: string; provider_name: string; country_code: string; customer_id: string } }>(
      ctx,
      `/connections/${encodeURIComponent(params.connection_id)}`,
    );
    return { externalId: conn.data.id, institution: conn.data.provider_name, country: conn.data.country_code, meta: { customerId: conn.data.customer_id } };
  },
  async accounts(ctx, _user, conn) {
    const meta = JSON.parse(conn.meta) as { customerId?: string };
    const q = new URLSearchParams({ connection_id: conn.external_id! });
    if (meta.customerId) q.set("customer_id", meta.customerId);
    const res = await api<{ data: { id: string; name: string; nature: string; balance: number; currency_code: string; extra?: { account_number?: string; iban?: string; available_amount?: number } }[] }>(
      ctx,
      `/accounts?${q}`,
    );
    return res.data.map((a) => ({
      externalId: a.id,
      name: a.name,
      kind: kindOf(a.nature),
      mask: (a.extra?.account_number ?? a.extra?.iban ?? "").slice(-4) || null,
      currency: a.currency_code,
      balance: a.balance,
      available: a.extra?.available_amount ?? null,
    }));
  },
  async disconnect(ctx, _user, conn) {
    await api(ctx, `/connections/${encodeURIComponent(conn.external_id!)}`, { method: "DELETE" });
  },
};
