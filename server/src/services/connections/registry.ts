import type { Ctx } from "../../context.js";
import { getRails } from "../rails/index.js";
import { monoAggregator } from "./mono.js";
import { plaidAggregator } from "./plaid.js";
import { saltEdgeAggregator } from "./saltedge.js";
import { sandboxAggregator } from "./sandbox.js";
import { snapTradeAggregator } from "./snaptrade.js";
import type { Aggregator, ConnectorInfo } from "./types.js";

/** Aggregators: link accounts held elsewhere and read their balances. */
const AGGREGATORS: Aggregator[] = [plaidAggregator, saltEdgeAggregator, monoAggregator, snapTradeAggregator, sandboxAggregator];

export function getAggregator(id: string) {
  return AGGREGATORS.find((a) => a.info.id === id);
}

/** Payment rails: move money in and out of Aurex wallets (see services/rails). */
const RAILS: ConnectorInfo[] = [
  {
    id: "flutterwave",
    name: "Flutterwave",
    category: "payments",
    kind: "rail",
    coverage: "Cards, bank transfers and mobile money (M-Pesa, MTN MoMo, Airtel Money and more) across Africa",
    regions: ["Africa"],
    countries: ["NG", "GH", "KE", "UG", "TZ", "ZA", "ZM", "RW", "CM", "CI", "SN"],
    capabilities: ["deposits", "payouts"],
    description: "Add money and withdraw to banks and mobile-money wallets in African markets.",
    envKeys: ["FLUTTERWAVE_SECRET_KEY", "FLUTTERWAVE_WEBHOOK_HASH", "PAYMENT_RAILS=…,flutterwave"],
    signupUrl: "https://app.flutterwave.com/register",
    docsUrl: "https://developer.flutterwave.com/",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    kind: "rail",
    coverage: "Cards, Apple Pay and Google Pay in most countries",
    regions: ["Global"],
    countries: [],
    capabilities: ["deposits"],
    description: "Add money by card through Stripe Checkout.",
    envKeys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYMENT_RAILS=…,stripe"],
    signupUrl: "https://dashboard.stripe.com/register",
    docsUrl: "https://docs.stripe.com/",
  },
];

/** Widely requested platforms without an integration yet, shown so the roadmap is visible. */
const PLANNED: ConnectorInfo[] = [
  { id: "mpesa", name: "M-Pesa (direct)", category: "payments", kind: "planned", coverage: "Safaricom M-Pesa in Kenya via the Daraja API", regions: ["Africa"], countries: ["KE"], capabilities: ["deposits", "payouts"], description: "Direct STK Push deposits and B2C payouts. Available today through Flutterwave.", envKeys: [] },
  { id: "mtn-momo", name: "MTN MoMo (direct)", category: "payments", kind: "planned", coverage: "MTN Mobile Money in 15+ African markets", regions: ["Africa"], countries: ["GH", "UG", "ZM", "CM", "CI", "RW"], capabilities: ["deposits", "payouts"], description: "Direct collections and disbursements. Available today through Flutterwave.", envKeys: [] },
  { id: "wise", name: "Wise", category: "payments", kind: "planned", coverage: "International transfers to 160+ countries", regions: ["Global"], countries: [], capabilities: ["payouts"], description: "Cross-border payouts through the Wise Platform (requires a Wise partnership).", envKeys: [] },
  { id: "paypal", name: "PayPal", category: "payments", kind: "planned", coverage: "PayPal and Venmo wallets", regions: ["Global"], countries: [], capabilities: ["deposits", "payouts"], description: "Deposits and payouts with PayPal.", envKeys: [] },
  { id: "coinbase", name: "Coinbase", category: "crypto", kind: "planned", coverage: "Crypto balances and transfers", regions: ["Global"], countries: [], capabilities: ["balances"], description: "Read crypto balances from Coinbase.", envKeys: [] },
];

export function catalogue(ctx: Ctx) {
  const rails = getRails(ctx);
  return [
    ...AGGREGATORS.filter((a) => a.info.id !== "sandbox" || a.configured(ctx)).map((a) => ({ ...a.info, configured: a.configured(ctx) })),
    ...RAILS.map((r) => ({ ...r, configured: rails.has(r.id) })),
    ...PLANNED.map((p) => ({ ...p, configured: false })),
  ];
}
