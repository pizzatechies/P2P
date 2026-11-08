import type { ProviderDef } from "./providers.js";
import { AIProviderError, type ChatRequest, type StreamEvent, type Usage } from "./types.js";

/**
 * Adapter for every provider that implements the OpenAI Chat Completions protocol
 * (OpenAI, Gemini, Mistral, Groq, xAI, DeepSeek, OpenRouter, Together, Perplexity, Ollama, ...).
 */
export interface CompatTarget {
  provider: ProviderDef;
  baseUrl: string;
  apiKey?: string;
  appUrl: string;
}

function headers(t: CompatTarget): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t.apiKey) h.Authorization = `Bearer ${t.apiKey}`;
  if (t.provider.id === "openrouter") {
    h["HTTP-Referer"] = t.appUrl;
    h["X-Title"] = "Aurex";
  }
  return h;
}

function buildMessages(req: Pick<ChatRequest, "system" | "messages">) {
  const msgs: { role: string; content: string }[] = [];
  if (req.system) msgs.push({ role: "system", content: req.system });
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

async function errorFrom(t: CompatTarget, res: Response): Promise<AIProviderError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string; detail?: unknown };
    detail =
      (typeof body.error === "string" ? body.error : body.error?.message) ??
      body.message ??
      (body.detail ? JSON.stringify(body.detail) : "");
  } catch {
    /* non-JSON error body */
  }
  const name = t.provider.name;
  if (res.status === 401 || res.status === 403) {
    return new AIProviderError(`${name} rejected the API key${detail ? `: ${detail}` : ""}`, t.provider.id, res.status);
  }
  if (res.status === 404) {
    return new AIProviderError(`${name}: model or endpoint not found${detail ? ` (${detail})` : ""}`, t.provider.id, 404);
  }
  if (res.status === 429) return new AIProviderError(`${name} rate limit reached. Try again shortly.`, t.provider.id, 429);
  return new AIProviderError(`${name} error ${res.status}${detail ? `: ${detail}` : ""}`, t.provider.id, res.status);
}

async function post(t: CompatTarget, path: string, body: unknown, signal?: AbortSignal) {
  try {
    return await fetch(`${t.baseUrl}${path}`, {
      method: "POST",
      headers: headers(t),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AIProviderError(`Couldn't reach ${t.provider.name}: ${(err as Error).message}`, t.provider.id);
  }
}

/** Parses a text/event-stream body into the `data:` payloads it carries. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
}

export async function* streamCompat(t: CompatTarget, req: ChatRequest): AsyncGenerator<StreamEvent> {
  const res = await post(
    t,
    "/chat/completions",
    {
      model: req.model,
      messages: buildMessages(req),
      stream: true,
      ...(t.provider.streamUsage ? { stream_options: { include_usage: true } } : {}),
    },
    req.signal,
  );
  if (!res.ok || !res.body) throw await errorFrom(t, res);

  let usage: Usage | undefined;
  let model = req.model;
  let finish: string | undefined;
  try {
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: {
        model?: string;
        choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // keep-alive comments or partial junk
      }
      if (chunk.error) throw new AIProviderError(`${t.provider.name}: ${chunk.error.message ?? "stream error"}`, t.provider.id);
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: "text", text };
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    }
  } catch (err) {
    if (req.signal?.aborted) return;
    throw err;
  }
  yield { type: "done", model, usage, stopReason: finish };
}

export async function completeCompat(
  t: CompatTarget,
  req: Pick<ChatRequest, "model" | "system" | "messages" | "signal"> & { json?: boolean },
): Promise<{ text: string; model: string; usage?: Usage }> {
  const res = await post(
    t,
    "/chat/completions",
    {
      model: req.model,
      messages: buildMessages(req),
      ...(req.json && t.provider.jsonMode ? { response_format: { type: "json_object" } } : {}),
    },
    req.signal ?? AbortSignal.timeout(120_000),
  );
  if (!res.ok) throw await errorFrom(t, res);
  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    model: body.model ?? req.model,
    usage: body.usage ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens } : undefined,
  };
}

export async function listCompatModels(t: CompatTarget) {
  let res: Response;
  try {
    res = await fetch(`${t.baseUrl}/models`, { headers: headers(t), signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new AIProviderError(`Couldn't reach ${t.provider.name}: ${(err as Error).message}`, t.provider.id);
  }
  if (!res.ok) throw await errorFrom(t, res);
  const body = (await res.json()) as { data?: { id: string; name?: string }[]; models?: { name: string }[] };
  const items = body.data ?? body.models?.map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.name })) ?? [];
  return items
    .map((m) => ({ id: m.id.replace(/^models\//, ""), label: m.name && m.name !== m.id ? m.name : m.id.replace(/^models\//, "") }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
