export interface PositionView {
  symbol: string;
  qty: number;
  avgCost: number;
  price: number;
  marketValue: number;
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
  placedBy: "user" | "autopilot";
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
