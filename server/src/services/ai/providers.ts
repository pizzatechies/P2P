import type { Config } from "../../config.js";

export interface ModelDef {
  id: string;
  label: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  kind: "anthropic" | "openai" | "demo";
  /** For OpenAI-compatible providers: base URL that `/chat/completions` and `/models` hang off. */
  baseUrl?: string;
  envKey?: keyof Config;
  keyRequired: boolean;
  /** Suggested models. Users can also type any model id the provider supports. */
  models: ModelDef[];
  keyUrl?: string;
  /** Supports GET /models for live model discovery. */
  listModels: boolean;
  /** Accepts `stream_options: { include_usage: true }`. */
  streamUsage: boolean;
  /** Accepts `response_format: { type: "json_object" }`. */
  jsonMode: boolean;
  description: string;
}

/**
 * The provider catalogue. Most providers speak the OpenAI Chat Completions protocol, so adding one
 * is usually a single entry here. Anthropic uses its official SDK (see anthropic.ts).
 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    keyRequired: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "Claude models for reasoning, coding, analysis and writing.",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "GPT models via the OpenAI API.",
    models: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    keyRequired: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "Gemini models through Google's OpenAI-compatible endpoint.",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    keyRequired: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    listModels: true,
    streamUsage: false,
    jsonMode: true,
    description: "Mistral's hosted models.",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large (latest)" },
      { id: "mistral-small-latest", label: "Mistral Small (latest)" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    keyRequired: true,
    keyUrl: "https://console.groq.com/keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "Very fast inference for open-weight models.",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    ],
  },
  {
    id: "xai",
    name: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    keyRequired: true,
    keyUrl: "https://console.x.ai",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "Grok models from xAI.",
    models: [{ id: "grok-4", label: "Grok 4" }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "DeepSeek chat and reasoning models.",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyRequired: true,
    keyUrl: "https://openrouter.ai/keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "One key for hundreds of models from many labs.",
    models: [{ id: "openrouter/auto", label: "Auto (best available)" }],
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    keyRequired: true,
    keyUrl: "https://api.together.ai/settings/api-keys",
    listModels: true,
    streamUsage: true,
    jsonMode: true,
    description: "Open-weight models hosted by Together.",
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" }],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    envKey: "PERPLEXITY_API_KEY",
    keyRequired: true,
    keyUrl: "https://www.perplexity.ai/settings/api",
    listModels: false,
    streamUsage: false,
    jsonMode: false,
    description: "Search-grounded answers with citations.",
    models: [
      { id: "sonar", label: "Sonar" },
      { id: "sonar-pro", label: "Sonar Pro" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (self-hosted)",
    kind: "openai",
    envKey: "OLLAMA_BASE_URL",
    keyRequired: false,
    listModels: true,
    streamUsage: false,
    jsonMode: true,
    description: "Models running on your own hardware.",
    models: [{ id: "llama3.2", label: "Llama 3.2" }],
  },
  {
    id: "demo",
    name: "Demo assistant",
    kind: "demo",
    keyRequired: false,
    listModels: false,
    streamUsage: false,
    jsonMode: true,
    description: "Built-in offline assistant so the app works before any keys are added.",
    models: [{ id: "demo", label: "Demo (offline)" }],
  },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Providers users may store their own keys for. */
export const BYOK_PROVIDERS = PROVIDERS.filter((p) => p.keyRequired).map((p) => p.id);
