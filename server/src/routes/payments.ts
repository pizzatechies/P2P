import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { assertCurrency, fromMinor, toMinor } from "../lib/money.js";
import { rateLimit } from "../lib/rateLimit.js";
import { amountField, currencyField, idempotencyField, parse } from "../lib/validate.js";
import { badRequest } from "../lib/errors.js";
import { requireAuth, requireRecentAuth } from "../middleware/auth.js";
import { toUsdMinor } from "../services/fx.js";
import { assertEmailVerified } from "../services/email.js";
import { assertNoSecurityHold, assertRecentAuth } from "../services/security.js";
import { getRail } from "../services/rails/index.js";
import { quote } from "../services/fx.js";
import { getBalances } from "../services/ledger.js";
import {
  closeRequest,
  convert,
  createRequest,
  splitBill,
  deposit,
  getExternalForUser,
  listActivity,
  listExternal,
  listRequests,
  payRequest,
  refreshExternal,
  requestAmountFor,
  sendMoney,
  withdraw,
} from "../services/payments.js";
import { audit, getUserRow, searchUsers } from "../services/users.js";

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

const SplitBody = z.object({
  with: z.array(z.string().trim().min(2).max(200)).min(1).max(20),
  total: amountField,
  currency: currencyField,
  memo: z.string().max(140).optional(),
  includeMe: z.boolean().default(true),
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
  phone: z.string().trim().max(20).optional(),
});

const detailsField = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,59}$/), z.string().trim().max(140))
  .refine((d) => Object.keys(d).length <= 40, "Too many fields");

const WithdrawBody = z.object({
  rail: z.string().min(2).max(30),
  amount: amountField,
  currency: currencyField,
  idempotencyKey: idempotencyField,
  destination: z
    .object({
      type: z.enum(["bank_account", "mobile_money", "card", "email", "wise", "cash_pickup"]),
      name: z.string().trim().min(2).max(80),
      accountNumber: z.string().trim().regex(/^[A-Za-z0-9 +-]{4,34}$/, "4-34 letters or digits").optional(),
      bankCode: z.string().trim().max(20).optional(),
      country: z.string().trim().length(2).optional(),
      email: z
        .string()
        .trim()
        .max(120)
        .regex(/^([^\s@]+@[^\s@]+\.[^\s@]{2,}|\+?[\d\s-]{7,20})$/, "Enter an email address or phone number")
        .optional(),
      wallet: z.enum(["paypal", "venmo"]).optional(),
      wiseType: z.string().trim().regex(/^[a-z0-9_]{2,40}$/i).optional(),
      details: detailsField.optional(),
      firstName: z.string().trim().max(40).regex(/^[\p{L}\p{M}' .-]+$/u, "Use the name as written on the ID").optional(),
      lastName: z.string().trim().max(40).regex(/^[\p{L}\p{M}' .-]+$/u, "Use the name as written on the ID").optional(),
    })
    .superRefine((d, issue) => {
      const need = (ok: unknown, path: string, message: string) => ok || issue.addIssue({ code: "custom", path: [path], message });
      if (d.type === "email") need(d.email, "email", "Enter the email address or phone number");
      else if (d.type === "cash_pickup") {
        need(d.firstName, "firstName", "Enter the recipient's first name");
        need(d.lastName, "lastName", "Enter the recipient's last name");
        need(d.country, "country", "Choose the pickup country");
      }
      else if (d.type === "wise") {
        need(d.wiseType, "wiseType", "Choose how to receive the money");
        need(d.details && Object.keys(d.details).length, "details", "Fill in the bank details");
      } else need(d.accountNumber, "accountNumber", "Enter the account or phone number");
    }),
});

const RequirementsBody = z.object({
  rail: z.string().min(2).max(30),
  currency: currencyField,
  amount: amountField,
  quoteId: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  type: z.string().trim().regex(/^[a-z0-9_]{2,40}$/i).optional(),
  details: detailsField.optional(),
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
  const requirementsLimiter = rateLimit({
    name: "payout-requirements",
    windowMs: 60_000,
    max: ctx.config.isTest ? 10_000 : 40,
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

  /**
   * Large sends to other users need a recent password/2FA check and are paused during a security
   * hold, so a stolen session (or a just-hijacked account) can't move big amounts.
   */
  async function stepUpForSend(req: import("express").Request, currency: string, amountMinor: number) {
    const usdMinor = await toUsdMinor(ctx, currency.toUpperCase(), amountMinor);
    if (usdMinor < ctx.config.STEP_UP_SEND_USD * 100) return;
    assertNoSecurityHold(getUserRow(ctx, req.user!.id));
    assertRecentAuth(ctx, req.reauthAt);
  }

  r.post("/send", moneyLimiter, async (req, res) => {
    const body = parse(SendBody, req.body);
    await stepUpForSend(req, body.currency, toMinor(body.amount, body.currency));
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

  /** Split a bill: an equal-share request to each person, created together. */
  r.post("/requests/split", moneyLimiter, (req, res) => {
    const body = parse(SplitBody, req.body);
    const result = splitBill(ctx, {
      requesterId: req.user!.id,
      with: body.with,
      currency: body.currency,
      totalMinor: toMinor(body.total, body.currency),
      memo: body.memo,
      includeMe: body.includeMe,
    });
    audit(ctx, req.user!.id, "payments.bill_split", { requests: result.requests.length }, req.ip);
    res.status(201).json(result);
  });

  r.post("/requests/:id/pay", moneyLimiter, async (req, res) => {
    const due = requestAmountFor(ctx, req.user!.id, String(req.params.id));
    await stepUpForSend(req, due.currency, due.amountMinor);
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

  r.post("/transfers/:id/refresh", async (req, res) => {
    res.json({ transfer: await refreshExternal(ctx, String(req.params.id), req.user!.id) });
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
      phone: body.phone,
    });
    audit(ctx, req.user!.id, "payments.deposit", { id: result.transfer.id, rail: body.rail }, req.ip);
    res.status(201).json(result);
  });

  /** Fields a provider needs for a payout (e.g. Wise bank details for a country), refreshed as the user fills them in. */
  r.post("/payout-requirements", requirementsLimiter, async (req, res) => {
    const body = parse(RequirementsBody, req.body);
    const currency = body.currency.toUpperCase();
    const rail = getRail(ctx, body.rail, "withdrawal", currency);
    if (!rail.payoutRequirements) throw badRequest(`${rail.name} doesn't need extra details`);
    res.json(
      await rail.payoutRequirements({
        currency,
        amount: toMinor(body.amount, currency),
        quoteId: body.quoteId,
        type: body.type,
        details: body.details,
      }),
    );
  });

  // Money leaving Aurex always needs a recent password/2FA check and no active security hold.
  r.post("/withdrawals", moneyLimiter, requireRecentAuth(ctx), async (req, res) => {
    const me = getUserRow(ctx, req.user!.id);
    assertEmailVerified(ctx, me, "withdraw");
    assertNoSecurityHold(me);
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
