import type { z } from "zod";
import type { Ctx } from "../../context.js";
import { badRequest, unprocessable } from "../../lib/errors.js";
import { getUserKey } from "../keys.js";
import { assertFreeModel, chargeFreeRequest } from "./allowance.js";
import { listAnthropicModels, streamAnthropic, structuredAnthropic } from "./anthropic.js";
import { streamDemo } from "./demo.js";
import { completeCompat, listCompatModels, streamCompat, type CompatTarget } from "./openaiCompat.js";
import { getProvider, PROVIDERS, type ProviderDef } from "./providers.js";
import { AIProviderError, type ChatRequest, type StreamEvent } from "./types.js";

export interface ResolvedProvider {
  provider: ProviderDef;
  apiKey?: string;
  baseUrl?: string;
  source: "user" | "server" | "builtin";
}

function ollamaBase(url: string) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Works out which credentials to use: the user's own key first, then the server-wide key. */
export function tryResolve(ctx: Ctx, userId: string, providerId: string): ResolvedProvider | null {
  const provider = getProvider(providerId);
  if (!provider) throw badRequest(`Unknown AI provider "${providerId}"`);
  if (provider.kind === "demo") return { provider, source: "builtin" };
  if (provider.id === "ollama") {
    const url = ctx.config.OLLAMA_BASE_URL;
    return url ? { provider, baseUrl: ollamaBase(url), source: "server" } : null;
  }
  const userKey = getUserKey(ctx, userId, provider.id);
  if (userKey) return { provider, apiKey: userKey.secret, baseUrl: provider.baseUrl, source: "user" };
  const serverKey = provider.envKey ? (ctx.config[provider.envKey] as string | undefined) : undefined;
  if (serverKey) return { provider, apiKey: serverKey, baseUrl: provider.baseUrl, source: "server" };
  return null;
}

export function resolve(ctx: Ctx, userId: string, providerId: string): ResolvedProvider {
  const r = tryResolve(ctx, userId, providerId);
  if (!r) {
    const p = getProvider(providerId)!;
    throw unprocessable(
      "provider_not_configured",
      p.id === "ollama"
        ? "Ollama isn't configured on this server (set OLLAMA_BASE_URL)."
        : `${p.name} isn't connected yet. Add your API key in Settings → AI keys.`,
    );
  }
  return r;
}

/**
 * Resolves credentials for one AI request and, when it will run on the server's own key, applies the
 * free allowance (model allowlist + daily request count). Call once per request.
 */
export function authorizeUse(ctx: Ctx, userId: string, providerId: string, model: string): ResolvedProvider {
  const r = resolve(ctx, userId, providerId);
  if (r.source === "server") {
    assertFreeModel(ctx, providerId, model);
    chargeFreeRequest(ctx, userId);
  }
  return r;
}

function compatTarget(ctx: Ctx, r: ResolvedProvider): CompatTarget {
  return { provider: r.provider, apiKey: r.apiKey, baseUrl: r.baseUrl!, appUrl: ctx.config.APP_URL };
}

export function providerStatus(ctx: Ctx, userId: string) {
  return PROVIDERS.map((p) => {
    const r = tryResolve(ctx, userId, p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      available: !!r,
      source: r?.source ?? null,
      free: r?.source === "server" || r?.source === "builtin",
      keyRequired: p.keyRequired,
      keyUrl: p.keyUrl ?? null,
      listModels: p.listModels,
      models: p.models,
    };
  });
}

export async function* streamChat(
  ctx: Ctx,
  userId: string,
  req: ChatRequest,
  authorized?: ResolvedProvider,
): AsyncGenerator<StreamEvent> {
  if (!req.model.trim()) throw badRequest("Pick a model");
  const r = authorized ?? authorizeUse(ctx, userId, req.provider, req.model);
  switch (r.provider.kind) {
    case "demo":
      yield* streamDemo(req);
      return;
    case "anthropic":
      yield* streamAnthropic(r.apiKey!, req);
      return;
    case "openai":
      yield* streamCompat(compatTarget(ctx, r), req);
      return;
  }
}

/** Pulls the first JSON object out of a model's reply, tolerating code fences and prose around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in the model's reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Asks a model for a JSON answer that must validate against `schema`. Claude uses structured
 * outputs (guaranteed to match); other providers use JSON mode where available plus validation.
 */
export async function completeStructured<T extends z.ZodType>(
  ctx: Ctx,
  userId: string,
  opts: { provider: string; model: string; system: string; prompt: string; schema: T },
): Promise<{ data: z.infer<T>; model: string }> {
  const r = resolve(ctx, userId, opts.provider);
  if (r.provider.kind === "demo") throw new AIProviderError("The demo provider can't produce analysis", "demo");
  authorizeUse(ctx, userId, opts.provider, opts.model);
  if (r.provider.kind === "anthropic") {
    return structuredAnthropic(r.apiKey!, { ...opts, effort: "high" });
  }
  const res = await completeCompat(compatTarget(ctx, r), {
    model: opts.model,
    system: `${opts.system}\n\nRespond with a single JSON object only. No prose, no code fences.`,
    messages: [{ role: "user", content: opts.prompt }],
    json: true,
  });
  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch (err) {
    throw new AIProviderError(`${r.provider.name} didn't return valid JSON: ${(err as Error).message}`, r.provider.id);
  }
  const result = opts.schema.safeParse(parsed);
  if (!result.success) {
    throw new AIProviderError(`${r.provider.name}'s answer was missing fields: ${result.error.issues[0]?.message}`, r.provider.id);
  }
  return { data: result.data, model: res.model };
}

export async function listModels(ctx: Ctx, userId: string, providerId: string) {
  const r = tryResolve(ctx, userId, providerId);
  const provider = getProvider(providerId)!;
  if (!r || !provider.listModels) return { models: provider.models, live: false };
  try {
    const models = r.provider.kind === "anthropic" ? await listAnthropicModels(r.apiKey!) : await listCompatModels(compatTarget(ctx, r));
    return { models: models.length ? models : provider.models, live: models.length > 0 };
  } catch (err) {
    return { models: provider.models, live: false, error: (err as Error).message };
  }
}

/** Cheap credential check used when a user saves a key. */
export async function testCredentials(ctx: Ctx, providerId: string, apiKey: string) {
  const provider = getProvider(providerId);
  if (!provider || provider.kind === "demo") throw badRequest("Unknown provider");
  if (provider.kind === "anthropic") {
    await listAnthropicModels(apiKey);
    return;
  }
  if (provider.listModels) {
    await listCompatModels({ provider, apiKey, baseUrl: provider.baseUrl!, appUrl: ctx.config.APP_URL });
    return;
  }
  await completeCompat(
    { provider, apiKey, baseUrl: provider.baseUrl!, appUrl: ctx.config.APP_URL },
    { model: provider.models[0].id, messages: [{ role: "user", content: "Reply with OK." }] },
  );
}
