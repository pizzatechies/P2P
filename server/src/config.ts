import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/aurex.db"),
  /** Public URL of the web app. Used for redirects (Stripe) and the CSRF origin check. */
  APP_URL: z.string().url().default("http://localhost:5173"),
  /** High-entropy secret used to encrypt stored API keys and 2FA secrets. `openssl rand -hex 32` */
  MASTER_KEY: optionalString,
  /** Absolute session lifetime. */
  SESSION_TTL_HOURS: z.coerce.number().positive().default(72),
  /** Sign out after this many minutes without activity (0 = never). */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).default(120),
  /** Admins are signed out sooner when idle (0 = same as everyone). */
  ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).default(30),
  /** Comma-separated IP addresses or CIDR ranges allowed to use admin tools (empty = anywhere). */
  ADMIN_ALLOWED_IPS: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  /**
   * Secret an ADMIN_EMAILS account enters once (Settings → Admin access) to become admin. Without it,
   * production promotes nobody automatically, so registering an admin's address first gains nothing.
   */
  ADMIN_SETUP_CODE: optionalString,
  /** Admin pages and actions require two-factor authentication. */
  REQUIRE_ADMIN_2FA: bool.default(true),
  TRUST_PROXY: bool.default(false),
  /** Extra origins allowed to send state-changing requests (comma-separated), besides APP_URL. */
  ALLOWED_ORIGINS: z.string().default(""),
  /** Previous MASTER_KEY values (comma-separated). Secrets are re-encrypted with MASTER_KEY at startup. */
  MASTER_KEY_PREVIOUS: z.string().default(""),

  // ---- Email (verification codes and security alerts) ----
  /** Resend API key. Without it, codes are only logged in development, and nothing is sent in production. */
  RESEND_API_KEY: optionalString,
  RESEND_BASE_URL: z.string().url().default("https://api.resend.com"),
  /** Sender, e.g. "Aurex <no-reply@yourdomain.com>" (a domain verified with Resend). */
  EMAIL_FROM: optionalString,
  /** Require a verified email for withdrawals, being paid by email, admin access and real accounts. Defaults on when email can be delivered. */
  REQUIRE_EMAIL_VERIFICATION: bool.optional(),

  // ---- Real (live) trading accounts ----
  /** Approve upgrade applications automatically instead of waiting for an admin. */
  LIVE_UPGRADE_AUTO_APPROVE: bool.default(false),
  /** Limits by identity-verification level. Off: everyone gets MAX_TX_USD / DAILY_LIMIT_USD. */
  KYC_LIMITS: bool.default(true),
  /** Level 0 (email only) and level 1 (identity verified) limits in USD; level 2 uses MAX_TX_USD / DAILY_LIMIT_USD. */
  TIER0_TX_USD: z.coerce.number().positive().default(200),
  TIER0_DAILY_USD: z.coerce.number().positive().default(500),
  TIER1_TX_USD: z.coerce.number().positive().default(2_000),
  TIER1_DAILY_USD: z.coerce.number().positive().default(5_000),
  /** Approve identity submissions automatically (development and demos only). */
  KYC_AUTO_APPROVE: bool.default(false),
  /** Hold withdrawals for an admin's approval when they're large or the customer has an open monitoring alert. */
  PAYOUT_REVIEW: bool.default(true),
  /** Withdrawals at or above this (USD-equivalent) wait for approval. */
  PAYOUT_REVIEW_USD: z.coerce.number().positive().default(1000),
  /** Transaction monitoring flags single payments at or above this (USD-equivalent). */
  MONITOR_LARGE_USD: z.coerce.number().positive().default(3000),
  /** A safeguarding balance older than this no longer counts as verified. */
  SAFEGUARDING_STALE_HOURS: z.coerce.number().positive().default(48),
  /** Countries where real accounts may be opened (ISO codes, comma-separated). Empty = any. */
  LIVE_COUNTRIES: z.string().default(""),
  /** Demo trades a user must complete before applying for a real account. */
  LIVE_MIN_PRACTICE_TRADES: z.coerce.number().int().min(0).max(100).default(3),

  // ---- Account protection ----
  /** Failed sign-ins (password or 2FA) before an account is locked. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
  /** First lock length; doubles with each further lock, up to 24 hours. */
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(64).default(12),
  /** Reject passwords found in known breaches (Have I Been Pwned range API; only 5 hash characters leave the server). */
  PASSWORD_BREACH_CHECK: bool.optional(),
  PWNED_PASSWORDS_URL: z.string().url().default("https://api.pwnedpasswords.com/range/"),
  /** How long a password (and 2FA) re-check unlocks sensitive actions such as withdrawals. */
  REAUTH_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  /** Sends to other users at or above this USD value need a re-check (0 = every send). */
  STEP_UP_SEND_USD: z.coerce.number().min(0).default(1000),
  /** Withdrawals and large sends pause this long after a password change, 2FA removal or recovery-code sign-in. */
  SECURITY_HOLD_HOURS: z.coerce.number().min(0).max(720).default(24),
  /** Only accept M-Pesa callbacks from these IPs (comma-separated, e.g. Safaricom's published list). */
  MPESA_CALLBACK_IPS: z.string().default(""),

  // ---- Payments ----
  /** Comma-separated list of enabled payment rails: sandbox, stripe, flutterwave, mpesa, mtn-momo, paypal, wise, skrill, moneygram */
  PAYMENT_RAILS: z.string().default("sandbox"),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  P2P_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(0),
  FX_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  WITHDRAWAL_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(0),
  /** Largest single transfer/withdrawal, in USD-equivalent major units. */
  MAX_TX_USD: z.coerce.number().positive().default(10_000),
  /** Rolling 24h outbound limit per user, in USD-equivalent major units. */
  DAILY_LIMIT_USD: z.coerce.number().positive().default(25_000),
  FX_LIVE: bool.default(false),
  FX_RATES_URL: z.string().url().default("https://open.er-api.com/v6/latest/USD"),

  // ---- AI providers (server-wide keys; users can also bring their own) ----
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  MISTRAL_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
  XAI_API_KEY: optionalString,
  DEEPSEEK_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  TOGETHER_API_KEY: optionalString,
  PERPLEXITY_API_KEY: optionalString,
  OLLAMA_BASE_URL: optionalString,
  /** Model used by the trading analyst when the user doesn't pick one, as "provider:model". */
  AI_DEFAULT_MODEL: optionalString,

  // ---- Trading ----
  ALPACA_DATA_KEY_ID: optionalString,
  ALPACA_DATA_SECRET_KEY: optionalString,
  /** Must be true before any user can switch their Alpaca connection to a live (real-money) account. */
  ALLOW_LIVE_TRADING: bool.default(false),
  PAPER_STARTING_CASH: z.coerce.number().positive().default(100_000),
  /** Max share of portfolio value a single AI-suggested order may use (0-1). */
  AI_MAX_POSITION_PCT: z.coerce.number().min(0.01).max(1).default(0.1),
  /** Lets users switch on the AI autopilot (AI places trades within the user's limits). */
  AUTOPILOT_ENABLED: bool.default(true),
  /** Must be true before the autopilot may trade a LIVE (real-money) brokerage account. */
  ALLOW_LIVE_AUTOPILOT: bool.default(false),
  /** Crypto prices: live from Coinbase's public market data (no key needed), or the simulator. */
  CRYPTO_DATA: z.enum(["coinbase", "simulated"]).optional(),
  COINBASE_EXCHANGE_URL: z.string().url().default("https://api.exchange.coinbase.com"),
  /** Who can sign up: anyone, only with an invite code (others join a waitlist), or nobody new. */
  REGISTRATION_MODE: z.enum(["open", "invite", "closed"]).default("open"),
  /** Maximum number of customer accounts (0 = no cap); further sign-ups join the waitlist. */
  MAX_USERS: z.coerce.number().int().min(0).default(0),
  /** Screen customers and payout recipients against the UN and OFAC sanctions lists (downloaded daily). */
  SANCTIONS_SCREENING: bool.default(true),
  SANCTIONS_UN_URL: z.string().url().default("https://scsanctions.un.org/resources/xml/en/consolidated.xml"),
  SANCTIONS_OFAC_SDN_URL: z.string().url().default("https://www.treasury.gov/ofac/downloads/sdn.csv"),
  SANCTIONS_OFAC_ALT_URL: z.string().url().default("https://www.treasury.gov/ofac/downloads/alt.csv"),
  /** Watch-only Web3 wallets (public addresses; balances from public blockchain data). */
  WEB3_WALLETS: bool.default(true),
  WEB3_ETHEREUM_RPC: z.string().url().default("https://ethereum-rpc.publicnode.com"),
  WEB3_BASE_RPC: z.string().url().default("https://base-rpc.publicnode.com"),
  WEB3_ARBITRUM_RPC: z.string().url().default("https://arbitrum-one-rpc.publicnode.com"),
  WEB3_OPTIMISM_RPC: z.string().url().default("https://optimism-rpc.publicnode.com"),
  WEB3_POLYGON_RPC: z.string().url().default("https://polygon-bor-rpc.publicnode.com"),
  WEB3_BNB_RPC: z.string().url().default("https://bsc-rpc.publicnode.com"),
  WEB3_SOLANA_RPC: z.string().url().default("https://api.mainnet-beta.solana.com"),
  /** An Esplora API (Blockstream or mempool.space style) for Bitcoin addresses. */
  WEB3_BITCOIN_API: z.string().url().default("https://blockstream.info/api"),
  /** US stock list for search and validation: Nasdaq Trader's daily symbol files, or the built-in list only. */
  STOCK_DIRECTORY: z.enum(["nasdaq", "builtin"]).optional(),
  NASDAQ_DIRECTORY_URL: z.string().url().default("https://www.nasdaqtrader.com/dynamic/SymDir"),
  /** Shortest interval a user may set between autopilot runs. */
  AUTOPILOT_MIN_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(5),

  // ---- Connections to outside institutions (aggregators). Each is off until its keys are set. ----
  PLAID_CLIENT_ID: optionalString,
  PLAID_SECRET: optionalString,
  /** sandbox | production */
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  PLAID_COUNTRY_CODES: z.string().default("US,CA,GB,IE,FR,ES,NL,DE"),
  PLAID_BASE_URL: optionalString,
  SALTEDGE_APP_ID: optionalString,
  SALTEDGE_SECRET: optionalString,
  SALTEDGE_BASE_URL: z.string().url().default("https://www.saltedge.com/api/v6"),
  MONO_SECRET_KEY: optionalString,
  MONO_WEBHOOK_SECRET: optionalString,
  MONO_BASE_URL: z.string().url().default("https://api.withmono.com"),
  SNAPTRADE_CLIENT_ID: optionalString,
  SNAPTRADE_CONSUMER_KEY: optionalString,
  SNAPTRADE_BASE_URL: optionalString,
  /** Flutterwave payment rail (add "flutterwave" to PAYMENT_RAILS). */
  FLUTTERWAVE_SECRET_KEY: optionalString,
  FLUTTERWAVE_WEBHOOK_HASH: optionalString,
  FLUTTERWAVE_BASE_URL: z.string().url().default("https://api.flutterwave.com/v3"),
  /** M-Pesa direct via Safaricom Daraja (add "mpesa" to PAYMENT_RAILS). */
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: optionalString,
  MPESA_CONSUMER_SECRET: optionalString,
  /** Paybill or till "store number" that receives STK Push payments. */
  MPESA_SHORTCODE: optionalString,
  MPESA_PASSKEY: optionalString,
  /** CustomerPayBillOnline (paybill) or CustomerBuyGoodsOnline (till). */
  MPESA_TRANSACTION_TYPE: z.enum(["CustomerPayBillOnline", "CustomerBuyGoodsOnline"]).default("CustomerPayBillOnline"),
  /** Till number for buy-goods, when it differs from the store number. Defaults to MPESA_SHORTCODE. */
  MPESA_PARTY_B: optionalString,
  /** B2C payouts: shortcode, initiator and its encrypted SecurityCredential from the Daraja portal. */
  MPESA_B2C_SHORTCODE: optionalString,
  MPESA_INITIATOR_NAME: optionalString,
  MPESA_SECURITY_CREDENTIAL: optionalString,
  MPESA_BASE_URL: optionalString,
  /** MTN MoMo direct (add "mtn-momo" to PAYMENT_RAILS). Collections and disbursements use separate keys. */
  MTN_MOMO_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  /** X-Target-Environment: sandbox, or the market, e.g. mtnzambia, mtnuganda, mtnghana. */
  MTN_MOMO_TARGET_ENVIRONMENT: z.string().default("sandbox"),
  /** Currency of that market (sandbox only accepts EUR). */
  MTN_MOMO_CURRENCY: z.string().length(3).default("EUR"),
  MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY: optionalString,
  MTN_MOMO_COLLECTION_USER_ID: optionalString,
  MTN_MOMO_COLLECTION_API_KEY: optionalString,
  MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: optionalString,
  MTN_MOMO_DISBURSEMENT_USER_ID: optionalString,
  MTN_MOMO_DISBURSEMENT_API_KEY: optionalString,
  MTN_MOMO_BASE_URL: optionalString,
  /** PayPal and Venmo (add "paypal" to PAYMENT_RAILS). */
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_BASE_URL: optionalString,
  /** Wise payouts (add "wise" to PAYMENT_RAILS). A token for the business profile that funds payouts. */
  WISE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  WISE_API_TOKEN: optionalString,
  WISE_PROFILE_ID: optionalString,
  /** Balance that funds payouts in currencies the profile doesn't hold (Wise converts). */
  WISE_FUNDING_CURRENCY: z.string().length(3).default("USD"),
  WISE_BASE_URL: optionalString,
  /** Skrill (add "skrill" to PAYMENT_RAILS). Merchant email + secret word for checkout; API/MQI password for status checks and payouts. */
  SKRILL_EMAIL: optionalString,
  SKRILL_SECRET_WORD: optionalString,
  SKRILL_API_PASSWORD: optionalString,
  SKRILL_PAY_URL: z.string().url().default("https://pay.skrill.com"),
  SKRILL_API_URL: z.string().url().default("https://www.skrill.com/app"),
  /** MoneyGram business disbursements (add "moneygram" to PAYMENT_RAILS): cash pickup in 200+ countries. */
  MONEYGRAM_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MONEYGRAM_CLIENT_ID: optionalString,
  MONEYGRAM_CLIENT_SECRET: optionalString,
  MONEYGRAM_PARTNER_ID: optionalString,
  /** Currencies your MoneyGram account settles in (payouts are sent from these). */
  MONEYGRAM_SEND_CURRENCIES: z.string().default("USD"),
  MONEYGRAM_BASE_URL: optionalString,
  /** Coinbase OAuth app (read-only crypto balances). */
  COINBASE_CLIENT_ID: optionalString,
  COINBASE_CLIENT_SECRET: optionalString,
  COINBASE_OAUTH_URL: z.string().url().default("https://login.coinbase.com"),
  COINBASE_API_URL: z.string().url().default("https://api.coinbase.com"),

  // ---- Free AI allowance (applies only when server-provided keys are used) ----
  /** Requests per user per UTC day on the server's AI keys. 0 = unlimited. Users' own keys are never limited. */
  AI_FREE_DAILY_REQUESTS: z.coerce.number().int().min(0).default(25),
  /** Optional allowlist of "provider:model" pairs usable on the server's keys, e.g. anthropic:claude-haiku-5-5 */
  AI_FREE_MODELS: z.string().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  isProd: boolean;
  isTest: boolean;
  masterKey: Buffer;
  adminEmails: Set<string>;
  /** ADMIN_ALLOWED_IPS, parsed. */
  adminAllowedIps: string[];
  rails: string[];
  appOrigin: string;
  freeModels: Set<string>;
  /** Keys that MASTER_KEY replaced; only used to re-encrypt old secrets at startup. */
  previousMasterKeys: Buffer[];
  allowedOrigins: Set<string>;
  breachCheck: boolean;
  /** True when ADMIN_EMAILS accounts become admin without entering ADMIN_SETUP_CODE (development only). */
  adminAutoPromote: boolean;
  mpesaCallbackIps: Set<string>;
  /** How verification and alert emails go out: Resend, the server log (development), or not at all. */
  emailDelivery: "resend" | "console" | "none";
  requireEmailVerification: boolean;
  emailFrom: string;
  liveCountries: Set<string>;
  cryptoData: "coinbase" | "simulated";
  stockDirectory: "nasdaq" | "builtin";
}

