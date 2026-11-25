import { Router } from "express";
import { businessPeople } from "../services/business.js";
import { applyPersonResult } from "../services/kybPeople.js";
import { applySmileResult } from "../services/kyc.js";
import { verifySmileSignature, type SmileWebhook } from "../services/smileid.js";
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
import { getRails, mpesaCallbackToken } from "../services/rails/index.js";
import { skrillOutcome, verifySkrillSignature } from "../services/rails/skrill.js";
import { verifyStripeSignature } from "../services/rails/stripe.js";
import { applyTapPayment } from "../services/tapToPay.js";
import { applyAuthorizationUpdate, applyCardUpdate, applyToken, applyTransaction, decideAuthorization, handleBitnobEvent, type BitnobEvent, type StripeAuthorization, type StripeToken, type StripeTransaction } from "../services/cards.js";
import { verifyWebhook as verifyBitnobWebhook } from "../services/cardIssuers/bitnob.js";

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

  /** Smile ID results (identity checks against government records). Signed with the account's API key. */
  r.post("/smileid", (req, res) => {
    if (!verifySmileSignature(ctx, req.get("Response-Signature") ?? undefined, req.get("Response-Timestamp") ?? undefined)) {
      res.status(401).json({ error: { code: "bad_signature", message: "Invalid signature" } });
      return;
    }
    const payload = jsonBody<SmileWebhook>(req.body);
    if (!payload) {
      res.status(400).json({ error: { code: "bad_request", message: "Expected JSON" } });
      return;
    }
    // A company director's or owner's check, or a customer's own.
    if (payload.partner_params?.aurex_kind === "person") applyPersonResult(ctx, payload, businessPeople(ctx));
    else applySmileResult(ctx, payload);
    res.json({ received: true });
  });

  r.post("/stripe", (req, res) => {
    const secret = ctx.config.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(404).json({ error: { code: "not_found", message: "Stripe webhooks not configured" } });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.get("stripe-signature"), secret)) {
      return res.status(400).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    }
    const event = JSON.parse(raw.toString("utf8")) as StripeEvent;
    const session = event.data?.object;
    // Tap to Pay payments (card-present PaymentIntents created for a business).
    const intent = event.data?.object as unknown as { id?: string; status?: string; metadata?: Record<string, string> } | undefined;
    if (event.type?.startsWith("payment_intent.") && intent?.id && intent.metadata?.aurex_tap_payment) {
      applyTapPayment(ctx, { id: intent.id, status: intent.status, metadata: intent.metadata });
      return res.json({ received: true });
    }
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
   * Aurex cards on Bitnob (prepaid cards for Africa). Signed with HMAC-SHA512 of the raw body; a 2xx
   * tells Bitnob it was delivered, so errors answer 500 to have it retried.
   */
  r.post("/bitnob", async (req, res) => {
    const secret = ctx.config.BITNOB_WEBHOOK_SECRET;
    if (!secret || ctx.config.cardIssuer !== "bitnob") return res.status(404).json({ error: { code: "not_found", message: "Card webhooks not configured" } });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyBitnobWebhook(raw, req.get("x-bitnob-signature"), secret)) {
      return res.status(401).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    }
    let event: BitnobEvent;
    try {
      event = JSON.parse(raw.toString("utf8")) as BitnobEvent;
    } catch {
      return res.status(400).json({ error: { code: "bad_request", message: "Not JSON" } });
    }
    try {
      await handleBitnobEvent(ctx, event);
    } catch (err) {
      console.error(`[cards] bitnob ${event.event ?? "event"} ${event.event_id ?? ""}: ${(err as Error).message}`);
      return res.status(500).json({ error: { code: "retry", message: "Couldn't process the event yet" } });
    }
    res.json({ received: true });
  });

  /**
   * Aurex cards (Stripe Issuing). `issuing_authorization.request` is answered in the response itself,
   * within Stripe's two seconds: approved only if the money is in the customer's wallet (and held).
   */
  r.post("/stripe-issuing", async (req, res) => {
    const secret = ctx.config.STRIPE_ISSUING_WEBHOOK_SECRET;
    if (!secret || ctx.config.cardIssuer !== "stripe") return res.status(404).json({ error: { code: "not_found", message: "Card webhooks not configured" } });
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.get("stripe-signature"), secret)) {
      return res.status(400).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    }
    const event = JSON.parse(raw.toString("utf8")) as { type?: string; data?: { object?: unknown } };
    const obj = event.data?.object;
    if (!obj || typeof obj !== "object") return res.json({ received: true });
    switch (event.type) {
      case "issuing_authorization.request": {
        let approved = false;
        try {
          approved = (await decideAuthorization(ctx, obj as StripeAuthorization)).approved;
        } catch (err) {
          console.error(`[cards] authorization ${(obj as { id?: string }).id}: ${(err as Error).message}`);
        }
        res.set("Stripe-Version", ctx.config.STRIPE_API_VERSION).json({ approved });
        return;
      }
      case "issuing_authorization.created":
      case "issuing_authorization.updated":
        applyAuthorizationUpdate(ctx, obj as StripeAuthorization);
        break;
      case "issuing_transaction.created":
        applyTransaction(ctx, obj as StripeTransaction);
        break;
      case "issuing_token.created":
      case "issuing_token.updated":
        applyToken(ctx, obj as StripeToken);
        break;
      case "issuing_card.updated":
        applyCardUpdate(ctx, obj as { id: string; status?: string });
        break;
    }
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
  // Optional second lock: only Safaricom's published callback IPs (MPESA_CALLBACK_IPS).
  r.use("/mpesa", (req, res, next) => {
    const allow = ctx.config.mpesaCallbackIps;
    const ip = (req.ip ?? "").replace(/^::ffff:/, "");
    if (allow.size > 0 && !allow.has(ip)) {
      console.warn(`[mpesa webhook] refused callback from ${ip || "unknown address"}`);
      return res.status(403).json({ error: { code: "forbidden", message: "Not allowed" } });
    }
    next();
  });

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

  /** Airtel Money calls back with our transaction id; the result is then read from Airtel itself. */
  r.post("/airtel", async (req, res) => {
    const body = jsonBody<{ transaction?: { id?: string } }>(req.body);
    const id = body?.transaction?.id;
    const ext = id ? findExternalById(ctx, String(id)) : undefined;
    if (ext && ext.rail === "airtel") await recheck(ext.id, "airtel");
    res.json({ received: true });
  });

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

  /**
   * Skrill status notification (form-encoded). Its md5sig is checked with the secret word; then the
   * transaction is re-checked through the query API, or (without an API password) settled from the
   * verified notification, matching the currency and amount Aurex asked for.
   */
  r.post("/skrill", async (req, res) => {
    const secret = ctx.config.SKRILL_SECRET_WORD;
    if (!secret || !ctx.config.SKRILL_EMAIL) return res.status(404).json({ error: { code: "not_found", message: "Skrill isn't configured" } });
    const fields = new URLSearchParams((req.body as Buffer).toString("utf8"));
    if (!verifySkrillSignature(fields, secret)) return res.status(400).json({ error: { code: "bad_signature", message: "Invalid signature" } });
    if ((fields.get("pay_to_email") ?? "").toLowerCase() !== ctx.config.SKRILL_EMAIL.toLowerCase()) return res.status(400).json({ error: { code: "bad_request", message: "Wrong merchant" } });
    const ext = findExternalById(ctx, fields.get("transaction_id") ?? "");
    if (ext && ext.rail === "skrill" && ext.direction === "deposit") {
      if (ctx.config.SKRILL_API_PASSWORD && getRails(ctx).get("skrill")?.checkDeposit) await recheck(ext.id, "skrill");
      else {
        const outcome = skrillOutcome(fields.get("status"), fields.get("currency"), fields.get("amount"), ext.currency, ext.amount);
        if (outcome === "completed") completeDeposit(ctx, ext.id);
        else if (outcome === "failed") failDeposit(ctx, ext.id, "The Skrill payment wasn't completed");
      }
      if (fields.get("status") === "-3") console.warn(`[skrill webhook] chargeback reported for ${ext.id}; review it in the admin tools`);
    }
    res.send("OK");
  });

  return r;
}
