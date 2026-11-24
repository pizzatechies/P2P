import { registerPlugin } from "@capacitor/core";
import { appPathFor, isNative, publicOrigin } from "./native";

/**
 * Tap to pay with NFC: share your pay link by holding phones together (Android app), write it to an
 * NFC sticker (Android and iPhone apps, and Chrome on Android), and read a sticker or phone to pay.
 */
export interface NfcStatus {
  supported: boolean;
  enabled: boolean;
  /** This phone can present a link to another phone (Android only). */
  canShare: boolean;
  canRead: boolean;
  canWrite: boolean;
  sharing: boolean;
}

interface AurexNfcPlugin {
  status(): Promise<NfcStatus>;
  share(o: { url: string; seconds?: number }): Promise<void>;
  stopSharing(): Promise<void>;
  read(): Promise<{ url: string }>;
  write(o: { url: string; lock?: boolean }): Promise<{ written: boolean; locked: boolean }>;
  cancel(): Promise<void>;
  openSettings(): Promise<void>;
  addListener(event: "shareStopped", fn: () => void): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<AurexNfcPlugin>("AurexNfc");

// Web NFC (Chrome on Android): reading and writing tags from the website.
interface NdefRecordLike { recordType: string; data?: DataView; encoding?: string }
interface NdefReaderLike {
  scan(o?: { signal?: AbortSignal }): Promise<void>;
  write(m: { records: { recordType: string; data: string }[] }, o?: { signal?: AbortSignal }): Promise<void>;
  makeReadOnly?(o?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((e: { message: { records: NdefRecordLike[] } }) => void) | null;
  onreadingerror: (() => void) | null;
}
const WebNdef = (globalThis as unknown as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;
let webAbort: AbortController | null = null;

const NONE: NfcStatus = { supported: false, enabled: false, canShare: false, canRead: false, canWrite: false, sharing: false };

export async function nfcStatus(): Promise<NfcStatus> {
  if (isNative) {
    try {
      return await Native.status();
    } catch {
      return NONE;
    }
  }
  if (WebNdef) return { supported: true, enabled: true, canShare: false, canRead: true, canWrite: true, sharing: false };
  return NONE;
}

export class NfcError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}
const wrap = (e: unknown) => {
  const err = e as { message?: string; code?: string; name?: string };
  if (err?.name === "AbortError") return new NfcError("Cancelled", "cancelled");
  if (err?.name === "NotAllowedError") return new NfcError("Allow NFC for this site to use tap to pay", "not_allowed");
  return new NfcError(err?.message || "NFC didn't work. Try again.", err?.code || "nfc_error");
};

/** Present the pay link to phones that touch this one (Android app only). */
export async function startSharing(url: string, seconds = 120) {
  try {
    await Native.share({ url, seconds });
  } catch (e) {
    throw wrap(e);
  }
}
export const stopSharing = () => (isNative ? Native.stopSharing().catch(() => undefined) : Promise.resolve());
export const onShareStopped = (fn: () => void) => (isNative ? Native.addListener("shareStopped", fn) : Promise.resolve({ remove: async () => undefined }));
export const openNfcSettings = () => (isNative ? Native.openSettings().catch(() => undefined) : Promise.resolve());

/** Wait for a sticker or phone and return the link on it. */
export async function readTag(): Promise<string> {
  if (isNative) {
    try {
      return (await Native.read()).url;
    } catch (e) {
      throw wrap(e);
    }
  }
  if (!WebNdef) throw new NfcError("NFC isn't available here", "unavailable");
  webAbort?.abort();
  const abort = (webAbort = new AbortController());
  const reader = new WebNdef();
  return new Promise<string>((resolve, reject) => {
    reader.onreading = (e) => {
      for (const r of e.message.records) {
        if ((r.recordType === "url" || r.recordType === "absolute-url") && r.data) {
          // Settle first: stopping the scan afterwards must not turn the result into "cancelled".
          resolve(new TextDecoder(r.encoding || "utf-8").decode(r.data));
          abort.abort();
          return;
        }
      }
      reject(new NfcError("There's no link on this tag", "no_link"));
      abort.abort();
    };
    reader.onreadingerror = () => undefined; // keep waiting: the tag was moved away too soon
    abort.signal.addEventListener("abort", () => reject(new NfcError("Cancelled", "cancelled")));
    reader.scan({ signal: abort.signal }).catch((e) => reject(wrap(e)));
  });
}

/** Write the link to the next sticker held to the phone, optionally locking it. */
export async function writeTag(url: string, lock: boolean): Promise<{ locked: boolean }> {
  if (isNative) {
    try {
      const r = await Native.write({ url, lock });
      return { locked: r.locked };
    } catch (e) {
      throw wrap(e);
    }
  }
  if (!WebNdef) throw new NfcError("NFC isn't available here", "unavailable");
  webAbort?.abort();
  const abort = (webAbort = new AbortController());
  const writer = new WebNdef();
  try {
    await writer.write({ records: [{ recordType: "url", data: url }] }, { signal: abort.signal });
    if (lock && writer.makeReadOnly) {
      await writer.makeReadOnly({ signal: abort.signal });
      return { locked: true };
    }
    return { locked: false };
  } catch (e) {
    throw wrap(e);
  }
}

export function cancelNfc() {
  webAbort?.abort();
  webAbort = null;
  if (isNative) void Native.cancel().catch(() => undefined);
}

/**
 * The in-app page for a link read from a tag, or null if it isn't an Aurex pay link. Links to any
 * other site are refused: a sticker anyone can stick on a counter mustn't send people elsewhere.
 */
export function payPathForTag(url: string): string | null {
  if (isNative) {
    const path = appPathFor(url);
    return path && path.startsWith("/pay/") ? path : null;
  }
  try {
    const u = new URL(url);
    if (u.origin !== publicOrigin()) return null;
    return /^\/pay\/@?[A-Za-z0-9_]{2,30}$/.test(u.pathname) ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}
