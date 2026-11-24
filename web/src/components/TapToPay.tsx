import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cancelNfc, NfcError, nfcStatus, onShareStopped, openNfcSettings, payPathForTag, readTag, startSharing, stopSharing, writeTag, type NfcStatus } from "../nfc";
import { platform } from "../native";
import { Modal } from "./ui";

/** NFC support on this device, checked once. */
export function useNfc() {
  const [status, setStatus] = useState<NfcStatus | null>(null);
  useEffect(() => {
    void nfcStatus().then(setStatus);
  }, []);
  return { status, refresh: () => nfcStatus().then(setStatus) };
}

function Pulse() {
  return (
    <div className="nfc-pulse" aria-hidden="true">
      <span /><span /><span />
      <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 7.5a6.5 6.5 0 0 1 0 9M10.5 5a10 10 0 0 1 0 14M14 3a13.5 13.5 0 0 1 0 18" /></svg>
    </div>
  );
}

function NfcOff({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="stack" style={{ textAlign: "center" }}>
      <p>NFC is turned off on this phone.</p>
      <div className="row" style={{ justifyContent: "center", gap: 8 }}>
        <button className="btn" onClick={() => void openNfcSettings()}>Open NFC settings</button>
        <button className="btn ghost" onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}

/** Android: this phone presents the pay link; the other phone reads it like a sticker, no app needed. */
export function ShareByTapDialog({ url, summary, onClose }: { url: string; summary: string; onClose: () => void }) {
  const [state, setState] = useState<"starting" | "sharing" | "stopped" | "off" | "error">("starting");
  const [error, setError] = useState("");
  const [left, setLeft] = useState(120);
  const startedAt = useRef(0);

  async function start() {
    setState("starting");
    try {
      await startSharing(url, 120);
      startedAt.current = Date.now();
      setLeft(120);
      setState("sharing");
    } catch (e) {
      const err = e as NfcError;
      if (err.code === "disabled") setState("off");
      else { setError(err.message); setState("error"); }
    }
  }
  useEffect(() => {
    void start();
    const sub = onShareStopped(() => setState((s) => (s === "sharing" ? "stopped" : s)));
    return () => {
      void stopSharing();
      void sub.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useEffect(() => {
    if (state !== "sharing") return;
    const t = window.setInterval(() => setLeft(Math.max(0, 120 - Math.round((Date.now() - startedAt.current) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  return (
    <Modal title="Tap phones to get paid" onClose={onClose}>
      <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 14 }}>
        {state === "off" && <NfcOff onRetry={() => void start()} />}
        {state === "error" && <p className="error-text">{error}</p>}
        {(state === "sharing" || state === "starting") && (
          <>
            <Pulse />
            <p style={{ fontWeight: 600, fontSize: 18 }}>{summary}</p>
            <p className="muted small" style={{ maxWidth: 340 }}>
              Ask them to hold their phone against the back of yours, with NFC on. Their phone opens your pay link, even without the Aurex app.
            </p>
            {state === "sharing" && <p className="faint small">Sharing for {left} more seconds · keep Aurex open</p>}
          </>
        )}
        {state === "stopped" && (
          <>
            <p>Stopped sharing.</p>
            <button className="btn" onClick={() => void start()}>Share again</button>
          </>
        )}
        <button className="btn ghost sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** Write the pay link to an NFC sticker for a stall, a counter or a door. */
export function WriteStickerDialog({ url, summary, onClose }: { url: string; summary: string; onClose: () => void }) {
  const [lock, setLock] = useState(true);
  const [state, setState] = useState<"ready" | "waiting" | "done" | "off">("ready");
  const [result, setResult] = useState<{ locked: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => () => cancelNfc(), []);

  async function write() {
    setError("");
    setState("waiting");
    try {
      setResult(await writeTag(url, lock));
      setState("done");
    } catch (e) {
      const err = e as NfcError;
      if (err.code === "disabled") setState("off");
      else {
        if (err.code !== "cancelled") setError(err.message);
        setState("ready");
      }
    }
  }

  return (
    <Modal title="Write to an NFC sticker" onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {state === "off" && <NfcOff onRetry={() => void write()} />}
        {state === "ready" && (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Customers tap the sticker with their phone to open your pay link: <strong>{summary}</strong>. Any NFC sticker works (NTAG213 or bigger).
            </p>
            <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Lock the sticker so nobody can change the link to theirs. This can't be undone; write a new sticker if your link changes.</span>
            </label>
            {error && <p className="error-text">{error}</p>}
            <button className="btn block" onClick={() => void write()}>Write sticker</button>
          </>
        )}
        {state === "waiting" && (
          <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
            <Pulse />
            <p>Hold the sticker against the {platform === "ios" ? "top" : "back"} of your phone.</p>
            <button className="btn ghost sm" onClick={() => { cancelNfc(); setState("ready"); }}>Cancel</button>
          </div>
        )}
        {state === "done" && (
          <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
            <p style={{ fontWeight: 600 }}>{result?.locked ? "Written and locked." : "Written."}</p>
            <p className="muted small">Stick it where customers can reach it, and test it with another phone.</p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost sm" onClick={() => setState("ready")}>Write another</button>
              <button className="btn sm" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Pay by tapping an Aurex sticker or a phone that's sharing a pay link. */
export function ScanToPayDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [state, setState] = useState<"waiting" | "off" | "error">("waiting");
  const [error, setError] = useState("");

  async function scan() {
    setState("waiting");
    try {
      const url = await readTag();
      const path = payPathForTag(url);
      if (!path) {
        setError("That isn't an Aurex pay link, so it wasn't opened.");
        setState("error");
        return;
      }
      onClose();
      navigate(path);
    } catch (e) {
      const err = e as NfcError;
      if (err.code === "cancelled") return onClose();
      if (err.code === "disabled") setState("off");
      else { setError(err.message); setState("error"); }
    }
  }
  useEffect(() => {
    void scan();
    return () => cancelNfc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title="Tap to pay" onClose={onClose}>
      <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 14 }}>
        {state === "off" && <NfcOff onRetry={() => void scan()} />}
        {state === "waiting" && (
          <>
            <Pulse />
            <p>Hold the {platform === "ios" ? "top" : "back"} of your phone near the Aurex sticker or the other person's phone.</p>
            <p className="faint small">You'll see who you're paying and the amount before anything is sent.</p>
          </>
        )}
        {state === "error" && (
          <>
            <p className="error-text">{error}</p>
            <button className="btn" onClick={() => void scan()}>Try again</button>
          </>
        )}
        <button className="btn ghost sm" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
