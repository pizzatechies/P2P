import type { Ctx } from "../../context.js";
import type { UserRow } from "../users.js";

export type ConnectorCategory = "bank" | "brokerage" | "payments" | "crypto";
export type Capability = "balances" | "transactions" | "holdings" | "deposits" | "payouts" | "trading";

/** What the catalogue shows about a provider. */
export interface ConnectorInfo {
  id: string;
  name: string;
  category: ConnectorCategory;
  kind: "aggregator" | "rail" | "planned";
  /** Human-readable reach, e.g. "Thousands of banks in the US, Canada, UK and Europe". */
  coverage: string;
  regions: string[];
  /** ISO country codes for filtering; empty = global. */
  countries: string[];
  capabilities: Capability[];
  description: string;
  /** Environment variables the operator must set to enable it. */
  envKeys: string[];
  signupUrl?: string;
  docsUrl?: string;
  /** True when parts of the provider's API couldn't be confirmed from public docs. */
  beta?: boolean;
}

export interface PendingLink {
  id: string;
  userId: string;
  provider: string;
  meta: Record<string, unknown>;
}

export interface LinkedRow {
  id: string;
  user_id: string;
  provider: string;
  status: "pending" | "active" | "error";
  external_id: string | null;
  secret_enc: string | null;
  institution: string | null;
  country: string | null;
  error: string | null;
  meta: string;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface AccountSnapshot {
  externalId: string;
  name: string;
  kind: "bank" | "savings" | "card" | "credit" | "loan" | "investment" | "wallet" | "crypto" | "other";
  mask?: string | null;
  currency?: string | null;
  balance?: number | null;
  available?: number | null;
  /** Value in USD for assets Aurex has no exchange rate for (crypto), so net worth can include them. */
  valueUsd?: number | null;
}

/** Result of finishing a link: the connection's identity and secret at the aggregator. */
export interface CompletedLink {
  externalId: string;
  secret?: string;
  institution?: string | null;
  country?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * An aggregator lets a user link accounts held elsewhere (banks, brokerages, wallets) through the
 * aggregator's own hosted consent screen. Flow: start() -> user is redirected to the provider ->
 * provider redirects back to returnUrl -> complete() -> accounts() on every sync.
 */
export interface Aggregator {
  info: ConnectorInfo;
  configured(ctx: Ctx): boolean;
  start(ctx: Ctx, user: UserRow, link: PendingLink, returnUrl: string): Promise<{ redirectUrl: string; meta?: Record<string, unknown> }>;
  /** Returns "pending" when the provider confirms asynchronously (webhook) rather than on the redirect. */
  complete(ctx: Ctx, user: UserRow, link: PendingLink, params: Record<string, string>): Promise<CompletedLink | "pending">;
  /** saveSecret persists a rotated credential (e.g. a single-use OAuth refresh token) immediately. */
  accounts(ctx: Ctx, user: UserRow, conn: LinkedRow, secret: string | null, saveSecret: (secret: string) => void): Promise<AccountSnapshot[]>;
  disconnect?(ctx: Ctx, user: UserRow, conn: LinkedRow, secret: string | null): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public provider: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
