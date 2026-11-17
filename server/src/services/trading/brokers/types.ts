import type { AssetClass } from "../instruments.js";

export interface PositionView {
  symbol: string;
  assetClass: AssetClass;
  /** Shares, coins or contracts. Negative for a short futures position. */
  qty: number;
  side: "long" | "short";
  avgCost: number;
  price: number;
  /** What the position adds to equity: its value for stocks and crypto, its open profit or loss for futures. */
  marketValue: number;
  /** Full exposure: value for stocks and crypto, contract value (qty × price × multiplier) for futures. */
  notional: number;
  multiplier: number;
  /** Initial margin held for a futures position (0 otherwise). */
  margin: number;
  costBasis: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}

export interface AccountView {
  broker: "paper" | "alpaca";
  live: boolean;
  currency: "USD";
  cash: number;
  equity: number;
  buyingPower: number;
  /** Margin held for open futures positions. */
  marginUsed: number;
  startingCash: number | null;
  totalReturnPct: number | null;
  positions: PositionView[];
}

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice?: number;
  source: "manual" | "ai";
  signalId?: string;
  /** Who pressed the button: the user, or the AI autopilot acting within the user's limits. */
  placedBy?: "user" | "autopilot";
}

export interface OrderView {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice: number | null;
  status: string;
  filledQty: number;
  filledAvgPrice: number | null;
  source: "manual" | "ai";
  /** "system" marks a futures position closed automatically by a margin call. */
  placedBy: "user" | "autopilot" | "system";
  rejectReason: string | null;
  createdAt: string;
}

export interface Broker {
  id: "paper" | "alpaca";
  account(): Promise<AccountView>;
  placeOrder(input: OrderInput): Promise<OrderView>;
  listOrders(): Promise<OrderView[]>;
  cancelOrder(id: string): Promise<OrderView>;
}
