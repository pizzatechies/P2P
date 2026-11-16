import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { useAuth } from "../state";
import { CtaBand, Faq, LINK_PARTNERS, MONEY_PARTNERS, PrimaryCta, ProductPreview, PROVIDERS, Section, SectionHead, usePageTitle } from "./common";
import { DemoVideo } from "./Demo";

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
              Send and request money in {currencies} currencies, pay in and out with M-Pesa, MTN MoMo, PayPal, Skrill or a bank in
              160+ countries, chat with every major AI model, and learn to trade in a free demo account before you ever risk real
              money.
            </p>
            <div className="row wrap">
              <PrimaryCta />
              <a className="btn lg secondary" href="#demo">Watch the demo</a>
            </div>
            <ul className="hero-points">
              <li>Free to open</li>
              <li>{currencies} currencies</li>
              <li>M-Pesa, PayPal, Skrill &amp; MoneyGram</li>
              <li>Free demo trading account</li>
              <li>{PROVIDERS.length} AI providers</li>
            </ul>
          </div>
          <ProductPreview />
        </div>
      </section>

      <div className="provider-band">
        <div className="site-container provider-inner">
          <span className="faint small">AI from</span>
          {PROVIDERS.map((p) => (
            <span key={p} className="provider-name">{p}</span>
          ))}
        </div>
        <div className="site-container provider-inner" style={{ paddingTop: 0 }}>
          <span className="faint small">Money through</span>
          {[...MONEY_PARTNERS, ...LINK_PARTNERS].map((p) => (
            <span key={p} className="provider-name">{p}</span>
          ))}
        </div>
      </div>

      <Section id="demo">
        <SectionHead center eyebrow="Watch the demo" title="Aurex in 55 seconds" lead="Sign up, top up with M-Pesa, send money, link your bank, ask an AI, learn to trade and lock down your account, all in one tour." />
        <div className="demo-home">
          <DemoVideo />
          <p style={{ textAlign: "center", marginTop: 14 }}>
            <Link to="/demo">Jump to a chapter →</Link>
          </p>
        </div>
      </Section>

      <Section>
        <SectionHead center eyebrow="One app, four superpowers" title="Everything you do with money online" lead="Stop juggling a payments app, an AI subscription, a brokerage and a spreadsheet of accounts. Aurex brings them together with one account and one standard of care." />
        <div className="pillars four">
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
          <Link to="/features#connections" className="pillar">
            <span className="pillar-ico"><Icon.Link /></span>
            <h3>Connected to all your money</h3>
            <p>Pay in and cash out with M-Pesa, MTN MoMo, PayPal, Venmo, Skrill, MoneyGram cash pickup or a bank in 160+ countries, and see your banks, brokerages and Coinbase in one net worth.</p>
            <span className="pillar-link">Connections →</span>
          </Link>
        </div>
      </Section>

      <Section id="how" tone="warm">
        <SectionHead center eyebrow="How it works" title="Up and running in three steps" />
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <h3>Create your account</h3>
            <p>Pick a handle and your main currency, confirm your email, and switch on two-factor sign-in.</p>
          </li>
          <li>
            <span className="step-n">2</span>
            <h3>Add money or connect</h3>
            <p>Top up with M-Pesa, MoMo, PayPal, Skrill or card, link your bank, brokerage or Coinbase, and open your demo trading account.</p>
          </li>
          <li>
            <span className="step-n">3</span>
            <h3>Send, ask, learn, invest</h3>
            <p>Pay friends instantly, get answers from any model, learn the basics, then upgrade to a real account when you're ready.</p>
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

      <Section id="learn" tone="warm">
        <div className="split reverse">
          <div>
            <SectionHead
              eyebrow="Learn to trade"
              title="Practise first. Go live when you're ready."
              lead="Every account comes with a demo account of virtual money and a free academy. Learn the essentials, practise with real market behaviour, and only then open a real account."
            />
            <ol className="journey">
              <li><strong>Learn</strong><span>Six short lessons with quizzes: markets, order types, risk, charts, AI and going live.</span></li>
              <li><strong>Practise</strong><span>Trade a demo account with $1,000 to $1,000,000 of virtual money and complete practice missions.</span></li>
              <li><strong>Go live</strong><span>A short questionnaire and review, then trade through your own licensed broker.</span></li>
            </ol>
            <Link className="btn secondary" to="/features#learn">Explore the academy</Link>
          </div>
          <div className="feature-visual" aria-hidden="true">
            <div className="fv-title"><Icon.Learn size={16} /> Trading academy</div>
            <div className="fv-field"><span className="faint xs">Your progress</span><strong className="num">67%</strong></div>
            <div className="progress" style={{ marginTop: 0, marginBottom: 10 }}><span style={{ width: "67%" }} /></div>
            {[
              ["How the stock market works", "Passed 100%"],
              ["Market and limit orders", "Passed 80%"],
              ["Risk, position size and stop-losses", "Passed 100%"],
              ["Reading a price chart", "Start"],
            ].map(([t, s]) => (
              <div key={t} className="row between small" style={{ padding: "7px 2px", borderBottom: "1px solid var(--border)" }}>
                <span>{t}</span>
                <span className={`pill ${s === "Start" ? "" : "good"}`}>{s}</span>
              </div>
            ))}
            <div className="row between small" style={{ padding: "10px 2px 0" }}>
              <span className="faint">Demo account</span>
              <strong className="num">$10,482.16</strong>
            </div>
          </div>
        </div>
      </Section>

      <Section tone="warm">
        <div className="split">
          <div>
            <SectionHead eyebrow="Built to be trusted" title="Accounted for to the cent" lead="Every payment is recorded in a double-entry ledger, the same principle banks use, so balances always add up and nothing is ever lost or created by mistake." />
            <ul className="check-list">
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Two-factor sign-in with recovery codes, and verified email addresses</span></li>
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Your password is checked again before money leaves your account</span></li>
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Retries can never pay twice; deposits are confirmed with the provider</span></li>
              <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Daily limits, device list and alerts for every security change</span></li>
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
            { q: "Can I use M-Pesa, MTN MoMo, PayPal, Skrill or MoneyGram?", a: "Yes, where the Aurex operator has switched them on. Add money with an M-Pesa or MoMo PIN prompt on your phone, PayPal or Skrill, and withdraw to M-Pesa, MoMo, PayPal, Venmo (US), Skrill, a bank account in 160+ countries through Wise, or cash at a MoneyGram location." },
            { q: "How is my account protected?", a: "Two-factor sign-in with recovery codes, lockouts after repeated wrong guesses, alerts for new devices, a password re-check before money leaves, and a 24-hour pause on withdrawals after any security change, so a stolen password alone can't empty your wallet." },
            { q: "Can I see my other bank and crypto accounts?", a: "Yes. Connections links banks and cards (Plaid, Salt Edge, Mono), brokerages (SnapTrade) and Coinbase, read-only. You approve access on the provider's own page and can disconnect at any time." },
            { q: "Will the AI trade for me?", a: "Only if you want it to. By default the AI analyst suggests trades and waits for you. Switch on AI Autopilot and it trades for you on a schedule, strictly inside limits you set: a maximum per position and in total, trades per day, a minimum confidence, and a daily loss limit that pauses it. You can also have it ask before every trade, and pause it any time." },
            { q: "Can I practise before using real money?", a: "Yes. Every account starts with a demo account of virtual money and a free academy of short lessons, quizzes and practice missions. When you're ready, upgrade to a real account after a short questionnaire and review, and trade through your own licensed broker." },
            { q: "Can I run my own Aurex?", a: <>Yes. Launch your own copy on Microsoft Azure with one click (free for 12 months on a new Azure account), or on AWS, Render or any Ubuntu server, with HTTPS and backups set up for you. See <Link to="/hosting">hosting</Link>.</> },
            { q: "Is my money real right now?", a: "Aurex is currently in sandbox mode: deposits and withdrawals use test money while licensed payment partners are being connected. Transfers between users work exactly as they will with real funds." },
          ]}
        />
      </Section>

      <CtaBand />
    </>
  );
}
