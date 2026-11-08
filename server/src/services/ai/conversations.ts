import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { ChatMessage, Usage } from "./types.js";

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  provider: string | null;
  model: string | null;
  usage: string | null;
  created_at: string;
}

const view = (c: ConversationRow) => ({
  id: c.id,
  title: c.title,
  provider: c.provider,
  model: c.model,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const messageView = (m: MessageRow) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  provider: m.provider,
  model: m.model,
  usage: m.usage ? (JSON.parse(m.usage) as Usage) : null,
  createdAt: m.created_at,
});

export function listConversations(ctx: Ctx, userId: string) {
  return all<ConversationRow>(
    ctx.db,
    "SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
    userId,
  ).map(view);
}

export function getConversation(ctx: Ctx, userId: string, id: string) {
  const c = one<ConversationRow>(ctx.db, "SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?", id, userId);
  if (!c) throw notFound("Conversation not found");
  const messages = all<MessageRow>(
    ctx.db,
    "SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    id,
  ).map(messageView);
  return { ...view(c), messages };
}

export function createConversation(ctx: Ctx, userId: string, provider: string, model: string, firstMessage: string) {
  const id = newId("conv");
  const now = nowIso();
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  run(
    ctx.db,
    "INSERT INTO ai_conversations (id, user_id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    title,
    provider,
    model,
    now,
    now,
  );
  return id;
}

export function addMessage(
  ctx: Ctx,
  conversationId: string,
  msg: { role: "user" | "assistant"; content: string; provider?: string; model?: string; usage?: Usage },
) {
  const id = newId("msg");
  const now = nowIso();
  run(
    ctx.db,
    "INSERT INTO ai_messages (id, conversation_id, role, content, provider, model, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    conversationId,
    msg.role,
    msg.content,
    msg.provider ?? null,
    msg.model ?? null,
    msg.usage ? JSON.stringify(msg.usage) : null,
    now,
  );
  run(
    ctx.db,
    "UPDATE ai_conversations SET updated_at = ?, provider = COALESCE(?, provider), model = COALESCE(?, model) WHERE id = ?",
    now,
    msg.provider ?? null,
    msg.model ?? null,
    conversationId,
  );
  return id;
}

/** Recent history to send as context, newest last, trimmed to a sane size. */
export function historyFor(ctx: Ctx, conversationId: string, maxMessages = 40): ChatMessage[] {
  return all<MessageRow>(
    ctx.db,
    "SELECT * FROM (SELECT rowid AS r, * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r",
    conversationId,
    maxMessages,
  ).map((m) => ({ role: m.role, content: m.content }));
}

export function deleteConversation(ctx: Ctx, userId: string, id: string) {
  const res = run(ctx.db, "DELETE FROM ai_conversations WHERE id = ? AND user_id = ?", id, userId);
  if (Number(res.changes) === 0) throw notFound("Conversation not found");
}
