import { randomToken, safeEqual, sha256 } from "../../lib/crypto.js";
import { jsonRequest } from "./http.js";
import { ConnectorError, type Aggregator, type AccountSnapshot } from "./types.js";

/**
 * Coinbase through OAuth2 ("Sign in with Coinbase"), read-only.
 * - start: sends the user to Coinbase's consent page with state = "<linkId>.<nonce>". Only a hash
 *   of the nonce is stored, and complete() checks it (CSRF protection).
 * - The redirect URI is fixed (/api/connections/oauth/coinbase/callback), as OAuth apps require. That
 *   route forwards the code to /app/connections, where the signed-in user finishes the link.
 * - Access tokens last an hour; refresh tokens are single-use, so each refresh is saved at once.
 * - Balances are crypto amounts; their USD value comes from Coinbase's public exchange rates.
 * Docs: https://docs.cdp.coinbase.com/coinbase-app/oauth2-integration/reference
 */
const PROVIDER = "Coinbase";
const SCOPES = "wallet:accounts:read,wallet:user:read,offline_access";
const CB_VERSION = "2024-08-15";

interface Tokens {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when the access token expires. */
  expires_at: number;
}

interface CoinbaseAccount {
  id: string;
  name?: string;
  type?: string;
  currency?: { code?: string; type?: string } | string;
  balance?: { amount?: string; currency?: string };
}

export function coinbaseRedirectUri(appUrl: string) {
  return new URL("/api/connections/oauth/coinbase/callback", appUrl).toString();
}

