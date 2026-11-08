import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { useAuth } from "../state";
import { Check, CtaBand, PROVIDERS, Section, SectionHead, usePageTitle } from "./common";

export function FeaturesPage() {
  usePageTitle("Features");
  const { meta } = useAuth();
  const spread = ((meta?.fees.fxSpreadBps ?? 50) / 100).toFixed(2);
  const cash = (meta?.trading.paperStartingCash ?? 100000).toLocaleString("en-US");
  const cap = Math.round((meta?.trading.aiMaxPositionPct ?? 0.1) * 100);
  const rails = (meta?.rails ?? []).map((r) => r.name);

  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Features</span>
          <h1>Three apps' worth of power. <span className="gold-text">One calm place.</span></h1>
          <p className="lead">Everything in Aurex shares one account, one security model and one design, so moving between paying, asking and investing feels effortless.</p>
        </div>
      </section>

      <Section id="payments">
        <div className="split">
          <div>
            <SectionHead eyebrow="Payments" title="Pay anyone, in their currency" lead="Send money by @handle or email in seconds, keep balances in several currencies, and settle up without awkward reminders." />
            <ul className="check-list">
              <Check>Send by @handle or email, with a note for what it's for</Check>
              <Check>Request money and let friends pay with one tap</Check>
              <Check>Hold {meta?.currencies.length ?? 19} currencies, including USD, EUR, GBP, KES, ZMW, NGN and ZAR</Check>
              <Check>Convert between them at the market rate plus a {spread}% spread, shown before you confirm</Check>
              <Check>Add and withdraw money with the methods available in your region{rails.length ? ` (now: ${rails.join(", ")})` : ""}</Check>
            </ul>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Send size={16} /> Send money</div>
            <div className="fv-field"><span className="faint xs">To</span><strong>@kofi · Kofi Mensah</strong></div>
            <div className="fv-field"><span className="faint xs">Amount</span><strong className="num">KSh 5,000.00</strong></div>
            <div className="fv-field"><span className="faint xs">For</span><strong>Groceries 🛒</strong></div>
            <div className="btn block" style={{ pointerEvents: "none" }}>Send KSh 5,000.00</div>
          </div>
        </div>
      </Section>

      <Section id="ai" tone="warm">
        <div className="split reverse">
          <div>
            <SectionHead eyebrow="AI Hub" title="Every leading AI model, one conversation" lead="Pick the best model for each question instead of paying for five subscriptions. Switch mid-conversation; your history comes with you." />
            <ul className="check-list">
              <Check>Answers stream in as they're written, with formatting and code</Check>
              <Check>Compare up to four models side by side on the same prompt</Check>
              <Check>Bring your own API keys; they're encrypted and never shown again</Check>
              <Check>Saved conversations you can return to and delete any time</Check>
              <Check>A built-in assistant that works before you connect anything</Check>
            </ul>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Sparkle size={16} /> Compare models</div>
            <div className="provider-grid">
              {PROVIDERS.map((p) => (
                <span key={p} className="pill">{p}</span>
              ))}
            </div>
            <div className="compare-mini">
              <div><span className="faint xs">Claude</span><p>Compound interest means you earn interest on your interest…</p></div>
              <div><span className="faint xs">Gemini</span><p>Think of it as a snowball: each year's growth is added to…</p></div>
            </div>
          </div>
        </div>
      </Section>

      <Section id="trading">
        <div className="split">
          <div>
            <SectionHead eyebrow="AI trading" title="An analyst on your side, not in your seat" lead="Aurex's AI analyst reads the trend, momentum and volatility of any stock and proposes a trade, sized and with exits, then waits for you." />
            <ul className="check-list">
              <Check>Practise with ${cash} of paper money on every account</Check>
              <Check>Connect your own Alpaca account for live market data and brokerage</Check>
              <Check>Signals cite moving averages, RSI, MACD, volatility and recent returns</Check>
              <Check>Every AI order needs your confirmation and is capped at {cap}% of your portfolio</Check>
              <Check>Watchlists, limit orders, positions and full order history</Check>
            </ul>
            <p className="faint small">AI signals are educational decision aids, not financial advice.</p>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Chart size={16} /> AI analyst · MSFT</div>
            <div className="row between">
              <div className="pv-action">• HOLD</div>
              <span className="pill">58% confidence</span>
            </div>
            <p className="small muted">Price is above its 50-day average and RSI is neutral, but momentum has faded over the last week. Evidence is mixed, so holding is the disciplined call.</p>
            <div className="kv">
              <div><span>RSI 14</span><strong>52.4</strong></div>
              <div><span>20d return</span><strong>+1.8%</strong></div>
              <div><span>Volatility</span><strong>21%</strong></div>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="warm">
        <SectionHead center eyebrow="And everywhere" title="Thoughtful details throughout" />
        <div className="mini-grid">
          {[
            ["Light & dark", "White and gold by day, black and gold by night."],
            ["Works on any screen", "Designed for phones first, roomy on desktops."],
            ["Activity log", "See every sign-in and sensitive change on your account."],
            ["Two-factor sign-in", "Protect your account with any authenticator app."],
          ].map(([t, d]) => (
            <div key={t} className="mini">
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
        <p style={{ textAlign: "center", marginTop: 24 }}>
          <Link to="/security">Read about security →</Link>
        </p>
      </Section>

      <CtaBand />
    </>
  );
}
