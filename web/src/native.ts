import { Capacitor } from "@capacitor/core";

/**
 * The iOS and Android apps (Capacitor). On the website none of this runs: requests stay same-origin
 * with the HttpOnly session cookie. In the apps the bundled pages run at capacitor://localhost or
 * https://localhost, so requests go to the Aurex server (VITE_API_ORIGIN) with the session token,
 * which lives in the phone's secure storage (Keychain on iOS, an Android Keystore key on Android).
 */
export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as "ios" | "android" | "web";
export const API_ORIGIN = isNative ? String(import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "") : "";

/** The public address of the Aurex site: links shared from the apps must point there, not at the app's own localhost. */
export const publicOrigin = () => (isNative && API_ORIGIN ? API_ORIGIN : window.location.origin);

/** The address for an API path: unchanged on the website, the Aurex server in the apps. */
export const apiUrl = (path: string) => (isNative && path.startsWith("/api/") ? `${API_ORIGIN}${path}` : path);

const TOKEN_KEY = "session";
const LOCK_KEY = "biometric-lock";
let token: string | null = null;
let lockEnabled = false;

const storage = () => import("@aparajita/capacitor-secure-storage");

/** Headers that authenticate a request in the apps (nothing on the website: the cookie does it). */
export const authHeaders = (): Record<string, string> => (isNative && token ? { Authorization: `Bearer ${token}` } : {});
/** Requests from the apps never carry cookies. */
export const credentials: RequestCredentials = isNative ? "omit" : "same-origin";

export async function setAuthToken(next: string | null) {
  token = next;
  if (!isNative) return;
  const { SecureStorage, KeychainAccess } = await storage();
  if (next) await SecureStorage.set(TOKEN_KEY, next, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
  else await SecureStorage.remove(TOKEN_KEY, false).catch(() => false);
}

/** Before the app renders: restore the session token and settings, style for the device. */
export async function initNative() {
  if (!isNative) return;
  document.documentElement.classList.add("native", `native-${platform}`);
  try {
    const { SecureStorage } = await storage();
    await SecureStorage.setKeyPrefix("aurex_");
    await SecureStorage.setSynchronize(false);
    const saved = await SecureStorage.get(TOKEN_KEY, false, false);
    token = typeof saved === "string" ? saved : null;
    lockEnabled = (await SecureStorage.get(LOCK_KEY, false, false)) === true;
  } catch {
    token = null;
  }
  void setupShell();
}

/** Status bar, splash screen, links that leave the app, and the Android back button. */
async function setupShell() {
  const [{ StatusBar, Style }, { SplashScreen }, { App }, { Browser }] = await Promise.all([
    import("@capacitor/status-bar"),
    import("@capacitor/splash-screen"),
    import("@capacitor/app"),
    import("@capacitor/browser"),
  ]);
  const dark = document.documentElement.dataset.theme === "dark";
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
  SplashScreen.hide().catch(() => undefined);

  // Links to other sites open in the system browser, never inside the app.
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || e.defaultPrevented) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("/api/")) {
        // Files from the server (statements, documents) need the session token: fetch, then show or share.
        e.preventDefault();
        void openServerFile(href);
        return;
      }
      if (/^https?:\/\//i.test(href) && new URL(href).origin !== location.origin) {
        e.preventDefault();
        void Browser.open({ url: href });
      }
    },
    true,
  );

  // Android's back button goes back in the app, and leaves it from the first screen.
  App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) history.back();
    else void App.exitApp();
  });

  // Links into the app (aurex://pay/@handle, or the website's addresses) open the right screen.
  App.addListener("appUrlOpen", ({ url }) => {
    const path = appPathFor(url);
    if (path) {
      history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  });

  // Coming back to the app after a while: ask for Face ID / fingerprint when that's switched on.
  let hiddenAt = 0;
  App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) hiddenAt = Date.now();
    else if (lockEnabled && token && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lockListeners.forEach((l) => l());
  });
}

/** Opens a payment page (Stripe or Flutterwave checkout) in the system browser sheet, where Apple Pay and Google Pay work. */
export async function openCheckout(url: string) {
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url, presentationStyle: "popover" });
}

