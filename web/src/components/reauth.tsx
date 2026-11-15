import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, setReauthHandler } from "../api";
import { useAuth } from "../state";
import { Icon } from "./icons";
import { ErrorText, Field, Modal } from "./ui";

/**
 * Shows "Confirm it's you" whenever the server asks for a fresh password (and 2FA) check before a
 * sensitive action, then lets the original request continue.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  return (
    <>
      {children}
      {open && user && <ReauthDialog totp={user.totpEnabled} onDone={() => finish(true)} onCancel={() => finish(false)} />}
    </>
  );
}

function ReauthDialog({ totp, onDone, onCancel }: { totp: boolean; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/reauth", { password, code: totp ? code : undefined });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "totp_invalid" ? "That code didn't work. Wait for a new one and try again." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Confirm it's you" onClose={onCancel}>
      <form className="stack" onSubmit={submit}>
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <span className="pillar-ico" style={{ flex: "none" }}><Icon.Shield size={18} /></span>
          <p className="muted small" style={{ margin: 0 }}>
            For your security, sensitive actions like withdrawals need your password{totp ? " and a code from your authenticator app" : ""}. You won't be asked again for a few minutes.
          </p>
        </div>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </Field>
        {totp && (
          <Field
            label={useRecovery ? "Recovery code" : "Authenticator code"}
            hint={
              <button type="button" className="link-btn" onClick={() => { setUseRecovery(!useRecovery); setCode(""); }}>
                {useRecovery ? "Use your authenticator app instead" : "Lost your phone? Use a recovery code"}
              </button>
            }
          >
            <input
              className="input num"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              maxLength={useRecovery ? 14 : 6}
              value={code}
              onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
              required
            />
          </Field>
        )}
        <ErrorText error={error} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={busy || !password || (totp && !code)}>{busy ? "Checking…" : "Confirm"}</button>
        </div>
      </form>
    </Modal>
  );
}
