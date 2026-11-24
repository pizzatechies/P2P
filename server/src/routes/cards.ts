import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { toMinor } from "../lib/money.js";
import { parse } from "../lib/validate.js";
import { requireAuth, requireRecentAuth } from "../middleware/auth.js";
import { cardKey, cardOverview, issueCard, setCardDesign, setCardLimit, setCardStatus } from "../services/cards.js";

const Application = z.object({
  name: z.string().trim().min(3).max(80),
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2),
  phone: z.string().trim().max(20).optional(),
  design: z.enum(["gold", "black"]).default("gold"),
  acceptTerms: z.literal(true, { message: "Please accept the card terms" }),
});

export function cardRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const keyLimiter = rateLimit({ name: "card-key", windowMs: 10 * 60_000, max: ctx.config.isTest ? 1000 : 10, key: (req) => req.user!.id });

  /** The customer's card, its phone wallets and recent card payments (or what's needed to get one). */
  r.get("/", (req, res) => {
    res.json(cardOverview(ctx, req.user!.id));
  });

  r.post("/", requireRecentAuth(ctx), async (req, res) => {
    const body = parse(Application, req.body);
    res.status(201).json(await issueCard(ctx, req.user!.id, body, req.ip));
  });

  // Freezing is always allowed straight away; turning a card back on asks for the password again.
  r.post("/:id/freeze", async (req, res) => {
    res.json(await setCardStatus(ctx, req.user!.id, String(req.params.id), "freeze", req.ip));
  });
  r.post("/:id/unfreeze", requireRecentAuth(ctx), async (req, res) => {
    res.json(await setCardStatus(ctx, req.user!.id, String(req.params.id), "unfreeze", req.ip));
  });
  r.post("/:id/cancel", async (req, res) => {
    res.json(await setCardStatus(ctx, req.user!.id, String(req.params.id), "cancel", req.ip));
  });

  r.put("/:id/design", (req, res) => {
    const { design } = parse(z.object({ design: z.enum(["gold", "black"]) }), req.body);
    res.json(setCardDesign(ctx, req.user!.id, String(req.params.id), design));
  });

  r.put("/:id/limit", (req, res) => {
    const { daily } = parse(z.object({ daily: z.union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.null()]) }), req.body);
    res.json(setCardLimit(ctx, req.user!.id, String(req.params.id), daily === null ? null : toMinor(daily, ctx.config.CARD_CURRENCY)));
  });

  /** A short-lived key to show the card number in Stripe's secure fields, or to add the card to a wallet. */
  r.post("/:id/key", keyLimiter, requireRecentAuth(ctx), async (req, res) => {
    const { nonce } = parse(z.object({ nonce: z.string().min(8).max(200).optional() }), req.body);
    res.json(await cardKey(ctx, req.user!.id, String(req.params.id), nonce, req.ip));
  });

  return r;
}
