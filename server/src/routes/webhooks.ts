import { Router } from "express";
import type { Ctx } from "../context.js";
import { completeDeposit, failDeposit, findExternalByProviderRef } from "../services/payments.js";
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

  return r;
}
