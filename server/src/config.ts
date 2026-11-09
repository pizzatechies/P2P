import { createHash } from "node:crypto";
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
  SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 7),
  ADMIN_EMAILS: z.string().default(""),
  TRUST_PROXY: bool.default(false),

  // ---- Payments ----
  /** Comma-separated list of enabled payment rails: sandbox, stripe */
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
  /** Shortest interval a user may set between autopilot runs. */
  AUTOPILOT_MIN_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(5),

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
  rails: string[];
  appOrigin: string;
  freeModels: Set<string>;
}

const DEV_MASTER_KEY = "aurex-dev-only-master-key-change-me";

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
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
    appOrigin: new URL(env.APP_URL).origin,
    freeModels: new Set(
      env.AI_FREE_MODELS.split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  };
}
