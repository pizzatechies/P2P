export interface User {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  role: "user" | "admin";
  kycLevel: number;
  defaultCurrency: string;
  totpEnabled: boolean;
  status: string;
  createdAt: string;
}

export interface Currency { code: string; name: string; symbol: string; decimals: number }
export interface Rail {
  id: string;
  name: string;
  description: string;
  simulated: boolean;
  supportsDeposit: boolean;
  supportsWithdrawal: boolean;
  currencies: string[] | "*";
}

export interface Meta {
  appName: string;
  currencies: Currency[];
  rails: Rail[];
  fees: { p2pBps: number; fxSpreadBps: number; withdrawalBps: number };
  limits: { maxTxUsd: number; dailyUsd: number };
  fx: { source: "live" | "static"; asOf: string };
  trading: { liveTradingAllowed: boolean; paperStartingCash: number; aiMaxPositionPct: number };
}

export interface Balance { currency: string; balance: string; balanceMinor: number }
export interface Profile { id: string; handle: string; displayName: string }

export interface Activity {
  id: string;
  kind: string;
  memo: string | null;
  direction: "in" | "out" | "internal";
  status: string;
  counterparty: Profile | null;
  amounts: { currency: string; amount: string; amountMinor: number }[];
  fee: string | null;
  rate: number | null;
  createdAt: string;
}

export interface PaymentRequest {
  id: string;
  currency: string;
  amount: string;
  memo: string | null;
  status: "pending" | "paid" | "declined" | "canceled";
  requester: Profile;
  payer: Profile;
  createdAt: string;
}

export interface Provider {
  id: string;
  name: string;
  description: string;
  kind: string;
  available: boolean;
  source: "user" | "server" | "builtin" | null;
  keyRequired: boolean;
  keyUrl: string | null;
  listModels: boolean;
  models: { id: string; label: string }[];
}

export interface Conversation { id: string; title: string; provider: string; model: string; updatedAt: string }
export interface ChatMsg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  provider?: string | null;
  model?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
  pending?: boolean;
  error?: string;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  asOf: string;
  source: "simulated" | "alpaca";
}
export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
export interface Position {
  symbol: string;
  qty: number;
  avgCost: number;
  price: number;
  marketValue: number;
  costBasis: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}
export interface TradingAccount {
  broker: "paper" | "alpaca";
  live: boolean;
  cash: number;
  equity: number;
  buyingPower: number;
  startingCash: number | null;
  totalReturnPct: number | null;
  positions: Position[];
}
export interface TradingSettings {
  broker: "paper" | "alpaca";
  alpacaConnected: boolean;
  alpacaEnv: "paper" | "live" | null;
  liveTradingAllowed: boolean;
  dataSource: "simulated" | "alpaca";
}
export interface Order {
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
  rejectReason: string | null;
  createdAt: string;
}
export interface Signal {
  id: string;
  symbol: string;
  provider: string;
  model: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  suggestedQty: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  horizon: string | null;
  rationale: string;
  risks: string[];
  indicators: Record<string, number | null>;
  executedOrderId: string | null;
  createdAt: string;
}
