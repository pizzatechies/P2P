import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { useAuth } from "../state";
import { CtaBand, Faq, PrimaryCta, ProductPreview, PROVIDERS, Section, SectionHead, usePageTitle } from "./common";

export function HomePage() {
  usePageTitle("");
  const { meta } = useAuth();
  const sendFee = meta ? (meta.fees.p2pBps === 0 ? "Free" : `${(meta.fees.p2pBps / 100).toFixed(2)}%`) : "Free";
  const currencies = meta?.currencies.length ?? 19;

  return (
    <>
      <section className="site-hero">
        <div className="site-container hero-grid">
          <div>
            <span className="eyebrow">Payments · AI · Markets</span>
            <h1>
              Money, AI and markets, <span className="gold-text">all in one place.</span>
            </h1>
            <p className="lead">
              Send and request money in {currencies} currencies, chat with every major AI model from one screen, and trade
              stocks with an AI analyst that explains its reasoning and waits for your go-ahead.
            </p>
            <div className="row wrap">
              <PrimaryCta />
              <a className="btn lg secondary" href="#how">See how it works</a>
            </div>
            <ul className="hero-points">
              <li>Free to open</li>
              <li>{currencies} currencies</li>
              <li>{PROVIDERS.length} AI providers</li>
              <li>Two-factor sign-in</li>
            </ul>
          </div>
          <ProductPreview />
        </div>
      </section>

      <div className="provider-band">
        <div className="site-container provider-inner">
          <span className="faint small">Works with</span>
          {PROVIDERS.map((p) => (
            <span key={p} className="provider-name">{p}</span>
          ))}
        </div>
      </div>

      <Section>
        <SectionHead center eyebrow="One app, three superpowers" title="Everything you do with money online" lead="Stop juggling a payments app, an AI subscription and a brokerage. Aurex brings them together with one account and one standard of care." />
        <div className="pillars">
          <Link to="/features#payments" className="pillar">
            <span className="pillar-ico"><Icon.Send /></span>
            <h3>Peer-to-peer payments</h3>
            <p>Send by @handle or email, request money, split costs and convert between currencies at transparent rates.</p>
            <span className="pillar-link">Payments →</span>
          </Link>
          <Link to="/features#ai" className="pillar">
            <span className="pillar-ico"><Icon.Sparkle /></span>
            <h3>Every AI model, one hub</h3>
            <p>Claude, GPT, Gemini, Llama, Grok and more in one chat. Compare answers side by side and keep your history.</p>
            <span className="pillar-link">AI Hub →</span>
          </Link>
          <Link to="/features#trading" className="pillar">
            <span className="pillar-ico"><Icon.Chart /></span>
            <h3>AI-assisted trading</h3>
            <p>An analyst that reads the charts, sizes the trade and sets a stop-loss, and an autopilot that can trade for you within your limits.</p>
            <span className="pillar-link">Trading →</span>
          </Link>
        </div>
      </Section>

      <Section id="how" tone="warm">
        <SectionHead center eyebrow="How it works" title="Up and running in three steps" />
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <h3>Create your account</h3>
            <p>Pick a handle, choose your main currency and switch on two-factor sign-in.</p>
          </li>
          <li>
            <span className="step-n">2</span>
            <h3>Add money or connect</h3>
            <p>Top up your wallet, add your favourite AI provider, and get $100k of practice cash for trading.</p>
          </li>
          <li>
            <span className="step-n">3</span>
            <h3>Send, ask, invest</h3>
            <p>Pay friends instantly, get answers from any model, and act on AI trade ideas you approve.</p>
          </li>
        </ol>
      </Section>

      <Section>
        <div className="stat-band">
          <div><strong>{sendFee}</strong><span>to send money to anyone on Aurex</span></div>
          <div><strong>{currencies}</strong><span>currencies, from dollars to kwacha</span></div>
          <div><strong>{PROVIDERS.length}</strong><span>AI providers in one place</span></div>
          <div><strong>{Math.round((meta?.trading.aiMaxPositionPct ?? 0.1) * 100)}%</strong><span>max of your portfolio in any one AI trade</span></div>
        </div>
      </Section>

      <Section tone="warm">
        <div className="split">
          <div>
            <SectionHead eyebrow="Built to be trusted" title="Accounted for to the cent" lead="Every payment is recorded in a double-entry ledger, the same principle banks use, so balances always add up and nothing is ever lost or created by mistake." />
            <ul className="check-list">
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Two-factor sign-in and encrypted API keys</span></li>
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Retries can never pay twice</span></li>
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Daily limits and a full activity log</span></li>
            </ul>
            <Link className="btn secondary" to="/security">How we protect you</Link>
          </div>
          <div className="ledger-card" aria-hidden="true">
            <div className="faint xs" style={{ marginBottom: 10 }}>Ledger entry · transfer</div>
            {[
              ["@amara wallet", "−$42.50"],
              ["@kofi wallet", "+$42.50"],
              ["Fees", "$0.00"],
            ].map(([a, b]) => (
              <div key={a} className="row between ledger-row"><span>{a}</span><strong className="num">{b}</strong></div>
            ))}
            <div className="row between ledger-total"><span>Balance check</span><strong className="good">✓ Sums to zero</strong></div>
          </div>
        </div>
      </Section>

      <Section>
        <SectionHead center eyebrow="Questions" title="Frequently asked" />
        <Faq
          items={[
            { q: "Is Aurex free?", a: <>Opening an account is free, and sending money to other Aurex users is {sendFee.toLowerCase()}. Currency conversion includes a small, clearly shown spread. See <Link to="/pricing">pricing</Link>.</> },
            { q: "Which AI models can I use?", a: "Claude, GPT, Gemini, Mistral, Llama (via Groq or Together), Grok, DeepSeek, Perplexity, self-hosted models via Ollama, and hundreds more through OpenRouter. A built-in assistant works with no setup at all." },
            { q: "Will the AI trade for me?", a: "Only if you want it to. By default the AI analyst suggests trades and waits for you. Switch on AI Autopilot and it trades for you on a schedule, strictly inside limits you set: a maximum per position and in total, trades per day, a minimum confidence, and a daily loss limit that pauses it. You can also have it ask before every trade, and pause it any time." },
            { q: "Can I practise before using real money?", a: "Yes. Every account includes a paper-trading portfolio with virtual cash, so you can try strategies and the AI analyst risk-free." },
            { q: "Is my money real right now?", a: "Aurex is currently in sandbox mode: deposits and withdrawals use test money while licensed payment partners are being connected. Transfers between users work exactly as they will with real funds." },
          ]}
        />
      </Section>

      <CtaBand />
    </>
  );
}
