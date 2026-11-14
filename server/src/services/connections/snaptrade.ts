import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";
import type { Ctx } from "../../context.js";
import { deleteProviderCustomer, getProviderCustomer, saveProviderCustomer } from "./customers.js";
import { ConnectorError, type Aggregator } from "./types.js";

/**
 * SnapTrade: read access to brokerage accounts (Schwab, Fidelity, Robinhood, Interactive Brokers,
 * Webull, Questrade, Trading 212 and more) through SnapTrade's Connection Portal.
 * Each Aurex user is registered once with SnapTrade; all brokerages they link sit under that user.
 */
function client(ctx: Ctx) {
  return new Snaptrade({
    auth: SnaptradeAuth.commercialApiKey({ clientId: ctx.config.SNAPTRADE_CLIENT_ID!, consumerKey: ctx.config.SNAPTRADE_CONSUMER_KEY! }),
    ...(ctx.config.SNAPTRADE_BASE_URL ? { basePath: ctx.config.SNAPTRADE_BASE_URL } : {}),
  });
}

function wrap(err: unknown): never {
  const r = (err as { responseBody?: { detail?: string; message?: string }; status?: number }) ?? {};
  throw new ConnectorError(`SnapTrade: ${r.responseBody?.detail ?? r.responseBody?.message ?? (err as Error).message}`, "snaptrade", r.status);
}

async function snapUser(ctx: Ctx, userId: string) {
  const existing = getProviderCustomer(ctx, userId, "snaptrade");
  if (existing?.secret) return { userId: existing.externalId, userSecret: existing.secret };
  const snapUserId = `aurex-${userId}`;
  try {
    const res = await client(ctx).authentication.registerSnapTradeUser({ userId: snapUserId });
    const secret = res.data.userSecret;
    if (!secret) throw new ConnectorError("SnapTrade didn't return a user secret", "snaptrade");
    saveProviderCustomer(ctx, userId, "snaptrade", snapUserId, secret);
    return { userId: snapUserId, userSecret: secret };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    wrap(err);
  }
}

export const snapTradeAggregator: Aggregator = {
  info: {
    id: "snaptrade",
    name: "SnapTrade",
    category: "brokerage",
    kind: "aggregator",
    coverage: "Major retail brokerages in the US, Canada, UK and Europe",
    regions: ["North America", "UK", "Europe"],
    countries: ["US", "CA", "GB", "DE", "FR", "NL", "IE", "AU"],
    capabilities: ["balances", "holdings"],
    description: "See balances from brokerages such as Schwab, Fidelity, Robinhood and Interactive Brokers.",
    envKeys: ["SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY"],
    signupUrl: "https://dashboard.snaptrade.com/signup",
    docsUrl: "https://docs.snaptrade.com/",
  },
  configured: (ctx) => !!(ctx.config.SNAPTRADE_CLIENT_ID && ctx.config.SNAPTRADE_CONSUMER_KEY),
  async start(ctx, user, _link, returnUrl) {
    const u = await snapUser(ctx, user.id);
    try {
      const res = await client(ctx).authentication.loginSnapTradeUser({ ...u, customRedirect: returnUrl, connectionType: "read", immediateRedirect: true });
      const url = (res.data as { redirectURI?: string }).redirectURI;
      if (!url) throw new ConnectorError("SnapTrade didn't return a Connection Portal URL", "snaptrade");
      return { redirectUrl: url };
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      wrap(err);
    }
  },
  async complete(ctx, user, _link, params) {
    if ((params.status ?? "").toUpperCase() === "ERROR") throw new ConnectorError("SnapTrade: the brokerage connection failed", "snaptrade");
    const u = await snapUser(ctx, user.id);
    // One Aurex connection represents the user's SnapTrade identity; every brokerage they add shows up under it.
    return { externalId: u.userId, institution: "Brokerage accounts" };
  },
  async accounts(ctx, user) {
    const u = await snapUser(ctx, user.id);
    try {
      const res = await client(ctx).accountInformation.listUserAccounts(u);
      return res.data.map((a) => ({
        externalId: a.id,
        name: [a.institution_name, a.name].filter(Boolean).join(" · ") || "Brokerage account",
        kind: "investment" as const,
        mask: a.number ? String(a.number).slice(-4) : null,
        currency: a.balance?.total?.currency ?? null,
        balance: a.balance?.total?.amount ?? null,
        available: null,
      }));
    } catch (err) {
      wrap(err);
    }
  },
  async disconnect(ctx, user) {
    const existing = getProviderCustomer(ctx, user.id, "snaptrade");
    if (!existing) return;
    try {
      await client(ctx).authentication.deleteSnapTradeUser({ userId: existing.externalId });
    } catch (err) {
      wrap(err);
    } finally {
      deleteProviderCustomer(ctx, user.id, "snaptrade");
    }
  },
};
