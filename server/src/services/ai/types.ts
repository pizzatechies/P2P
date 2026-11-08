export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  provider: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string; usage?: Usage; stopReason?: string };

export class AIProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
