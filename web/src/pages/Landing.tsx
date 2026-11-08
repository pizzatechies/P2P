import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { ThemeButton } from "../components/Layout";
import { useAuth } from "../state";

const PROVIDERS = ["Claude", "GPT", "Gemini", "Mistral", "Llama (Groq)", "Grok", "DeepSeek", "OpenRouter", "Perplexity", "Ollama"];

export function LandingPage() {
  const { user } = useAuth();
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Link to="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark"><Icon.Swap size={17} /></span>
          <span>P2P Hub</span>
        </Link>
        <div className="row">
          <ThemeButton />
          {user ? (
            <Link className="btn" to="/app">Open app</Link>
          ) : (
            <>
              <Link className="btn ghost" to="/login">Sign in</Link>
              <Link className="btn" to="/register">Create account</Link>
            </>
          )}
        </div>
      </nav>

      <section className="hero">
        <div>
          <span className="pill brand">Payments · AI · Investing</span>
          <h1 style={{ marginTop: 16 }}>Money, AI and markets in one place.</h1>
          <p className="lead">
            Send and request money in 19 currencies, chat with every major AI model from one screen, and trade
            stocks with an AI analyst that explains its reasoning and waits for your go-ahead.
          </p>
          <div className="row wrap">
            <Link className="btn lg" to={user ? "/app" : "/register"}>{user ? "Go to dashboard" : "Get started free"}</Link>
            <Link className="btn lg secondary" to={user ? "/app/trading" : "/login"}>{user ? "Open trading" : "I have an account"}</Link>
          </div>
        </div>
        <div className="hero-card" aria-hidden="true">
          <div className="row between">
            <span className="muted small">Total balance</span>
            <span className="pill good">▲ 2.4% this month</span>
          </div>
          <div className="stat-value" style={{ fontSize: 34, margin: "6px 0 18px" }}>$12,480.55</div>
          <div className="list">
            {[
              { t: "From @amara", s: "Rent split", a: "+$450.00", in: true },
              { t: "To @kofi", s: "Dinner", a: "−$38.20", in: false },
              { t: "AI analyst · NVDA", s: "BUY signal · 72% confidence", a: "Review", in: true },
            ].map((r) => (
              <div className="list-item" key={r.t}>
                <span className={`tx-icon ${r.in ? "in" : "out"}`}>{r.in ? <Icon.ArrowDown size={16} /> : <Icon.ArrowUp size={16} />}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{r.t}</div>
                  <div className="faint small">{r.s}</div>
                </div>
                <strong className="num">{r.a}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="features">
        <div className="feature">
          <div className="ico"><Icon.Send /></div>
          <h3>Peer-to-peer payments</h3>
          <p>
            Send by @handle or email, request money, split costs and convert between currencies. Every cent is tracked
            in a double-entry ledger with idempotent transfers and daily limits.
          </p>
        </div>
        <div className="feature">
          <div className="ico"><Icon.Sparkle /></div>
          <h3>Every AI model, one hub</h3>
          <p>Chat with any provider, compare answers side by side, and bring your own API keys, stored encrypted.</p>
          <div className="provider-strip">
            {PROVIDERS.map((p) => (
              <span className="pill" key={p}>{p}</span>
            ))}
          </div>
        </div>
        <div className="feature">
          <div className="ico"><Icon.Chart /></div>
          <h3>AI-assisted trading</h3>
          <p>
            Practise with $100k of paper money or connect your Alpaca account. The AI analyst reads the indicators,
            proposes a sized trade with stop-loss and target, and you decide.
          </p>
        </div>
      </section>
      <p className="foot-note">
        P2P Hub runs in sandbox mode by default: deposits and withdrawals are simulated until an operator connects a
        licensed payment provider. AI trading signals are educational decision aids, not financial advice. Investing
        involves risk, including loss of principal.
      </p>
    </div>
  );
}
