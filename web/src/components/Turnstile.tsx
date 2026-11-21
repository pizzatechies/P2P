import { useEffect, useRef, useState } from "react";
import { useAuth } from "../state";

/**
 * Cloudflare Turnstile, shown only when the server has bot protection on (meta.captcha). Each token
 * works once, so forms call reset() after every submit to get a fresh one.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error("load failed"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (t: string) => onToken(t),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, onToken]);
  if (failed) return <p className="small bad" style={{ margin: 0 }}>The check that you're a person couldn't load. Check your connection and reload the page.</p>;
  return <div ref={ref} style={{ minHeight: 65 }} />;
}

export function useCaptcha() {
  const { meta } = useAuth();
  const siteKey = meta?.captcha?.siteKey ?? null;
  const [token, setToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  return {
    token,
    /** True when the form can be sent: no check needed, or it has been passed. */
    ready: !siteKey || Boolean(token),
    widget: siteKey ? <TurnstileWidget key={round} siteKey={siteKey} onToken={setToken} /> : null,
    reset: () => {
      if (!siteKey) return;
      setToken(null);
      setRound((r) => r + 1);
    },
  };
}
