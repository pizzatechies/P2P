import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useAuth, useToast } from "../state";
import type { User } from "../types";
import { Icon } from "./icons";
import { ErrorText, Field, Modal } from "./ui";

/** Enter the 6-digit code emailed to the user (sends one first unless a code was just sent at sign-up). */
export function VerifyEmailDialog({ onClose, initialDevCode }: { onClose: () => void; initialDevCode?: string | null }) {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(initialDevCode ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(Boolean(initialDevCode));

  async function send() {
    setError(null);
    try {
      const r = await api.post<{ sent: boolean; verified?: boolean; devCode?: string }>("/api/auth/email/send");
      if (r.verified) return onClose();
      setSent(true);
      setDevCode(r.devCode ?? null);
      toast("Code sent. Check your inbox (and spam folder).");
    } catch (err) {
      // A code sent moments ago (e.g. at sign-up) is still valid.
      if (err instanceof ApiError && err.code === "too_soon") setSent(true);
      else setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (!initialDevCode) void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>("/api/auth/email/verify", { code });
      setUser(r.user);
      toast("Email verified");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Verify your email" onClose={onClose}>
      <form className="stack" onSubmit={verify}>
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <span className="pillar-ico" style={{ flex: "none" }}><Icon.Mail size={18} /></span>
          <p className="muted small" style={{ margin: 0 }}>
            {sent ? <>We sent a 6-digit code to <strong>{user?.email}</strong>. It expires in 15 minutes.</> : "Sending a code…"} Verifying protects payments sent to your email and unlocks withdrawals.
          </p>
        </div>
        {devCode && <div className="banner info">Development mode: no email is sent. Your code is <strong className="mono">{devCode}</strong></div>}
        <Field label="Verification code">
          <input className="input num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus style={{ maxWidth: 200, letterSpacing: "0.2em" }} />
        </Field>
        <ErrorText error={error} />
        <div className="row between">
          <button type="button" className="link-btn" onClick={send}>Send a new code</button>
          <button className="btn" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify"}</button>
        </div>
      </form>
    </Modal>
  );
}
