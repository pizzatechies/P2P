import { apiUrl, authHeaders, credentials, isNative, setAuthToken, shareFile } from "./native";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Sensitive actions answer 401 "reauth_required" when the password (and 2FA) hasn't been confirmed
 * recently. The app registers a handler that asks the user to confirm; the request is then retried once.
 */
type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
let reauthPending: Promise<boolean> | null = null;
export function setReauthHandler(handler: ReauthHandler | null) {
  reauthHandler = handler;
}

/** In the apps, the session token comes back from signing in and goes when signing out or closing the account. */
async function trackSession(url: string, ok: boolean, data: { token?: string }) {
  if (!isNative) return;
  if (ok && (url === "/api/auth/login" || url === "/api/auth/register") && data.token) await setAuthToken(data.token);
  else if (url === "/api/auth/logout" || (ok && url === "/api/account/close")) await setAuthToken(null);
}

async function request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method,
    credentials,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-Aurex-CSRF": "1" } : {}),
      ...authHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  await trackSession(url, res.ok, data);
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && err.code === "reauth_required" && reauthHandler && !retried) {
      reauthPending ??= reauthHandler().finally(() => {
        reauthPending = null;
      });
      if (await reauthPending) return request<T>(method, url, body, true);
    }
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

/** Uploads a file as the raw request body (identity documents). */
export async function upload<T>(url: string, file: Blob): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    credentials,
    headers: { Accept: "application/json", "Content-Type": file.type || "application/octet-stream", "X-Aurex-CSRF": "1", ...authHeaders() },
    body: file,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? (res.status === 413 ? "That file is larger than 5 MB" : `Upload failed (${res.status})`));
  }
  return data as T;
}

/**
 * Downloads a file (CSV exports). Asks the user to confirm it's them first if the server needs a
 * recent sign-in, then saves the response under the server's filename.
 */
export async function downloadFile(url: string, fallbackName: string, retried = false): Promise<void> {
  const res = await fetch(apiUrl(url), { credentials, headers: { Accept: "text/csv, application/json", ...authHeaders() } });
  if (!res.ok) {
    const text = await res.text();
    let err: { code?: string; message?: string } = {};
    try {
      err = JSON.parse(text)?.error ?? {};
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && err.code === "reauth_required" && reauthHandler && !retried) {
      reauthPending ??= reauthHandler().finally(() => {
        reauthPending = null;
      });
      if (await reauthPending) return downloadFile(url, fallbackName, true);
    }
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  // Phones don't have a downloads folder for web pages: the share sheet saves or opens the file.
  if (isNative) return shareFile(await res.blob(), name);
  const blobUrl = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  put: <T>(url: string, body: unknown = {}) => request<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown = {}) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

/** POSTs and reads a Server-Sent Events response, calling onEvent for each event. */
export async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    credentials,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Aurex-CSRF": "1", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

/** Unique key so a retried payment can never go through twice. */
export function idempotencyKey() {
  // randomUUID only exists in secure contexts (HTTPS/localhost); fall back for plain-HTTP testing.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
