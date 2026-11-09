import type { Ctx } from "../../../context.js";
import { all, nowIso, one, run } from "../../../db/index.js";
import { HttpError, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import type { OrderRow } from "./paper.js";
import { orderView } from "./paper.js";
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
}

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
      symbol: o.symbol,
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

  return {
    id: "alpaca",

    async account(): Promise<AccountView> {
      const [acct, positions] = await Promise.all([
        call<{ cash: string; equity: string; buying_power: string; last_equity: string }>("/v2/account"),
        call<
          {
            symbol: string;
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
        startingCash: null,
        totalReturnPct: null,
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: Number(p.qty),
          avgCost: Number(p.avg_entry_price),
          price: Number(p.current_price),
          marketValue: Number(p.market_value),
          costBasis: Number(p.cost_basis),
          unrealizedPl: Number(p.unrealized_pl),
          unrealizedPlPct: Math.round(Number(p.unrealized_plpc) * 10000) / 100,
        })),
      };
    },

    async placeOrder(input: OrderInput): Promise<OrderView> {
      const o = await call<AlpacaOrder>("/v2/orders", {
        method: "POST",
        body: {
          symbol: input.symbol,
          qty: String(input.qty),
          side: input.side,
          type: input.type,
          time_in_force: "day",
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