const DEV_MASTER_KEY = "aurex-dev-only-master-key-change-me";

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The public URL hosting platforms provide automatically, used when APP_URL isn't set. */
function platformUrl(source: NodeJS.ProcessEnv) {
  if (source.RENDER_EXTERNAL_URL?.trim()) return source.RENDER_EXTERNAL_URL.trim();
  if (source.RAILWAY_PUBLIC_DOMAIN?.trim()) return `https://${source.RAILWAY_PUBLIC_DOMAIN.trim()}`;
  return undefined;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const fallbackUrl = source.APP_URL?.trim() ? undefined : platformUrl(source);
  const parsed = EnvSchema.safeParse(fallbackUrl ? { ...source, APP_URL: fallbackUrl } : source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === "production";

  if (isProd && !env.MASTER_KEY) {
    throw new Error("MASTER_KEY is required in production. Generate one with: openssl rand -hex 32");
  }
  if (isProd && env.MASTER_KEY && env.MASTER_KEY.length < 32) {
    throw new Error("MASTER_KEY must be at least 32 characters.");
  }

  const rails = env.PAYMENT_RAILS.split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (rails.includes("stripe") && !env.STRIPE_SECRET_KEY) {
    throw new Error("PAYMENT_RAILS includes 'stripe' but STRIPE_SECRET_KEY is not set.");
  }
  if (rails.includes("flutterwave") && !env.FLUTTERWAVE_SECRET_KEY) {
    throw new Error("PAYMENT_RAILS includes 'flutterwave' but FLUTTERWAVE_SECRET_KEY is not set.");
  }
  const railKeys: Record<string, [string, (string | undefined)[]]> = {
    mpesa: ["MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET", [env.MPESA_CONSUMER_KEY, env.MPESA_CONSUMER_SECRET]],
    "mtn-momo": [
      "MTN_MOMO_COLLECTION_* or MTN_MOMO_DISBURSEMENT_* keys",
      [env.MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY ?? env.MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY],
    ],
    paypal: ["PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET", [env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET]],
    wise: ["WISE_API_TOKEN, WISE_PROFILE_ID", [env.WISE_API_TOKEN, env.WISE_PROFILE_ID]],
    skrill: ["SKRILL_EMAIL, SKRILL_SECRET_WORD", [env.SKRILL_EMAIL, env.SKRILL_SECRET_WORD]],
    moneygram: ["MONEYGRAM_CLIENT_ID, MONEYGRAM_CLIENT_SECRET, MONEYGRAM_PARTNER_ID", [env.MONEYGRAM_CLIENT_ID, env.MONEYGRAM_CLIENT_SECRET, env.MONEYGRAM_PARTNER_ID]],
  };
  for (const [rail, [names, values]] of Object.entries(railKeys)) {
    if (rails.includes(rail) && values.some((v) => !v)) throw new Error(`PAYMENT_RAILS includes '${rail}' but ${names} is not set.`);
  }
  const emailDelivery: Config["emailDelivery"] = env.RESEND_API_KEY ? "resend" : isProd ? "none" : "console";
  if (isProd && emailDelivery === "none") {
    console.warn("[config] No email provider (RESEND_API_KEY): users can't verify their email, so withdrawals, pay-by-email and real accounts stay locked.");
  }
  if (isProd && env.ADMIN_EMAILS.trim() && !env.ADMIN_SETUP_CODE) {
    console.warn(
      "[config] ADMIN_EMAILS is set but ADMIN_SETUP_CODE is not: nobody will be made admin automatically in production. " +
        "Set ADMIN_SETUP_CODE (openssl rand -hex 16) and enter it under Settings → Admin access.",
    );
  }
  if (env.ADMIN_SETUP_CODE && env.ADMIN_SETUP_CODE.length < 16) throw new Error("ADMIN_SETUP_CODE must be at least 16 characters.");
  for (const entry of list(env.ADMIN_ALLOWED_IPS)) {
    if (!parseIpRule(entry)) throw new Error(`ADMIN_ALLOWED_IPS: "${entry}" isn't an IP address or CIDR range (e.g. 203.0.113.7 or 198.51.100.0/24).`);
  }
  if (isProd && rails.includes("sandbox")) {
    console.warn(
      "[config] WARNING: the 'sandbox' payment rail is enabled in production. It credits wallets without moving real money.",
    );
  }

  return {
    ...env,
    isProd,
    isTest: env.NODE_ENV === "test",
    masterKey: createHash("sha256")
      .update(env.MASTER_KEY ?? DEV_MASTER_KEY)
      .digest(),
    adminEmails: new Set(
      env.ADMIN_EMAILS.split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    rails,
    adminAllowedIps: list(env.ADMIN_ALLOWED_IPS),
    appOrigin: new URL(env.APP_URL).origin,
    freeModels: new Set(
      env.AI_FREE_MODELS.split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),
    previousMasterKeys: list(env.MASTER_KEY_PREVIOUS).map((k) => createHash("sha256").update(k).digest()),
    allowedOrigins: new Set([new URL(env.APP_URL).origin, ...list(env.ALLOWED_ORIGINS).map((o) => new URL(o).origin)]),
    breachCheck: env.PASSWORD_BREACH_CHECK ?? env.NODE_ENV !== "test",
    adminAutoPromote: !env.ADMIN_SETUP_CODE && !isProd,
    mpesaCallbackIps: new Set(list(env.MPESA_CALLBACK_IPS)),
    emailDelivery,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION ?? emailDelivery !== "none",
    emailFrom: env.EMAIL_FROM ?? `Aurex <no-reply@${new URL(env.APP_URL).hostname}>`,
    liveCountries: new Set(list(env.LIVE_COUNTRIES).map((c) => c.toUpperCase())),
    // Tests stay offline: simulated crypto and the built-in stock list unless a test asks otherwise.
    cryptoData: env.CRYPTO_DATA ?? (env.NODE_ENV === "test" ? "simulated" : "coinbase"),
    stockDirectory: env.STOCK_DIRECTORY ?? (env.NODE_ENV === "test" ? "builtin" : "nasdaq"),
  };
}

/** An IP address or CIDR range from ADMIN_ALLOWED_IPS, or null if it isn't one. */
export function parseIpRule(entry: string): { address: string; prefix: number | null; family: "ipv4" | "ipv6" } | null {
  const [address, bits] = entry.trim().split("/");
  const family = isIP(address);
  if (!family) return null;
  if (bits === undefined) return { address, prefix: null, family: family === 4 ? "ipv4" : "ipv6" };
  const prefix = Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family: family === 4 ? "ipv4" : "ipv6" };
}
