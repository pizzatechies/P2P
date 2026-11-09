import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { openSse } from "../lib/sse.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  historyFor,
  listConversations,
} from "../services/ai/conversations.js";
import { freeUsage } from "../services/ai/allowance.js";
import { authorizeUse, listModels, providerStatus, streamChat } from "../services/ai/gateway.js";
import type { Usage } from "../services/ai/types.js";

const SYSTEM_PROMPT =
  "You are the assistant inside Aurex, an app for peer-to-peer payments, AI tools and AI-assisted investing. " +
  "Be accurate, concise and practical. Format answers in Markdown when it helps readability. " +
  "When asked about investing, give balanced, educational information and be clear that it isn't personalised financial advice.";

const ChatBody = z.object({
  conversationId: z.string().max(64).optional(),
  provider: z.string().min(2).max(30),
  model: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(32_000),
});

const CompareBody = z.object({
  prompt: z.string().trim().min(1).max(16_000),
  targets: z
    .array(z.object({ provider: z.string().min(2).max(30), model: z.string().trim().min(1).max(200) }))
    .min(2)
    .max(4),
});

export function aiRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const aiLimiter = rateLimit({ name: "ai", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 30, key: (req) => req.user!.id });

  r.get("/providers", (req, res) => {
    res.json({ providers: providerStatus(ctx, req.user!.id), freeAllowance: freeUsage(ctx, req.user!.id) });
  });

  r.get("/providers/:id/models", async (req, res) => {
    res.json(await listModels(ctx, req.user!.id, req.params.id));
  });

  r.get("/conversations", (req, res) => {
    res.json({ conversations: listConversations(ctx, req.user!.id) });
  });

  r.get("/conversations/:id", (req, res) => {
    res.json({ conversation: getConversation(ctx, req.user!.id, req.params.id) });
  });

  r.delete("/conversations/:id", (req, res) => {
    deleteConversation(ctx, req.user!.id, req.params.id);
    res.json({ ok: true });
  });

  /** Streams a chat reply as Server-Sent Events: meta → delta* → done | error. */
  r.post("/chat", aiLimiter, async (req, res) => {
    const body = parse(ChatBody, req.body);
    const userId = req.user!.id;
    // Fail fast with a JSON error (not connected, not free, allowance used up) before streaming starts.
    const authorized = authorizeUse(ctx, userId, body.provider, body.model);

    let conversationId = body.conversationId;
    const isNew = !conversationId;
    if (conversationId) getConversation(ctx, userId, conversationId); // ownership check
    else conversationId = createConversation(ctx, userId, body.provider, body.model, body.message);

    const messages = [...historyFor(ctx, conversationId), { role: "user" as const, content: body.message }];
    const sse = openSse(res);
    sse.send("meta", { conversationId, provider: body.provider, model: body.model });

    let text = "";
    let usage: Usage | undefined;
    let servedModel = body.model;
    try {
      for await (const ev of streamChat(ctx, userId, {
        provider: body.provider,
        model: body.model,
        system: SYSTEM_PROMPT,
        messages,
        signal: sse.signal,
      }, authorized)) {
        if (ev.type === "text") {
          text += ev.text;
          sse.send("delta", { text: ev.text });
        } else {
          usage = ev.usage;
          servedModel = ev.model;
        }
      }
      if (text || !sse.signal.aborted) {
        addMessage(ctx, conversationId, { role: "user", content: body.message });
        const messageId = addMessage(ctx, conversationId, {
          role: "assistant",
          content: text || "_(no response)_",
          provider: body.provider,
          model: servedModel,
          usage,
        });
        sse.send("done", { messageId, model: servedModel, usage });
      } else if (isNew) {
        deleteConversation(ctx, userId, conversationId);
      }
    } catch (err) {
      if (isNew && !text) deleteConversation(ctx, userId, conversationId);
      sse.send("error", { message: (err as Error).message ?? "The AI provider returned an error" });
    } finally {
      sse.end();
    }
  });

  /** Sends one prompt to several models at once and streams their answers side by side. */
  r.post("/compare", aiLimiter, async (req, res) => {
    const body = parse(CompareBody, req.body);
    const userId = req.user!.id;
    const sse = openSse(res);

    await Promise.all(
      body.targets.map(async (target, index) => {
        const started = Date.now();
        try {
          for await (const ev of streamChat(ctx, userId, {
            ...target,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: body.prompt }],
            signal: sse.signal,
          })) {
            if (ev.type === "text") sse.send("delta", { index, text: ev.text });
            else sse.send("done", { index, model: ev.model, usage: ev.usage, ms: Date.now() - started });
          }
        } catch (err) {
          sse.send("error", { index, message: (err as Error).message });
        }
      }),
    );
    sse.send("end", {});
    sse.end();
  });

  return r;
}
