import { useCallback, useEffect, useState, type ReactNode } from "react";
import { lockOnStart, onLockRequired, unlockWithBiometrics, biometryAvailable, setAuthToken } from "../native";
import { Logo } from "./Logo";

/**
 * In the apps, with "Unlock with Face ID / fingerprint" switched on: the app asks for biometrics (or
 * the device passcode) when it opens with a saved session, and when it comes back after a minute
 * away. Nothing is shown behind the lock screen until the person passes.
 */
export function AppLock({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(lockOnStart);
  const [label, setLabel] = useState("biometrics");
  const [failed, setFailed] = useState(false);

  const unlock = useCallback(async () => {
    setFailed(false);
    if (await unlockWithBiometrics()) setLocked(false);
    else setFailed(true);
  }, []);

  useEffect(() => {
    const off = onLockRequired(() => setLocked(true));
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    if (!locked) return;
    void biometryAvailable().then((b) => setLabel(b.label || "biometrics"));
    void unlock();
  }, [locked, unlock]);

  if (!locked) return <>{children}</>;
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div className="brand" style={{ justifyContent: "center", padding: "0 0 18px" }}>
          <Logo size={34} />
          <span>Aurex</span>
        </div>
        <div className="card" style={{ padding: 26 }}>
          <h1 style={{ fontSize: 22 }}>Aurex is locked</h1>
          <p className="muted small" style={{ margin: "6px 0 18px" }}>Unlock with {label} or your phone's passcode.</p>
          {failed && <p className="small bad" style={{ marginTop: 0 }}>That didn't work. Try again.</p>}
          <button className="btn block" onClick={unlock}>Unlock</button>
          <button
            className="link-btn small"
            style={{ marginTop: 14 }}
            onClick={async () => {
              await setAuthToken(null);
              window.location.replace("/login");
            }}
          >
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
