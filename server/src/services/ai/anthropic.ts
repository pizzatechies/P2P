import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AIProviderError, type ChatRequest, type StreamEvent } from "./types.js";

/**
 * Models that accept the server-side refusal fallback in its `"default"` form on the Claude API.
 * If a safety classifier declines a request, the API re-runs it on Anthropic's recommended
 * fallback model instead of returning the refusal.
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
/** Models known to accept `output_config.effort`. Custom/older model ids are sent without it. */
const EFFORT_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
]);

const clients = new Map<string, Anthropic>();
function client(apiKey: string) {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey, maxRetries: 2 });
    if (clients.size > 200) clients.clear();
    clients.set(apiKey, c);
  }
  return c;
}

function fallbackParams(model: string) {
  return FALLBACK_MODELS.has(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
}

function toProviderError(err: unknown): AIProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AIProviderError("Anthropic rejected the API key. Check it in Settings → AI keys.", "anthropic", 401);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AIProviderError("This Anthropic key doesn't have access to that model.", "anthropic", 403);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AIProviderError("Anthropic doesn't recognise that model id.", "anthropic", 404);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIProviderError("Anthropic rate limit reached. Try again in a moment.", "anthropic", 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AIProviderError(`Anthropic rejected the request: ${err.message}`, "anthropic", 400);
  }
  if (err instanceof Anthropic.APIError) {
    return new AIProviderError(`Anthropic API error (${err.status ?? "network"}): ${err.message}`, "anthropic", err.status);
  }
  return new AIProviderError((err as Error)?.message ?? "Unknown Anthropic error", "anthropic");
}

export async function* streamAnthropic(apiKey: string, req: ChatRequest): AsyncGenerator<StreamEvent> {
  try {
    // Adaptive thinking is the default on current Claude models, so `thinking` is omitted.
    const stream = client(apiKey).beta.messages.stream(
      {
        model: req.model,
        max_tokens: 64000,
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...fallbackParams(req.model),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new AIProviderError(
        "Claude declined this request. Try rephrasing, or pick a different model.",
        "anthropic",
      );
    }
    yield {
      type: "done",
      model: final.model,
      stopReason: final.stop_reason ?? undefined,
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
    };
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
    if (req.signal?.aborted) return;
    throw toProviderError(err);
  }
}

/** One-shot request whose answer is validated against a Zod schema via structured outputs. */
export async function structuredAnthropic<T extends z.ZodType>(
  apiKey: string,
  opts: { model: string; system: string; prompt: string; schema: T; effort?: "low" | "medium" | "high" },
): Promise<{ data: z.infer<T>; model: string }> {
  try {
    const response = await client(apiKey).beta.messages.parse({
      model: opts.model,
      max_tokens: 16000,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      output_config: {
        format: betaZodOutputFormat(opts.schema),
        ...(EFFORT_MODELS.has(opts.model) && opts.effort ? { effort: opts.effort } : {}),
      },
      ...fallbackParams(opts.model),
    });
    if (response.stop_reason === "refusal") {
      throw new AIProviderError("Claude declined to analyse this request.", "anthropic");
    }
    if (!response.parsed_output) {
      throw new AIProviderError("Claude's answer didn't match the expected format.", "anthropic");
    }
    return { data: response.parsed_output as z.infer<T>, model: response.model };
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
    throw toProviderError(err);
  }
}

export async function listAnthropicModels(apiKey: string) {
  try {
    const out: { id: string; label: string }[] = [];
    for await (const m of client(apiKey).models.list({ limit: 100 })) {
      out.push({ id: m.id, label: m.display_name });
    }
    return out;
  } catch (err) {
    throw toProviderError(err);
  }
}
