import type { Ctx } from "../../context.js";
import { jsonRequest } from "./http.js";
import { ConnectorError, type Aggregator } from "./types.js";

/**
 * Mono: bank accounts in Nigeria and other African markets, linked through Mono's hosted widget
 * (POST /v2/accounts/initiate -> mono_url). Mono confirms a link either with a `code` on the redirect
 * (exchanged at POST /v2/accounts/auth) or with the `mono.events.account_connected` webhook.
 * Marked beta: Mono's public docs don't fully specify the redirect parameters or the webhook
 * signature header, so confirm both against your Mono dashboard before going live.
 */
const api = <T>(ctx: Ctx, path: string, init: { method?: string; body?: unknown } = {}) =>
  jsonRequest<T>("Mono", `${ctx.config.MONO_BASE_URL}${path}`, { ...init, headers: { "mono-sec-key": ctx.config.MONO_SECRET_KEY! } });

export const monoAggregator: Aggregator = {
  info: {
    id: "mono",
    name: "Mono",
    category: "bank",
    kind: "aggregator",
    coverage: "Banks in Nigeria and other African markets",
    regions: ["Africa"],
    countries: ["NG", "GH", "KE", "ZA"],
    capabilities: ["balances", "transactions"],
    description: "Connect African bank accounts through Mono's secure widget.",
    envKeys: ["MONO_SECRET_KEY", "MONO_WEBHOOK_SECRET"],
    signupUrl: "https://app.mono.co/signup",
    docsUrl: "https://docs.mono.co/",
    beta: true,
  },
  configured: (ctx) => !!ctx.config.MONO_SECRET_KEY,
  async start(ctx, user, link, returnUrl) {
    const res = await api<{ data: { mono_url: string } }>(ctx, "/v2/accounts/initiate", {
      method: "POST",
      body: {
        customer: { name: user.display_name, email: user.email },
        meta: { ref: link.id },
        scope: "auth",
        redirect_url: returnUrl,
      },
    });
    if (!res.data?.mono_url) throw new ConnectorError("Mono didn't return a linking URL", "mono");
    return { redirectUrl: res.data.mono_url };
  },
  async complete(ctx, _user, _link, params) {
    const status = (params.status ?? "").toLowerCase();
    if (["failed", "exited", "cancelled", "canceled", "error"].includes(status)) {
      throw new ConnectorError(`Mono: linking ${status}${params.reason ? ` (${params.reason})` : ""}`, "mono");
    }
    if (!params.code) return "pending"; // confirmed later by the account_connected webhook
    const res = await api<{ id?: string; data?: { id?: string } }>(ctx, "/v2/accounts/auth", { method: "POST", body: { code: params.code } });
    const id = res.data?.id ?? res.id;
    if (!id) throw new ConnectorError("Mono didn't return an account id", "mono");
    let institution: string | null = null;
    try {
      const details = await api<{ data?: { account?: { institution?: { name?: string } }; institution?: { name?: string } } }>(ctx, `/v2/accounts/${encodeURIComponent(id)}`);
      institution = details.data?.account?.institution?.name ?? details.data?.institution?.name ?? null;
    } catch {
      /* institution name is cosmetic */
    }
    return { externalId: id, institution };
  },
  async accounts(ctx, _user, conn) {
    const res = await api<{ data: { id: string; name: string; account_number?: string; balance: number; currency: string } }>(
      ctx,
      `/v2/accounts/${encodeURIComponent(conn.external_id!)}/balance`,
    );
    const a = res.data;
    return [
      {
        externalId: a.id ?? conn.external_id!,
        name: a.name,
        kind: "bank",
        mask: a.account_number?.slice(-4) ?? null,
        currency: a.currency ?? "NGN",
        // Mono reports amounts in the currency's minor unit (kobo for NGN).
        balance: typeof a.balance === "number" ? a.balance / 100 : null,
        available: null,
      },
    ];
  },
  async disconnect(ctx, _user, conn) {
    await api(ctx, `/v2/accounts/${encodeURIComponent(conn.external_id!)}/unlink`, { method: "POST" });
  },
};
