import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { catalogue } from "../services/connections/registry.js";
import { DEMO_BANKS, sandboxAggregator } from "../services/connections/sandbox.js";
import { completeLink, disconnect, overview, startLink, syncConnection } from "../services/connections/store.js";

const CompleteBody = z.object({ params: z.record(z.string().max(64), z.string().max(2000)).default({}) });

/** Providers whose OAuth apps need one fixed redirect URI (the link id travels in `state`). */
const OAUTH_PROVIDERS = new Set(["coinbase"]);

export function connectionRoutes(ctx: Ctx) {
  const r = Router();

  /**
   * OAuth redirect target. It only forwards the code to the signed-in app page, which finishes the
   * link for the current user; completeLink() checks the link belongs to them and the state nonce.
   */
  r.get("/oauth/:provider/callback", (req, res) => {
    const provider = String(req.params.provider);
    if (!OAUTH_PROVIDERS.has(provider)) throw notFound("Unknown provider");
    const pick = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).slice(0, 2000) : "");
    const state = pick("state");
    const linkId = state.split(".")[0];
    const target = new URL("/app/connections", ctx.config.APP_URL);
    target.searchParams.set("callback", provider);
    if (/^lnk_[A-Za-z0-9_-]{6,64}$/.test(linkId)) target.searchParams.set("link", linkId);
    for (const k of ["code", "state", "error"]) if (pick(k)) target.searchParams.set(k, pick(k));
    res.redirect(302, target.toString());
  });

  r.use(requireAuth);
  const limiter = rateLimit({ name: "connections", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 20, key: (req) => req.user!.id });

  r.get("/providers", (_req, res) => {
    res.json({ providers: catalogue(ctx) });
  });

  r.get("/", async (req, res) => {
    res.json(await overview(ctx, req.user!.id));
  });

  r.get("/sandbox/banks", (_req, res) => {
    if (!sandboxAggregator.configured(ctx)) throw notFound("Demo institutions are only available in sandbox mode");
    res.json({ banks: DEMO_BANKS.map(({ id, name, country, currency, accounts }) => ({ id, name, country, currency, accounts: accounts.length })) });
  });

  r.post("/:provider/start", limiter, async (req, res) => {
    res.status(201).json(await startLink(ctx, req.user!.id, String(req.params.provider)));
  });

  r.post("/links/:id/complete", limiter, async (req, res) => {
    const { params } = parse(CompleteBody, req.body ?? {});
    res.json(await completeLink(ctx, req.user!.id, String(req.params.id), params));
  });

  r.post("/:id/sync", limiter, async (req, res) => {
    const count = await syncConnection(ctx, req.user!.id, String(req.params.id));
    res.json({ accounts: count, ...(await overview(ctx, req.user!.id)) });
  });

  r.delete("/:id", async (req, res) => {
    await disconnect(ctx, req.user!.id, String(req.params.id));
    res.json(await overview(ctx, req.user!.id));
  });

  return r;
}
