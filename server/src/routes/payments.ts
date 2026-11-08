import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { assertCurrency, fromMinor, toMinor } from "../lib/money.js";
import { rateLimit } from "../lib/rateLimit.js";
import { amountField, currencyField, idempotencyField, parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { quote } from "../services/fx.js";
import { getBalances } from "../services/ledger.js";
import {
  closeRequest,
  convert,
  createRequest,
  deposit,
  getExternalForUser,
  listActivity,
  listExternal,
  listRequests,
  payRequest,
  sendMoney,
  withdraw,
} from "../services/payments.js";
import { audit, searchUsers } from "../services/users.js";

const SendBody = z.object({
  to: z.string().trim().min(2).max(200),
  amount: amountField,
  currency: currencyField,
  memo: z.string().max(140).optional(),
  idempotencyKey: idempotencyField,
});

const RequestBody = z.object({
  from: z.string().trim().min(2).max(200),
  amount: amountField,
  currency: currencyField,
  memo: z.string().max(140).optional(),
});

const ConvertBody = z.object({
  from: currencyField,
  to: currencyField,
  amount: amountField,
  idempotencyKey: idempotencyField,
});

const DepositBody = z.object({
  rail: z.string().min(2).max(30),
  amount: amountField,
  currency: currencyField,
});

const WithdrawBody = z.object({
  rail: z.string().min(2).max(30),
  amount: amountField,
  currency: currencyField,
  idempotencyKey: idempotencyField,
  destination: z.object({
    type: z.enum(["bank_account", "mobile_money", "card"]),
    name: z.string().trim().min(2).max(80),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9 +-]{4,34}$/, "4-34 letters or digits"),
    bankCode: z.string().trim().max(20).optional(),
    country: z.string().trim().length(2).optional(),
  }),
});

export function paymentRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const moneyLimiter = rateLimit({
    name: "money",
    windowMs: 60_000,
    max: ctx.config.isTest ? 10_000 : 30,
    key: (req) => req.user!.id,
  });

  r.get("/balances", (req, res) => {
    const balances = getBalances(ctx, req.user!.id).map((b) => ({
      currency: b.currency,
      balance: fromMinor(b.balance, b.currency),
      balanceMinor: b.balance,
    }));
    if (!balances.some((b) => b.currency === req.user!.defaultCurrency)) {
      balances.unshift({ currency: req.user!.defaultCurrency, balance: fromMinor(0, req.user!.defaultCurrency), balanceMinor: 0 });
    }
    res.json({ balances });
  });

  r.get("/activity", (req, res) => {
    const limit = Number(req.query.limit) || undefined;
    const before = req.query.before ? Number(req.query.before) : undefined;
    res.json(listActivity(ctx, req.user!.id, { limit, before }));
  });

  r.get("/users/search", (req, res) => {
    res.json({ users: searchUsers(ctx, String(req.query.q ?? ""), req.user!.id) });
  });

  r.post("/send", moneyLimiter, async (req, res) => {
    const body = parse(SendBody, req.body);
    const transfer = await sendMoney(ctx, {
      senderId: req.user!.id,
      to: body.to,
      currency: body.currency,
      amountMinor: toMinor(body.amount, body.currency),
      memo: body.memo,
      idempotencyKey: body.idempotencyKey,
    });
    audit(ctx, req.user!.id, "payments.send", { transferId: transfer.id, to: transfer.to.id, amount: transfer.amount, currency: transfer.currency }, req.ip);
    res.status(201).json({ transfer });
  });

  r.get("/requests", (req, res) => {
    res.json(listRequests(ctx, req.user!.id));
  });

  r.post("/requests", moneyLimiter, (req, res) => {
    const body = parse(RequestBody, req.body);
    const request = createRequest(ctx, {
      requesterId: req.user!.id,
      from: body.from,
      currency: body.currency,
      amountMinor: toMinor(body.amount, body.currency),
      memo: body.memo,
    });
    res.status(201).json({ request });
  });

  r.post("/requests/:id/pay", moneyLimiter, async (req, res) => {
    const request = await payRequest(ctx, req.user!.id, String(req.params.id));
    audit(ctx, req.user!.id, "payments.request_paid", { requestId: request.id }, req.ip);
    res.json({ request });
  });

  r.post("/requests/:id/decline", (req, res) => {
    res.json({ request: closeRequest(ctx, req.user!.id, req.params.id, "decline") });
  });

  r.post("/requests/:id/cancel", (req, res) => {
    res.json({ request: closeRequest(ctx, req.user!.id, req.params.id, "cancel") });
  });

  r.get("/fx/quote", async (req, res) => {
    const from = assertCurrency(String(req.query.from ?? "")).code;
    const to = assertCurrency(String(req.query.to ?? "")).code;
    const amountMinor = toMinor(String(req.query.amount ?? "1"), from);
    const q = await quote(ctx, from, to, amountMinor);
    res.json({ quote: { ...q, amount: fromMinor(amountMinor, from), toAmount: fromMinor(q.toAmountMinor, to) } });
  });

  r.post("/convert", moneyLimiter, async (req, res) => {
    const body = parse(ConvertBody, req.body);
    const result = await convert(ctx, {
      userId: req.user!.id,
      from: body.from,
      to: body.to,
      amountMinor: toMinor(body.amount, body.from),
      idempotencyKey: body.idempotencyKey,
    });
    audit(ctx, req.user!.id, "payments.convert", { id: result.id }, req.ip);
    res.status(201).json({
      conversion: { ...result, fromAmount: fromMinor(result.fromAmount, body.from), toAmount: fromMinor(result.toAmount, body.to) },
    });
  });

  r.get("/transfers", (req, res) => {
    res.json({ transfers: listExternal(ctx, req.user!.id) });
  });

  r.get("/transfers/:id", (req, res) => {
    res.json({ transfer: getExternalForUser(ctx, req.user!.id, req.params.id) });
  });

  r.post("/deposits", moneyLimiter, async (req, res) => {
    const body = parse(DepositBody, req.body);
    const result = await deposit(ctx, {
      userId: req.user!.id,
      rail: body.rail,
      currency: body.currency,
      amountMinor: toMinor(body.amount, body.currency),
    });
    audit(ctx, req.user!.id, "payments.deposit", { id: result.transfer.id, rail: body.rail }, req.ip);
    res.status(201).json(result);
  });

  r.post("/withdrawals", moneyLimiter, async (req, res) => {
    const body = parse(WithdrawBody, req.body);
    const transfer = await withdraw(ctx, {
      userId: req.user!.id,
      rail: body.rail,
      currency: body.currency,
      amountMinor: toMinor(body.amount, body.currency),
      destination: body.destination,
      idempotencyKey: body.idempotencyKey,
    });
    audit(ctx, req.user!.id, "payments.withdraw", { id: transfer.id, rail: body.rail }, req.ip);
    res.status(201).json({ transfer });
  });

  return r;
}
