import { badRequest, unprocessable } from "../../lib/errors.js";
import type { Aggregator, AccountSnapshot } from "./types.js";

/**
 * Built-in demo institution so the whole connect -> consent -> sync flow works (and can be tested)
 * before any aggregator keys exist. Only enabled while the app runs in sandbox mode.
 */
export const DEMO_BANKS: { id: string; name: string; country: string; currency: string; accounts: AccountSnapshot[] }[] = [
  {
    id: "zambia", name: "Demo Bank Zambia", country: "ZM", currency: "ZMW",
    accounts: [
      { externalId: "zm-chk", name: "Everyday Current", kind: "bank", mask: "4410", currency: "ZMW", balance: 12450.0, available: 12210.5 },
      { externalId: "zm-sav", name: "Goal Saver", kind: "savings", mask: "9022", currency: "ZMW", balance: 30200.0, available: 30200.0 },
      { externalId: "zm-mm", name: "Mobile Wallet", kind: "wallet", mask: "0977", currency: "ZMW", balance: 860.75, available: 860.75 },
    ],
  },
  {
    id: "nigeria", name: "Lagos Demo Bank", country: "NG", currency: "NGN",
    accounts: [
      { externalId: "ng-chk", name: "Savings Account", kind: "savings", mask: "1188", currency: "NGN", balance: 845000.0, available: 845000.0 },
      { externalId: "ng-card", name: "Naira Credit Card", kind: "credit", mask: "3301", currency: "NGN", balance: -62500.0, available: 437500.0 },
    ],
  },
  {
    id: "kenya", name: "Nairobi Demo Bank", country: "KE", currency: "KES",
    accounts: [
      { externalId: "ke-chk", name: "Current Account", kind: "bank", mask: "7720", currency: "KES", balance: 158300.0, available: 158300.0 },
      { externalId: "ke-mpesa", name: "M-Pesa (linked)", kind: "wallet", mask: "0712", currency: "KES", balance: 4120.0, available: 4120.0 },
    ],
  },
  {
    id: "us", name: "First Demo Bank", country: "US", currency: "USD",
    accounts: [
      { externalId: "us-chk", name: "Checking", kind: "bank", mask: "0042", currency: "USD", balance: 3250.4, available: 3180.4 },
      { externalId: "us-cc", name: "Rewards Card", kind: "credit", mask: "8812", currency: "USD", balance: -640.12, available: 4359.88 },
    ],
  },
  {
    id: "uk", name: "Demo Building Society", country: "GB", currency: "GBP",
    accounts: [{ externalId: "uk-isa", name: "Cash ISA", kind: "savings", mask: "5561", currency: "GBP", balance: 8900.0, available: 8900.0 }],
  },
  {
    id: "broker", name: "Demo Brokerage", country: "US", currency: "USD",
    accounts: [{ externalId: "br-ind", name: "Individual Brokerage", kind: "investment", mask: "2207", currency: "USD", balance: 24510.33, available: 1200.0 }],
  },
];

export const sandboxAggregator: Aggregator = {
  info: {
    id: "sandbox",
    name: "Demo institutions",
    category: "bank",
    kind: "aggregator",
    coverage: "Six demo banks, wallets and a brokerage for trying the flow",
    regions: ["Demo"],
    countries: [],
    capabilities: ["balances"],
    description: "Simulated institutions with test balances. Only available while Aurex runs in sandbox mode.",
    envKeys: [],
  },
  configured: (ctx) => ctx.config.rails.includes("sandbox"),
  async start(ctx, _user, link, returnUrl) {
    const url = new URL("/connect/sandbox", ctx.config.APP_URL);
    url.searchParams.set("link", link.id);
    url.searchParams.set("return", returnUrl);
    return { redirectUrl: url.toString() };
  },
  async complete(_ctx, _user, _link, params) {
    if (params.sandbox_consent === "denied") throw unprocessable("link_denied", "You cancelled the connection");
    const bank = DEMO_BANKS.find((b) => b.id === params.sandbox_bank);
    if (!bank || params.sandbox_consent !== "granted") throw badRequest("Pick a demo institution and allow access");
    return { externalId: `demo-${bank.id}`, institution: bank.name, country: bank.country, meta: { bank: bank.id } };
  },
  async accounts(_ctx, _user, conn) {
    const id = (JSON.parse(conn.meta) as { bank?: string }).bank;
    return DEMO_BANKS.find((b) => b.id === id)?.accounts ?? [];
  },
};
