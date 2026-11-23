import { useState } from "react";
import { api } from "../api";
import { platform } from "../native";
import { useLoad, useToast } from "../state";

interface PushStatus {
  available: boolean;
  enabled: boolean;
  server: string | null;
  topic: string | null;
  subscribeLink: string | null;
  prefs: { payments: boolean; account: boolean };
  opens: "app" | "web";
  apps: { android: { play: string; fdroid: string }; ios: { appStore: string } };
}

/** Which phone this is, for the right instructions (the website on a desktop shows both). */
function phoneKind(): "android" | "ios" | "other" {
  if (platform !== "web") return platform;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`);
    } catch {
      toast("Couldn't copy: select the text and copy it instead");
    }
  }
  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <span className="small muted" style={{ minWidth: 64 }}>{label}</span>
      <code className="grow small" style={{ wordBreak: "break-all", userSelect: "all" }}>{value}</code>
      <button type="button" className="btn ghost sm" onClick={copy}>Copy</button>
    </div>
  );
}

/**
 * Push notifications through ntfy: no Google or Apple account needed. The customer installs the free
 * ntfy app and subscribes to their own private channel; Aurex sends payments and security messages there.
 */
export function PushCard() {
  const toast = useToast();
  const { data, reload, setData } = useLoad(() => api.get<PushStatus>("/api/account/push"));
  const [busy, setBusy] = useState(false);
  const kind = phoneKind();

  async function act(fn: () => Promise<PushStatus | void>, done?: string) {
    setBusy(true);
    try {
      const next = await fn();
      if (next) setData(next);
      else await reload();
      if (done) toast(done);
    } catch (err) {
      toast((err as Error).message);
      void reload();
    } finally {
      setBusy(false);
    }
  }

  /** Ticks change straight away; the server's answer then confirms (or puts them back). */
  function setPref(key: "payments" | "account", value: boolean) {
    if (!data) return;
    setData({ ...data, prefs: { ...data.prefs, [key]: value } });
    void act(() => api.put<PushStatus>("/api/account/push/prefs", { [key]: value }));
  }

  if (!data) return null;
  if (!data.available) {
    return (
      <div className="card" id="notifications">
        <h2>Notifications</h2>
        <p className="muted small" style={{ margin: 0 }}>Phone notifications aren't switched on for this Aurex server yet. You still get alerts here and by email.</p>
      </div>
    );
  }

  const showAndroid = kind === "android" || kind === "other";
  const showIos = kind === "ios" || kind === "other";
  return (
    <div className="card stack" id="notifications">
      <div className="card-head">
        <h2>Notifications</h2>
        {data.enabled && <span className="pill good">On</span>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Get a notification on your phone when money arrives, a payment request comes in, a withdrawal is sent, or there's a security alert. They come through{" "}
        <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>, a free open-source app: no Google or Apple account needed, and nothing is shared with advertisers.
      </p>

      {!data.enabled ? (
        <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => act(() => api.post<PushStatus>("/api/account/push/enable"))}>
          Turn on notifications
        </button>
      ) : (
        <>
          <ol className="small stack" style={{ margin: 0, paddingLeft: 20, gap: 10 }}>
            <li>
              Install the free ntfy app:{" "}
              {showAndroid && (
                <>
                  <a href={data.apps.android.play} target="_blank" rel="noreferrer">Google Play</a> or{" "}
                  <a href={data.apps.android.fdroid} target="_blank" rel="noreferrer">F-Droid</a>
                  {showIos ? " (Android), " : ""}
                </>
              )}
              {showIos && (
                <>
                  <a href={data.apps.ios.appStore} target="_blank" rel="noreferrer">App Store</a>
                  {showAndroid ? " (iPhone)" : ""}
                </>
              )}
              .
            </li>
            {showAndroid && (
              <li>
                {showIos ? "On Android, tap " : "Tap "}
                <a className="btn sm" href={data.subscribeLink!} style={{ margin: "0 4px" }}>Subscribe in ntfy</a>
                {kind === "other" ? " on your phone (or add the server and channel below by hand)." : " and confirm. That's it."}
              </li>
            )}
            {showIos && (
              <li>
                <div className="stack" style={{ gap: 6 }}>
                  <span>
                    {showAndroid ? "On iPhone, open" : "Open"} ntfy, tap <strong>+</strong>, type the channel name, turn on <strong>Use another server</strong> and enter the server address:
                  </span>
                  <CopyField label="Channel" value={data.topic!} />
                  <CopyField label="Server" value={data.server!} />
                </div>
              </li>
            )}
            <li>
              <button className="btn ghost sm" disabled={busy} onClick={() => act(async () => { await api.post("/api/account/push/test"); }, "Test notification sent")}>
                Send a test notification
              </button>
            </li>
          </ol>

          <div>
            <label className="check-row small">
              <input type="checkbox" checked={data.prefs.payments} onChange={(e) => setPref("payments", e.target.checked)} />
              <span className="grow">Money in and out: payments received, requests, deposits and withdrawals</span>
            </label>
            <label className="check-row small">
              <input type="checkbox" checked={data.prefs.account} onChange={(e) => setPref("account", e.target.checked)} />
              <span className="grow">Security alerts and account messages (support replies, verification)</span>
            </label>
          </div>

          <p className="small faint" style={{ margin: 0 }}>
            Your channel name works like a password: anyone who has it can read your notifications, so don't share it. It changes when you sign out everywhere or change your password, and you subscribe again.
            {data.opens === "app" ? " Tapping a notification opens the Aurex app." : " Tapping a notification opens Aurex in your browser."}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn ghost sm"
              disabled={busy}
              onClick={() => {
                if (confirm("Get a new private channel? Phones subscribed to the current one stop getting notifications until you subscribe again.")) void act(() => api.post<PushStatus>("/api/account/push/reset"), "New channel ready: subscribe to it on your phone");
              }}
            >
              New private channel
            </button>
            <button className="btn ghost sm" disabled={busy} onClick={() => act(() => api.post<PushStatus>("/api/account/push/disable"), "Notifications are off")}>
              Turn off
            </button>
          </div>
        </>
      )}
    </div>
  );
}
