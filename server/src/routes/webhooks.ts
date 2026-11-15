import { Router } from "express";
import type { Ctx } from "../context.js";
import { safeEqual } from "../lib/crypto.js";
import { findPendingLink, finalizeLink, retryPendingLink } from "../services/connections/store.js";
import {
  completeDeposit,
  failDeposit,
  findExternalById,
  findExternalByProviderRef,
  refreshExternal,
  reverseWithdrawal,
  settleWithdrawal,
} from "../services/payments.js";
import { mpesaCallbackToken } from "../services/rails/index.js";
import { verifyStripeSignature } from "../services/rails/stripe.js";

interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; payment_status?: string; client_reference_id?: string } };
}

/** Parses a raw webhook body; null when it isn't JSON. */
function jsonBody<T>(raw: unknown): T | null {
  try {
    return JSON.parse((raw as Buffer).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function webhookRoutes(ctx: Ctx) {
  const r = Router();
  const recheck = (id: string, label: string) => refreshExternal(ctx, id).catch((err) => console.warn(`[${label} webhook] ${(err as Error).message}`));

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

  /**
   * M-Pesa (Daraja). Safaricom doesn't sign callbacks, so they're only accepted on a URL containing a
   * secret derived from MASTER_KEY. STK Push results are then confirmed with the STK Push Query API.
   */
  const mpesaToken = () => mpesaCallbackToken(ctx);
  const mpesaAck = { ResultCode: 0, ResultDesc: "Accepted" };

  r.post("/mpesa/:token/stk", async (req, res) => {
    if (!safeEqual(String(req.params.token), mpesaToken())) return res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    const body = jsonBody<{ Body?: { stkCallback?: { CheckoutRequestID?: string } } }>(req.body);
    const checkoutId = body?.Body?.stkCallback?.CheckoutRequestID;
    const ext = checkoutId ? findExternalByProviderRef(ctx, "mpesa", checkoutId) : undefined;
    if (ext) await recheck(ext.id, "mpesa");
    res.json(mpesaAck);
  });

  /** B2C results can't be looked up through the API, so this callback settles the payout. */
  r.post("/mpesa/:token/b2c/result", (req, res) => {
    if (!safeEqual(String(req.params.token), mpesaToken())) return res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    const result = jsonBody<{
      Result?: { ResultCode?: number | string; ResultDesc?: string; OriginatorConversationID?: string; ConversationID?: string };
    }>(req.body)?.Result;
    const ext = result?.OriginatorConversationID ? findExternalById(ctx, result.OriginatorConversationID) : undefined;
    // The conversation id must match what Safaricom gave us when the payout was accepted (it can be
    // missing only if the result raced ahead of our own bookkeeping).
    if (result && ext && ext.rail === "mpesa" && ext.direction === "withdrawal" && (!ext.provider_ref || ext.provider_ref === result.ConversationID)) {
      if (String(result.ResultCode) === "0") settleWithdrawal(ctx, ext.id);
      else reverseWithdrawal(ctx, ext.id, `M-Pesa: ${result.ResultDesc ?? "payout failed"}`.slice(0, 300));
    }
    res.json(mpesaAck);
  });

  /** The request timed out in Safaricom's queue; its outcome is unknown, so it stays pending for review. */
  r.post("/mpesa/:token/b2c/timeout", (req, res) => {
    if (!safeEqual(String(req.params.token), mpesaToken())) return res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    const result = jsonBody<{ Result?: { OriginatorConversationID?: string } }>(req.body)?.Result;
    console.warn(`[mpesa webhook] B2C queue timeout for ${result?.OriginatorConversationID ?? "unknown payout"}; left pending for review`);
    res.json(mpesaAck);
  });

  /** MTN MoMo calls back (PUT or POST) with our externalId; the status is then read from MoMo itself. */
  const momo = async (req: import("express").Request, res: import("express").Response) => {
    const body = jsonBody<{ externalId?: string }>(req.body);
    const ext = body?.externalId ? findExternalById(ctx, body.externalId) : undefined;
    if (ext && ext.rail === "mtn-momo") await recheck(ext.id, "mtn-momo");
    res.json({ received: true });
  };
  r.post("/mtn-momo", momo);
  r.put("/mtn-momo", momo);

  /** PayPal: order, capture and payout events only trigger a re-check through PayPal's API. */
  r.post("/paypal", async (req, res) => {
    const body = jsonBody<{
      event_type?: string;
      resource?: {
        id?: string;
        custom_id?: string;
        supplementary_data?: { related_ids?: { order_id?: string } };
        payout_batch_id?: string;
        payout_item?: { sender_item_id?: string };
        batch_header?: { payout_batch_id?: string };
      };
    }>(req.body);
    if (!body) return res.status(400).json({ error: { code: "bad_request", message: "Invalid JSON" } });
    const rsc = body.resource ?? {};
    const type = body.event_type ?? "";
    let ext;
    if (type.startsWith("CHECKOUT.ORDER.") && rsc.id) ext = findExternalByProviderRef(ctx, "paypal", rsc.id);
    else if (type.startsWith("PAYMENT.CAPTURE.")) {
      const orderId = rsc.supplementary_data?.related_ids?.order_id;
      ext = (orderId ? findExternalByProviderRef(ctx, "paypal", orderId) : undefined) ?? (rsc.custom_id ? findExternalById(ctx, rsc.custom_id) : undefined);
    } else if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
      ext = (rsc.payout_item?.sender_item_id ? findExternalById(ctx, rsc.payout_item.sender_item_id) : undefined) ?? (rsc.payout_batch_id ? findExternalByProviderRef(ctx, "paypal", rsc.payout_batch_id) : undefined);
    } else if (type.startsWith("PAYMENT.PAYOUTSBATCH.") && rsc.batch_header?.payout_batch_id) {
      ext = findExternalByProviderRef(ctx, "paypal", rsc.batch_header.payout_batch_id);
    }
    if (ext && ext.rail === "paypal") await recheck(ext.id, "paypal");
    res.json({ received: true });
  });

  return r;
}
