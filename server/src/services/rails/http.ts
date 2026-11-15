import { createHash } from "node:crypto";
import { HttpError } from "../../lib/errors.js";

export interface RailResponse<T> {
  ok: boolean;
  status: number;
  json: T;
}

/** Fetches a provider API and parses JSON without throwing on HTTP errors (the caller decides). */
export async function railFetch<T = Record<string, unknown>>(
  provider: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RailResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (err) {
    throw new HttpError(502, "rail_error", `Couldn't reach ${provider}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 200) };
    }
  }
  return { ok: res.ok, status: res.status, json: json as T };
}

/** Pulls a human-readable message out of the error shapes providers commonly use. */
export function providerMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const j = json as Record<string, unknown>;
  const first = (v: unknown) => (Array.isArray(v) && v.length ? (v[0] as Record<string, unknown>) : undefined);
  const nested = first(j.errors) ?? first(j.details) ?? (typeof j.error === "object" ? (j.error as Record<string, unknown>) : undefined);
  const candidates = [
    j.errorMessage,
    j.error_description,
    nested?.message,
    nested?.description,
    nested?.issue,
    j.message,
    typeof j.error === "string" ? j.error : undefined,
    j.reason,
  ];
  const found = candidates.find((c) => typeof c === "string" && c.trim() !== "");
  return found ? String(found).slice(0, 240) : undefined;
}

/** Like railFetch, but throws a 502 with the provider's message when the response isn't 2xx. */
export async function railJson<T = Record<string, unknown>>(provider: string, url: string, init: Parameters<typeof railFetch>[2] = {}): Promise<T> {
  const res = await railFetch<T>(provider, url, init);
  if (!res.ok) throw new HttpError(502, "rail_error", `${provider}: ${providerMessage(res.json) ?? `HTTP ${res.status}`}`);
  return res.json;
}

/** Caches an OAuth access token until shortly before it expires. */
export function tokenCache(fetchToken: () => Promise<{ token: string; expiresIn: number }>) {
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async (): Promise<string> => {
    if (cached && Date.now() < cached.until) return cached.token;
    inflight ??= fetchToken()
      .then(({ token, expiresIn }) => {
        cached = { token, until: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
        return token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** A stable UUID derived from a seed, so retries of the same Aurex transfer reuse the provider's idempotency key. */
export function uuidFromSeed(seed: string): string {
  const b = createHash("sha256").update(seed).digest();
  b[6] = (b[6] & 0x0f) | 0x40; // version 4 layout
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Amount as a decimal string without a pointless ".00" (some mobile-money APIs reject decimals). */
export function plainAmount(major: string): string {
  return major.replace(/\.0+$/, "");
}

/** Kenyan mobile number in Safaricom's 2547XXXXXXXX / 2541XXXXXXXX format, or null. */
export function kenyanMsisdn(input: string | undefined): string | null {
  if (!input) return null;
  let d = input.replace(/[^\d]/g, "");
  if (d.startsWith("0") && d.length === 10) d = `254${d.slice(1)}`;
  else if (d.length === 9 && /^[71]/.test(d)) d = `254${d}`;
  return /^254[71]\d{8}$/.test(d) ? d : null;
}

/** International mobile number (country code, no + or leading zero), or null. */
export function msisdn(input: string | undefined): string | null {
  if (!input) return null;
  const d = input.replace(/[^\d]/g, "");
  return /^[1-9]\d{8,14}$/.test(d) ? d : null;
}
