import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { APP_URL, STATIC_SITE } from "../env";
import { useAuth } from "../state";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Aurex` : "Aurex — Money, AI and markets in one place";
  }, [title]);
}

export function Section({ id, tone, children }: { id?: string; tone?: "plain" | "warm" | "ink"; children: ReactNode }) {
  return (
    <section id={id} className={`site-section ${tone ?? "plain"}`}>
      <div className="site-container">{children}</div>
    </section>
  );
}

export function SectionHead({ eyebrow, title, lead, center }: { eyebrow?: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <div className={`section-head ${center ? "center" : ""}`}>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h2>{title}</h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  );
}

/**
 * Link into the app (sign-up, sign-in, dashboard). In the app build it's a router link; on the
 * static website it points at APP_URL, or renders `fallback` while the app isn't live yet.
 */
export function AppLink({ to, className, children, fallback = null }: { to: string; className?: string; children: ReactNode; fallback?: ReactNode }) {
  if (!STATIC_SITE) return <Link className={className} to={to}>{children}</Link>;
  if (APP_URL) return <a className={className} href={APP_URL + to}>{children}</a>;
  return <>{fallback}</>;
}

export function PrimaryCta({ children = "Create free account" }: { children?: ReactNode }) {
  const { user } = useAuth();
  return (
    <AppLink className="btn lg" to={user ? "/app" : "/register"} fallback={<span className="btn lg soon" aria-disabled="true">Launching soon</span>}>
      {user ? "Open your dashboard" : children}
    </AppLink>
  );
}

export function CtaBand({ title = "Start with Aurex today", lead = "Free to open. Send money, ask any AI and practise trading in minutes." }: { title?: string; lead?: string }) {
  return (
    <section className="cta-band">
      <div className="site-container cta-inner">
        <div>
          <h2>{title}</h2>
          <p>{lead}</p>
        </div>
        <div className="row wrap">
          <PrimaryCta />
          <Link className="btn lg secondary" to="/features">Explore features</Link>
        </div>
      </div>
    </section>
  );
}

export function Check({ children }: { children: ReactNode }) {
  return (
    <li className="check">
      <span className="check-dot" aria-hidden="true">✓</span>
      <span>{children}</span>
    </li>
  );
}

export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="faq">
      {items.map((it) => (
        <details key={it.q}>
          <summary>
            {it.q}
            <span className="faq-icon" aria-hidden="true"><Icon.Plus size={16} /></span>
          </summary>
          <div className="faq-a">{it.a}</div>
        </details>
      ))}
    </div>
  );
}

/** A static, illustrative composite of the app: wallet, AI chat and an AI trading signal. */
export function ProductPreview() {
  return (
    <div className="preview-stack" aria-hidden="true">
      <div className="pv-card pv-wallet">
        <div className="row between">
          <span className="muted small">Total balance</span>
          <span className="pill good">▲ 2.4% this month</span>
        </div>
        <div className="pv-amount num">$12,480.55</div>
        <div className="pv-row">
          <span className="tx-icon in"><Icon.ArrowDown size={14} /></span>
          <div className="grow"><strong>From @amara</strong><div className="faint xs">Rent split</div></div>
          <strong className="num good">+$450.00</strong>
        </div>
        <div className="pv-row">
          <span className="tx-icon out"><Icon.ArrowUp size={14} /></span>
          <div className="grow"><strong>To @kofi</strong><div className="faint xs">Dinner</div></div>
          <strong className="num">−$38.20</strong>
        </div>
      </div>
      <div className="pv-card pv-chat">
        <div className="pv-bubble user">Summarise this week's market moves in 3 bullets</div>
        <div className="pv-bubble ai">
          <span className="pv-model"><Icon.Sparkle size={12} /> Claude Opus 5.5</span>
          Tech led gains as chip makers rallied; bond yields eased; energy lagged on softer oil prices.
        </div>
      </div>
      <div className="pv-card pv-signal">
        <div className="row between">
          <div>
            <div className="faint xs">AI analyst · NVDA</div>
            <div className="pv-action good">▲ BUY</div>
          </div>
          <div style={{ width: 96 }}>
            <div className="row between xs"><span className="muted">Confidence</span><strong>72%</strong></div>
            <div className="meter"><div style={{ width: "72%" }} /></div>
          </div>
        </div>
        <svg viewBox="0 0 220 56" width="100%" height="56" className="pv-spark">
          <path d="M2 44 L22 40 L38 46 L56 34 L74 37 L92 26 L110 30 L128 20 L146 24 L164 14 L184 18 L204 8 L218 10" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="faint xs">Stop 131.40 · Target 158.90 · Needs your confirmation</div>
      </div>
    </div>
  );
}

export const PROVIDERS = ["Claude", "GPT", "Gemini", "Mistral", "Llama", "Grok", "DeepSeek", "OpenRouter", "Together", "Perplexity", "Ollama"];
