import type { Ctx } from "../../../context.js";
import { all, nowIso, one, run } from "../../../db/index.js";
import { HttpError, notFound, unprocessable } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import type { OrderRow } from "./paper.js";
import { orderView } from "./paper.js";
import { assetClassOf } from "../instruments.js";
import { recordFill } from "../records.js";
import type { AccountView, Broker, OrderInput, OrderView } from "./types.js";

export const ALPACA_PAPER = "https://paper-api.alpaca.markets";
export const ALPACA_LIVE = "https://api.alpaca.markets";

interface AlpacaOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: string | null;
  limit_price: string | null;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  created_at: string;
  updated_at?: string | null;
  filled_at?: string | null;
  asset_class?: string;
}

/** Order states after which nothing more fills. */
const FINAL = new Set(["filled", "canceled", "expired", "rejected"]);

export async function alpacaRequest<T>(
  base: string,
  creds: { keyId: string; secretKey: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "APCA-API-KEY-ID": creds.keyId,
        "APCA-API-SECRET-KEY": creds.secretKey,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, "broker_unreachable", `Couldn't reach Alpaca: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(422, "broker_auth", "Alpaca rejected these API keys");
  if (res.status === 404) throw notFound("Alpaca: not found");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new HttpError(422, "broker_rejected", `Alpaca: ${body.message ?? `HTTP ${res.status}`}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const num = (s: string | null | undefined) => (s === null || s === undefined || s === "" ? null : Number(s));

/** Alpaca writes crypto as "BTC/USD" (orders) or "BTCUSD" (positions); Aurex uses "BTC-USD". */
export function fromAlpacaSymbol(symbol: string, assetClass?: string) {
  if (symbol.includes("/")) return symbol.replace("/", "-");
  if (assetClass === "crypto" && symbol.endsWith("USD")) return `${symbol.slice(0, -3)}-USD`;
  return symbol;
}
export const toAlpacaSymbol = (symbol: string) => (assetClassOf(symbol) === "crypto" ? symbol.replace("-", "/") : symbol);

/** Thrown for futures on a real (Alpaca) account. */
export const futuresDemoOnly = () =>
  unprocessable("futures_demo_only", "Futures trade in the demo account only: Alpaca doesn't offer futures. Switch to your demo account to trade them.");

/**
 * Trades the user's own Alpaca account with their own API keys (paper by default).
 * Live accounts additionally require ALLOW_LIVE_TRADING=true on the server.
 */
export function alpacaBroker(ctx: Ctx, userId: string, creds: { keyId: string; secretKey: string; env: "paper" | "live" }): Broker {
  if (creds.env === "live" && !ctx.config.ALLOW_LIVE_TRADING) {
    throw new HttpError(403, "live_trading_disabled", "Live trading is disabled on this server. Use Alpaca paper keys.");
  }
  const base = creds.env === "live" ? ALPACA_LIVE : ALPACA_PAPER;
  const call = <T>(path: string, init?: { method?: string; body?: unknown }) => alpacaRequest<T>(base, creds, path, init);

  function toView(o: AlpacaOrder, local?: OrderRow): OrderView {
    return {
      id: local?.id ?? o.id,
      symbol: fromAlpacaSymbol(o.symbol),
      side: o.side,
      type: o.type === "limit" ? "limit" : "market",
      qty: num(o.qty) ?? 0,
      limitPrice: num(o.limit_price),
      status: o.status,
      filledQty: num(o.filled_qty) ?? 0,
      filledAvgPrice: num(o.filled_avg_price),
      source: local?.source ?? "manual",
      placedBy: local?.placed_by ?? "user",
      rejectReason: null,
      createdAt: o.created_at,
    };
  }

  /**
   * Brings Aurex's copy of an order up to date and records its execution once it's final. Profit or
   * loss stays unknown: Aurex may not have seen the account's earlier trades (Alpaca reports it per position).
   */
  function syncOrder(o: AlpacaOrder, local: OrderRow | undefined) {
    const filledQty = num(o.filled_qty) ?? 0;
    const avg = num(o.filled_avg_price);
    if (local && (local.status !== o.status || local.filled_qty !== filledQty)) {
      run(
        ctx.db,
        "UPDATE orders SET status = ?, filled_qty = ?, filled_avg_price = ?, updated_at = ? WHERE id = ?",
        o.status,
        filledQty,
        avg,
        nowIso(),
        local.id,
      );
    }
    if (!FINAL.has(o.status) || !(filledQty > 0) || !avg) return;
    recordFill(ctx, {
      userId,
      broker: "alpaca",
      accountType: creds.env === "live" ? "real" : "demo",
      orderRef: o.id,
      orderId: local?.id ?? null,
      symbol: fromAlpacaSymbol(o.symbol, o.asset_class),
      side: o.side,
      qty: filledQty,
      price: avg,
      realizedCents: null,
      placedBy: local?.placed_by ?? "user",
      source: local?.source ?? "manual",
      executedAt: o.filled_at ?? o.updated_at ?? o.created_at,
    });
  }

  return {
    id: "alpaca",

    async account(): Promise<AccountView> {
      const [acct, positions] = await Promise.all([
        call<{ cash: string; equity: string; buying_power: string; last_equity: string }>("/v2/account"),
        call<
          {
            symbol: string;
            asset_class?: string;
            qty: string;
            avg_entry_price: string;
            current_price: string;
            market_value: string;
            cost_basis: string;
            unrealized_pl: string;
            unrealized_plpc: string;
          }[]
        >("/v2/positions"),
      ]);
      return {
        broker: "alpaca",
        live: creds.env === "live",
        currency: "USD",
        cash: Number(acct.cash),
        equity: Number(acct.equity),
        buyingPower: Number(acct.buying_power),
        marginUsed: 0,
        startingCash: null,
        totalReturnPct: null,
        positions: positions.map((p) => {
          const symbol = fromAlpacaSymbol(p.symbol, p.asset_class);
          const qty = Number(p.qty);
          return {
            symbol,
            assetClass: assetClassOf(symbol),
            qty,
            side: qty < 0 ? ("short" as const) : ("long" as const),
            avgCost: Number(p.avg_entry_price),
            price: Number(p.current_price),
            marketValue: Number(p.market_value),
            notional: Math.abs(Number(p.market_value)),
            multiplier: 1,
            margin: 0,
            costBasis: Number(p.cost_basis),
            unrealizedPl: Number(p.unrealized_pl),
            unrealizedPlPct: Math.round(Number(p.unrealized_plpc) * 10000) / 100,
          };
        }),
      };
    },

    async placeOrder(input: OrderInput): Promise<OrderView> {
      const cls = assetClassOf(input.symbol);
      if (cls === "future") throw futuresDemoOnly();
      const o = await call<AlpacaOrder>("/v2/orders", {
        method: "POST",
        body: {
          symbol: toAlpacaSymbol(input.symbol),
          qty: String(input.qty),
          side: input.side,
          type: input.type,
          // Crypto trades around the clock, so its orders stay open until filled or canceled.
          time_in_force: cls === "crypto" ? "gtc" : "day",
          ...(input.type === "limit" ? { limit_price: String(input.limitPrice) } : {}),
        },
      });
      const id = newId("ord");
      const now = nowIso();
      run(
        ctx.db,
        `INSERT INTO orders (id, user_id, broker, broker_order_id, symbol, side, type, qty, limit_price, status, source, signal_id, placed_by, created_at, updated_at)
         VALUES (?, ?, 'alpaca', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        o.id,
        input.symbol,
        input.side,
        input.type,
        input.qty,
        input.limitPrice ?? null,
        o.status,
        input.source,
        input.signalId ?? null,
        input.placedBy ?? "user",
        now,
        now,
      );
      return toView(o, one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ?", id));
    },

    async listOrders() {
      const remote = await call<AlpacaOrder[]>("/v2/orders?status=all&limit=100&direction=desc");
      const locals = new Map(
        all<OrderRow>(ctx.db, "SELECT * FROM orders WHERE user_id = ? AND broker = 'alpaca'", userId).map((o) => [o.broker_order_id, o]),
      );
      for (const o of remote) syncOrder(o, locals.get(o.id));
      return remote.map((o) => toView(o, locals.get(o.id)));
    },

    async cancelOrder(id: string) {
      const local = one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ? AND user_id = ?", id, userId);
      const brokerId = local?.broker_order_id ?? id;
      await call<void>(`/v2/orders/${encodeURIComponent(brokerId)}`, { method: "DELETE" });
      if (local) run(ctx.db, "UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?", nowIso(), local.id);
      const o = await call<AlpacaOrder>(`/v2/orders/${encodeURIComponent(brokerId)}`);
      return local ? { ...orderView(local), status: o.status } : toView(o);
    },
  };
}
