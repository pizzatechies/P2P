import { Plaid, PlaidClient, PlaidEnvironment, PlaidError } from "plaid";
import type { Ctx } from "../../context.js";
import { ConnectorError, type Aggregator, type AccountSnapshot } from "./types.js";

/**
 * Plaid: banks and cards in the US, Canada, UK and Europe, linked through Plaid Hosted Link.
 * Docs: https://plaid.com/docs/link/hosted-link/ . The public token is read back with
 * /link/token/get (the SESSION_FINISHED webhook only triggers the same lookup), then exchanged.
 */
function client(ctx: Ctx) {
  return new PlaidClient({
    ...(ctx.config.PLAID_BASE_URL
      ? { baseUrl: ctx.config.PLAID_BASE_URL }
      : { environment: ctx.config.PLAID_ENV === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox }),
    clientId: ctx.config.PLAID_CLIENT_ID!,
    auth: { secret: ctx.config.PLAID_SECRET! },
    timeoutInSeconds: 20,
    maxRetries: 1,
  });
}

function wrap(err: unknown): never {
  if (err instanceof PlaidError) {
    const body = err.body as { error_message?: string } | undefined;
    throw new ConnectorError(`Plaid: ${body?.error_message ?? err.message}`, "plaid", err.statusCode);
  }
  throw new ConnectorError(`Plaid: ${(err as Error).message}`, "plaid");
}

function kindOf(a: Plaid.AccountBase): AccountSnapshot["kind"] {
  switch (a.type) {
    case "credit": return "credit";
    case "loan": return "loan";
    case "investment": return "investment";
    case "depository": return a.subtype === "savings" ? "savings" : "bank";
    default: return "other";
  }
}

export const plaidAggregator: Aggregator = {
  info: {
    id: "plaid",
    name: "Plaid",
    category: "bank",
    kind: "aggregator",
    coverage: "Thousands of banks, credit unions and card issuers in the US, Canada, UK and Europe",
    regions: ["North America", "UK", "Europe"],
    countries: ["US", "CA", "GB", "IE", "FR", "ES", "NL", "DE", "IT", "PL", "DK", "NO", "SE", "EE", "LT", "LV", "PT", "BE", "AT"],
    capabilities: ["balances", "transactions", "holdings"],
    description: "Link bank and card accounts with Plaid's secure sign-in. Aurex sees balances, never your bank password.",
    envKeys: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"],
    signupUrl: "https://dashboard.plaid.com/signup",
    docsUrl: "https://plaid.com/docs/",
  },
  configured: (ctx) => !!(ctx.config.PLAID_CLIENT_ID && ctx.config.PLAID_SECRET),
  async start(ctx, user, _link, returnUrl) {
    try {
      const res = await client(ctx).link.createToken({
        user: { client_user_id: user.id },
        client_name: "Aurex",
        products: ["transactions"] as Plaid.Products[],
        country_codes: ctx.config.PLAID_COUNTRY_CODES.split(",").map((c) => c.trim().toUpperCase()) as Plaid.CountryCode[],
        language: "en",
        webhook: new URL("/api/webhooks/plaid", ctx.config.APP_URL).toString(),
        hosted_link: { completion_redirect_uri: returnUrl },
      });
      if (!res.hosted_link_url) throw new ConnectorError("Plaid didn't return a Hosted Link URL", "plaid");
      return { redirectUrl: res.hosted_link_url, meta: { linkToken: res.link_token } };
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      wrap(err);
    }
  },
  async complete(ctx, _user, link) {
    const linkToken = link.meta.linkToken as string | undefined;
    if (!linkToken) throw new ConnectorError("Plaid link session is missing", "plaid");
    try {
      const session = await client(ctx).link.getToken({ link_token: linkToken });
      const results = (session.link_sessions ?? []).flatMap((s) => s.results?.item_add_results ?? []);
      const first = results[0];
      if (!first?.public_token) {
        const exited = (session.link_sessions ?? []).some((s) => s.exit);
        if (exited) throw new ConnectorError("The Plaid sign-in was closed before an account was linked", "plaid");
        return "pending";
      }
      const exchange = await client(ctx).item.exchangePublicToken({ public_token: first.public_token });
      return {
        externalId: exchange.item_id,
        secret: exchange.access_token,
        institution: first.institution?.name ?? null,
        meta: { institutionId: first.institution?.institution_id ?? null },
      };
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      wrap(err);
    }
  },
  async accounts(ctx, _user, _conn, secret) {
    try {
      const res = await client(ctx).accounts.getBalance({ access_token: secret! });
      return res.accounts.map((a) => {
        const kind = kindOf(a);
        // Plaid reports what's owed on credit and loan accounts as a positive number: store debts as negative.
        const sign = kind === "credit" || kind === "loan" ? -1 : 1;
        return {
          externalId: a.account_id,
          name: a.official_name || a.name,
          kind,
          mask: a.mask,
          currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? null,
          balance: a.balances.current === null ? null : sign * a.balances.current,
          available: a.balances.available,
        };
      });
    } catch (err) {
      wrap(err);
    }
  },
  async disconnect(ctx, _user, _conn, secret) {
    if (!secret) return;
    try {
      await client(ctx).item.remove({ access_token: secret });
    } catch (err) {
      wrap(err);
    }
  },
};
