import type { ChatRequest, StreamEvent } from "./types.js";

function reply(prompt: string): string {
  const p = prompt.toLowerCase();
  const intro =
    "**You're talking to the built-in demo assistant.** It runs offline so the app works before any AI keys are configured.\n\n";
  let body: string;
  if (/\b(stock|trade|trading|buy|sell|portfolio|market)\b/.test(p)) {
    body =
      "For trading, open **Trading → AI analyst**. Pick a symbol and the analyst reads recent prices and technical " +
      "indicators (moving averages, RSI, momentum, volatility) and returns a buy / sell / hold signal with a suggested " +
      "size, stop-loss and take-profit. You review it and decide whether to place the order.\n\n" +
      "Without an AI key the analyst uses a transparent rule-based model; connect Claude or another provider for " +
      "written, model-generated analysis.";
  } else if (/\b(send|pay|transfer|money|wallet|request)\b/.test(p)) {
    body =
      "To move money, use **Payments**: send to anyone by @handle or email, request money, or convert between " +
      "currencies in your wallet. **Wallet → Add money** tops up your balance through the enabled payment methods.";
  } else {
    body =
      `You asked: _"${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}"_\n\n` +
      "To get real answers, connect a provider:\n\n" +
      "1. Open **Settings → AI keys**.\n" +
      "2. Paste a key for Anthropic, OpenAI, Google Gemini, Mistral, Groq, xAI, DeepSeek, OpenRouter, Together or Perplexity.\n" +
      "3. Pick that provider and model in the selector above.\n\n" +
      "An administrator can also set server-wide keys in the `.env` file so every user has access.";
  }
  return intro + body;
}

export async function* streamDemo(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = reply(last);
  const tokens = text.match(/\S+\s*/g) ?? [text];
  for (const token of tokens) {
    if (req.signal?.aborted) return;
    yield { type: "text", text: token };
    await new Promise((r) => setTimeout(r, 12));
  }
  yield { type: "done", model: "demo", usage: { inputTokens: 0, outputTokens: tokens.length } };
}