/** Opens a provider's secure https page: the browser sheet in the apps, a new tab on the web. */
export async function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  if (isNative) await openCheckout(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Which wallet this device can pay with on a hosted checkout page. */
export function deviceWallet(): "apple_pay" | "google_pay" | null {
  if (platform === "ios") return "apple_pay";
  if (platform === "android") return "google_pay";
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (apple && /Safari\//.test(ua) && !/Chrome|CriOS|Chromium|Edg|Firefox|FxiOS/.test(ua)) return "apple_pay";
  if (/Chrome|Chromium|Android/.test(ua)) return "google_pay";
  return null;
}

/** Which in-app page a link opens: aurex://pay/@amara, or https://<the Aurex site>/pay/@amara. */
export function appPathFor(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.protocol === "aurex:" ? `/${u.host}${u.pathname}`.replace(/\/+$/, "") : API_ORIGIN && u.origin === API_ORIGIN ? u.pathname : null;
  if (!path) return null;
  if (!/^\/(pay\/@?[A-Za-z0-9_]{2,30}|app(\/[A-Za-z0-9/_-]*)?|verify-person(\/[A-Za-z0-9_-]+)?|reset-password)$/.test(path)) return null;
  // Keep a section anchor (e.g. /app/settings#security, from a notification).
  return `${path}${u.search}${/^#[A-Za-z0-9-]{1,40}$/.test(u.hash) ? u.hash : ""}`;
}

/** Fetches a file from the server with the session token, then shows it (images) or opens the share sheet. */
export async function openServerFile(path: string, fallbackName = "aurex-file") {
  const res = await fetch(apiUrl(path), { headers: { ...authHeaders() }, credentials });
  if (!res.ok) throw new Error(`Couldn't open the file (${res.status})`);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${fallbackName}${extensionFor(blob.type)}`;
  if (blob.type.startsWith("image/")) return showImage(URL.createObjectURL(blob));
  await shareFile(blob, name);
}

/** Saves a file to the app's cache and opens the system share sheet (save to Files, open in a PDF viewer...). */
export async function shareFile(blob: Blob, name: string) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "aurex-file";
  const file = await Filesystem.writeFile({ path: safe, data, directory: Directory.Cache });
  await Share.share({ title: safe, url: file.uri }).catch(() => undefined);
}

const extensionFor = (mime: string) => ({ "application/pdf": ".pdf", "text/csv": ".csv", "image/jpeg": ".jpg", "image/png": ".png", "application/json": ".json" })[mime.split(";")[0]] ?? "";

function showImage(src: string) {
  const overlay = document.createElement("div");
  overlay.className = "native-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Document");
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Document";
  const close = document.createElement("button");
  close.className = "btn secondary";
  close.textContent = "Close";
  close.onclick = () => {
    overlay.remove();
    URL.revokeObjectURL(src);
  };
  overlay.append(img, close);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Unlocking with Face ID / Touch ID / fingerprint
// ---------------------------------------------------------------------------
const LOCK_AFTER_MS = 60_000;
const lockListeners = new Set<() => void>();
/** Called when the app comes back after a while and should ask for biometrics. */
export function onLockRequired(fn: () => void) {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}
export const biometricLockEnabled = () => lockEnabled;
/** True when the app should ask for biometrics right away (opening the app with a saved session). */
export const lockOnStart = () => isNative && lockEnabled && Boolean(token);

export async function biometryAvailable(): Promise<{ available: boolean; label: string }> {
  if (!isNative) return { available: false, label: "" };
  const { BiometricAuth, BiometryType } = await import("@aparajita/capacitor-biometric-auth");
  const r = await BiometricAuth.checkBiometry();
  const label =
    r.biometryType === BiometryType.faceId ? "Face ID" : r.biometryType === BiometryType.touchId ? "Touch ID" : r.biometryType === BiometryType.fingerprintAuthentication ? "fingerprint" : r.biometryType === BiometryType.faceAuthentication ? "face unlock" : "biometrics";
  return { available: r.isAvailable, label };
}

/** Asks for biometrics (or the device passcode). Resolves true when the person passed. */
export async function unlockWithBiometrics(reason = "Unlock Aurex"): Promise<boolean> {
  if (!isNative) return true;
  const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
  try {
    await BiometricAuth.authenticate({ reason, cancelTitle: "Cancel", allowDeviceCredential: true, iosFallbackTitle: "Use passcode", androidTitle: "Unlock Aurex", androidConfirmationRequired: false });
    return true;
  } catch {
    return false;
  }
}

export async function setBiometricLock(on: boolean) {
  if (on && !(await unlockWithBiometrics("Turn on unlocking with biometrics"))) return false;
  const { SecureStorage } = await storage();
  await SecureStorage.set(LOCK_KEY, on, false, false);
  lockEnabled = on;
  return true;
}