export const coinbaseAggregator: Aggregator = {
  info: {
    id: "coinbase",
    name: "Coinbase",
    category: "crypto",
    kind: "aggregator",
    coverage: "Crypto and cash balances held at Coinbase, in 100+ countries",
    regions: ["Global"],
    countries: [],
    capabilities: ["balances"],
    description: "See your Coinbase crypto and cash balances, valued in your currency. Read-only.",
    envKeys: ["COINBASE_CLIENT_ID", "COINBASE_CLIENT_SECRET"],
    signupUrl: "https://portal.cdp.coinbase.com/",
    docsUrl: "https://docs.cdp.coinbase.com/coinbase-app/oauth2-integration/overview",
  },

  configured: (ctx) => Boolean(ctx.config.COINBASE_CLIENT_ID && ctx.config.COINBASE_CLIENT_SECRET),

  async start(ctx, _user, link) {
    const nonce = randomToken(18);
    const url = new URL("/oauth2/auth", ctx.config.COINBASE_OAUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", ctx.config.COINBASE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", coinbaseRedirectUri(ctx.config.APP_URL));
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", `${link.id}.${nonce}`);
    return { redirectUrl: url.toString(), meta: { nonceHash: sha256(nonce) } };
  },

  async complete(ctx, _user, link, params) {
    if (params.error) throw new ConnectorError(params.error === "access_denied" ? "You didn't allow access on Coinbase" : `Coinbase: ${params.error}`, PROVIDER, 422);
    const [linkId, nonce] = (params.state ?? "").split(".");
    const expected = typeof link.meta.nonceHash === "string" ? link.meta.nonceHash : "";
    if (linkId !== link.id || !nonce || !expected || !safeEqual(sha256(nonce), expected)) {
      throw new ConnectorError("This Coinbase sign-in didn't match the one Aurex started. Please try again.", PROVIDER, 422);
    }
    if (!params.code) throw new ConnectorError("Coinbase didn't send an authorization code", PROVIDER, 422);
    const tokens = await exchange(ctx, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: coinbaseRedirectUri(ctx.config.APP_URL),
    });
    const user = await jsonRequest<{ data?: { id?: string; country?: { code?: string } } }>(PROVIDER, `${ctx.config.COINBASE_API_URL}/v2/user`, {
      headers: apiHeaders(tokens.access_token),
    });
    if (!user.data?.id) throw new ConnectorError("Coinbase didn't return the account owner", PROVIDER, 502);
    return {
      externalId: user.data.id,
      secret: JSON.stringify(tokens),
      institution: "Coinbase",
      country: user.data.country?.code ?? null,
    };
  },

  async accounts(ctx, _user, _conn, secret, saveSecret) {
    let tokens = parseTokens(secret);
    if (Date.now() > tokens.expires_at - 60_000) {
      tokens = await exchange(ctx, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      saveSecret(JSON.stringify(tokens)); // the old refresh token is now spent
    }

    const accounts: CoinbaseAccount[] = [];
    let next: string | null = "/v2/accounts?limit=100";
    for (let page = 0; next && page < 20; page++) {
      const res: { data?: CoinbaseAccount[]; pagination?: { next_uri?: string | null } } = await jsonRequest(PROVIDER, `${ctx.config.COINBASE_API_URL}${next}`, {
        headers: apiHeaders(tokens.access_token),
      });
      accounts.push(...(res.data ?? []));
      next = res.pagination?.next_uri || null;
    }

    // Public rates: units of each currency per 1 USD.
    const rates = await jsonRequest<{ data?: { rates?: Record<string, string> } }>(PROVIDER, `${ctx.config.COINBASE_API_URL}/v2/exchange-rates?currency=USD`, {
      headers: { "CB-VERSION": CB_VERSION },
    })
      .then((r) => r.data?.rates ?? {})
      .catch(() => ({}) as Record<string, string>);

    const out: AccountSnapshot[] = [];
    for (const a of accounts) {
      const amount = Number(a.balance?.amount ?? 0);
      const code = (a.balance?.currency ?? (typeof a.currency === "string" ? a.currency : a.currency?.code) ?? "").toUpperCase();
      if (!code || !Number.isFinite(amount) || amount === 0) continue; // Coinbase lists a wallet for every asset
      const perUsd = Number(rates[code]);
      const fiat = a.type === "fiat" || (typeof a.currency === "object" && a.currency?.type === "fiat");
      out.push({
        externalId: a.id,
        name: a.name ?? `${code} wallet`,
        kind: fiat ? "wallet" : "crypto",
        currency: code,
        balance: amount,
        available: null,
        valueUsd: perUsd > 0 ? Math.round((amount / perUsd) * 100) / 100 : null,
      });
    }
    return out;
  },

  async disconnect(ctx, _user, _conn, secret) {
    if (!secret) return;
    const tokens = parseTokens(secret);
    // Revoking the access token also invalidates its paired refresh token.
    await jsonRequest(PROVIDER, `${ctx.config.COINBASE_OAUTH_URL}/oauth2/revoke`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      form: { token: tokens.access_token, client_id: ctx.config.COINBASE_CLIENT_ID ?? "", client_secret: ctx.config.COINBASE_CLIENT_SECRET ?? "" },
    });
  },
};

function apiHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}`, "CB-VERSION": CB_VERSION };
}

function parseTokens(secret: string | null): Tokens {
  try {
    const t = JSON.parse(secret ?? "") as Tokens;
    if (t.access_token && t.refresh_token) return t;
  } catch {
    /* fall through */
  }
  throw new ConnectorError("This Coinbase connection needs to be linked again", PROVIDER, 401);
}

async function exchange(ctx: Parameters<Aggregator["configured"]>[0], form: Record<string, string>): Promise<Tokens> {
  const res = await jsonRequest<{ access_token?: string; refresh_token?: string; expires_in?: number }>(PROVIDER, `${ctx.config.COINBASE_OAUTH_URL}/oauth2/token`, {
    form: { ...form, client_id: ctx.config.COINBASE_CLIENT_ID ?? "", client_secret: ctx.config.COINBASE_CLIENT_SECRET ?? "" },
  });
  if (!res.access_token || !res.refresh_token) throw new ConnectorError("Coinbase didn't return tokens (was offline access allowed?)", PROVIDER, 502);
  return { access_token: res.access_token, refresh_token: res.refresh_token, expires_at: Date.now() + Number(res.expires_in ?? 3600) * 1000 };
}
