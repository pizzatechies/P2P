import { Router } from "express";
import type { Ctx } from "../context.js";
import { safeEqual } from "../lib/crypto.js";
import { findPendingLink, finalizeLink, retryPendingLink } from "../services/connections/store.js";
import { completeDeposit, failDeposit, findExternalById, findExternalByProviderRef, refreshExternal } from "../services/payments.js";
import { verifyStripeSignature } from "../services/rails/stripe.js";

interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; payment_status?: string; client_reference_id?: string } };
}

export function webhookRoutes(ctx: Ctx) {
  const r = Router();

  r.post("/stripe", (req, res) => {
    const secret = ctx.config.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(404).json({ error: { code: "not_found", message: "Stripe webhooks not configured" } });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.get("stripe-signature"), secret)) {
      return res.status(400).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    }
    const event = JSON.parse(raw.toString("utf8")) as StripeEvent;
    const session = event.data?.object;
    const ext = session?.id ? findExternalByProviderRef(ctx, "stripe", session.id) : undefined;

    if (ext) {
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          // "unpaid" means a delayed method (e.g. bank debit); wait for async_payment_succeeded.
          if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
            completeDeposit(ctx, ext.id);
          }
          break;
        case "checkout.session.expired":
          failDeposit(ctx, ext.id, "Checkout expired before payment");
          break;
        case "checkout.session.async_payment_failed":
          failDeposit(ctx, ext.id, "Payment failed");
          break;
      }
    }
    // Always 2xx for verified events so Stripe doesn't retry ones we deliberately ignore.
    res.json({ received: true });
  });

  /**
   * Flutterwave: verified with the verif-hash header, then used only as a trigger. The transfer's
   * real state is fetched from Flutterwave before any money moves.
   */
  r.post("/flutterwave", async (req, res) => {
    const hash = ctx.config.FLUTTERWAVE_WEBHOOK_HASH;
    if (!hash) return res.status(404).json({ error: { code: "not_found", message: "Flutterwave webhooks not configured" } });
    if (!safeEqual(req.get("verif-hash") ?? "", hash)) return res.status(401).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    let body: { event?: string; data?: { id?: number | string; tx_ref?: string; reference?: string } };
    try {
      body = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: { code: "bad_request", message: "Invalid JSON" } });
    }
    const d = body.data ?? {};
    let ext;
    if (body.event === "charge.completed" && d.tx_ref) ext = findExternalById(ctx, d.tx_ref);
    if (body.event === "transfer.completed") {
      ext = (d.reference ? findExternalById(ctx, d.reference) : undefined) ?? (d.id !== undefined ? findExternalByProviderRef(ctx, "flutterwave", String(d.id)) : undefined);
    }
    if (ext && ext.rail === "flutterwave") {
      await refreshExternal(ctx, ext.id).catch((err) => console.warn(`[flutterwave webhook] ${(err as Error).message}`));
    }
    res.json({ received: true });
  });

  /**
   * Plaid: SESSION_FINISHED only tells us a Hosted Link session ended. We look the session up with
   * Plaid ourselves (/link/token/get), so a forged webhook can't create a connection.
   */
  r.post("/plaid", async (req, res) => {
    let body: { webhook_type?: string; webhook_code?: string; link_token?: string };
    try {
      body = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: { code: "bad_request", message: "Invalid JSON" } });
    }
    if (body.webhook_type === "LINK" && body.webhook_code === "SESSION_FINISHED" && body.link_token) {
      const row = findPendingLink(ctx, "plaid", (meta) => meta.linkToken === body.link_token);
      if (row) await retryPendingLink(ctx, row).catch((err) => console.warn(`[plaid webhook] ${(err as Error).message}`));
    }
    res.json({ received: true });
  });

  /** Mono: account_connected confirms a link started with meta.ref = our pending link id. */
  r.post("/mono", async (req, res) => {
    const secret = ctx.config.MONO_WEBHOOK_SECRET;
    if (!secret) return res.status(404).json({ error: { code: "not_found", message: "Mono webhooks not configured" } });
    const header = req.get("mono-webhook-secret") ?? "";
    if (!safeEqual(header, secret)) return res.status(401).json({ error: { code: "bad_signature", message: "Invalid webhook secret" } });
    let body: { event?: string; data?: { id?: string; meta?: { ref?: string } } };
    try {
      body = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ error: { code: "bad_request", message: "Invalid JSON" } });
    }
    const ref = body.data?.meta?.ref;
    if (body.event === "mono.events.account_connected" && body.data?.id && ref) {
      const row = findPendingLink(ctx, "mono", (_meta, r) => r.id === ref);
      if (row) await finalizeLink(ctx, row, { externalId: body.data.id }).catch((err) => console.warn(`[mono webhook] ${(err as Error).message}`));
    }
    res.json({ received: true });
  });

  return r;
}
