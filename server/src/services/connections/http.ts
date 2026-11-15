import { ConnectorError } from "./types.js";

/** JSON request helper for aggregator REST APIs, with provider-named errors. */
export async function jsonRequest<T>(
  provider: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    const form = init.form ? new URLSearchParams(init.form).toString() : undefined;
    res = await fetch(url, {
      method: init.method ?? (form ? "POST" : "GET"),
      headers: {
        Accept: "application/json",
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (err) {
    throw new ConnectorError(`Couldn't reach ${provider}: ${(err as Error).message}`, provider);
  }
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const b = body as { message?: string; error?: { message?: string; class?: string } | string; error_message?: string; error_description?: string };
    const detail =
      b.error_message ?? b.error_description ?? (typeof b.error === "string" ? b.error : b.error?.message) ?? b.message ?? `HTTP ${res.status}`;
    throw new ConnectorError(`${provider}: ${detail}`, provider, res.status);
  }
  return body as T;
}
