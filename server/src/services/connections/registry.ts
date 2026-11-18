import type { Ctx } from "../../context.js";
import { getRails } from "../rails/index.js";
import { coinbaseAggregator } from "./coinbase.js";
import { monoAggregator } from "./mono.js";
import { plaidAggregator } from "./plaid.js";
import { saltEdgeAggregator } from "./saltedge.js";
import { sandboxAggregator } from "./sandbox.js";
import { snapTradeAggregator } from "./snaptrade.js";
import type { Aggregator, ConnectorInfo } from "./types.js";
import { web3Aggregator } from "./web3.js";

/** Aggregators: link accounts held elsewhere and read their balances. */
const AGGREGATORS: Aggregator[] = [plaidAggregator, saltEdgeAggregator, monoAggregator, snapTradeAggregator, coinbaseAggregator, web3Aggregator, sandboxAggregator];

export function getAggregator(id: string) {
  return AGGREGATORS.find((a) => a.info.id === id);
}

/** Payment rails: move money in and out of Aurex wallets (see services/rails). */
const RAILS: ConnectorInfo[] = [
  {
    id: "mpesa",
    name: "M-Pesa",
    category: "payments",
    kind: "rail",
    coverage: "Safaricom M-Pesa in Kenya, direct through the Daraja API",
    regions: ["Africa"],
    countries: ["KE"],
    capabilities: ["deposits", "payouts"],
    description: "Add money with an M-Pesa PIN prompt (STK Push) and withdraw straight to M-Pesa (B2C).",
    envKeys: ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_INITIATOR_NAME", "MPESA_SECURITY_CREDENTIAL", "PAYMENT_RAILS=…,mpesa"],
    signupUrl: "https://developer.safaricom.co.ke/",
    docsUrl: "https://developer.safaricom.co.ke/APIs",
  },
  {
    id: "mtn-momo",
    name: "MTN MoMo",
    category: "payments",
    kind: "rail",
    coverage: "MTN Mobile Money in Ghana, Uganda, Zambia, Cameroon, Côte d'Ivoire, Rwanda and more",
    regions: ["Africa"],
    countries: ["GH", "UG", "ZM", "CM", "CI", "RW", "BJ", "CG", "SZ", "GN", "LR", "ZA"],
    capabilities: ["deposits", "payouts"],
    description: "Add money with a MoMo PIN prompt (Request to Pay) and withdraw to MoMo wallets (Disbursements). One market per server.",
    envKeys: ["MTN_MOMO_TARGET_ENVIRONMENT", "MTN_MOMO_CURRENCY", "MTN_MOMO_COLLECTION_*", "MTN_MOMO_DISBURSEMENT_*", "PAYMENT_RAILS=…,mtn-momo"],
    signupUrl: "https://momodeveloper.mtn.com/",
    docsUrl: "https://momodeveloper.mtn.com/api-documentation",
  },
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
    id: "paypal",
    name: "PayPal & Venmo",
    category: "payments",
    kind: "rail",
    coverage: "PayPal in 200+ markets; Venmo in the US",
    regions: ["Global"],
    countries: [],
    capabilities: ["deposits", "payouts"],
    description: "Add money with PayPal (balance, bank or card) and withdraw to a PayPal or Venmo account.",
    envKeys: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENV", "PAYMENT_RAILS=…,paypal"],
    signupUrl: "https://developer.paypal.com/",
    docsUrl: "https://developer.paypal.com/docs/api/orders/v2/",
  },
  {
    id: "wise",
    name: "Wise",
    category: "payments",
    kind: "rail",
    coverage: "Bank payouts to 160+ countries in 40+ currencies",
    regions: ["Global"],
    countries: [],
    capabilities: ["payouts"],
    description: "Withdraw to bank accounts worldwide. The form asks for exactly the details each country needs.",
    envKeys: ["WISE_API_TOKEN", "WISE_PROFILE_ID", "WISE_ENV", "PAYMENT_RAILS=…,wise"],
    signupUrl: "https://wise.com/business/",
    docsUrl: "https://docs.wise.com/api-reference",
  },
  {
    id: "skrill",
    name: "Skrill",
    category: "payments",
    kind: "rail",
    coverage: "Skrill wallets and local payment methods in 120+ countries",
    regions: ["Global"],
    countries: [],
    capabilities: ["deposits", "payouts"],
    description: "Add money with Skrill Quick Checkout and withdraw to a Skrill account.",
    envKeys: ["SKRILL_EMAIL", "SKRILL_SECRET_WORD", "SKRILL_API_PASSWORD", "PAYMENT_RAILS=…,skrill"],
    signupUrl: "https://www.skrill.com/en/business/",
    docsUrl: "https://docs.paysafe.com/docs/digital-wallets",
  },
  {
    id: "moneygram",
    name: "MoneyGram",
    category: "payments",
    kind: "rail",
    coverage: "Cash pickup at MoneyGram locations in 200+ countries",
    regions: ["Global"],
    countries: [],
    capabilities: ["payouts"],
    description: "Withdraw for cash pickup. The recipient collects it with a reference number and their ID.",
    envKeys: ["MONEYGRAM_CLIENT_ID", "MONEYGRAM_CLIENT_SECRET", "MONEYGRAM_PARTNER_ID", "PAYMENT_RAILS=…,moneygram"],
    signupUrl: "https://developer.moneygram.com/",
    docsUrl: "https://developer.moneygram.com/moneygram-developer/docs/disbursement",
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

export function catalogue(ctx: Ctx) {
  const rails = getRails(ctx);
  return [
    ...AGGREGATORS.filter((a) => a.info.id !== "sandbox" || a.configured(ctx)).map((a) => ({ ...a.info, configured: a.configured(ctx) })),
    ...RAILS.map((r) => ({ ...r, configured: rails.has(r.id) })),
  ];
}
