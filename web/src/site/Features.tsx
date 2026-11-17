import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { useAuth } from "../state";
import { Check, CtaBand, PROVIDERS, Section, SectionHead, usePageTitle } from "./common";

export function FeaturesPage() {
  usePageTitle("Features");
  const { meta } = useAuth();
  const spread = ((meta?.fees.fxSpreadBps ?? 50) / 100).toFixed(2);
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
            <SectionHead eyebrow="Payments" title="Pay anyone, in their currency" lead="Send money by @handle, email or account number in seconds, keep balances in several currencies, and settle up without awkward reminders." />
            <ul className="check-list">
              <Check>Send by @handle, email or your 10-digit account number, with a note for what it's for</Check>
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
            <SectionHead eyebrow="Stocks · Crypto · Futures" title="Every market, with an analyst on your side" lead="Trade every US-listed stock and ETF, hundreds of coins around the clock, and futures on indexes, energy, metals, grains, rates, currencies and Bitcoin. The AI analyst reads the trend, momentum and volatility of any of them and proposes a trade, sized and with exits. Switch on Autopilot and it can act for you, inside rules you set." />
            <ul className="check-list">
              <Check>About 12,000 US stocks and ETFs, searchable by ticker or company name</Check>
              <Check>Hundreds of cryptocurrencies with live prices, traded in fractions, 24/7</Check>
              <Check>20 futures contracts, including micros, with real contract sizes, margin and leverage; go long or short in the demo account</Check>
              <Check>Start with a demo account of virtual money ($1,000 to $1,000,000), and restart it any time</Check>
              <Check>Learn the essentials in short lessons with quizzes, including crypto and futures, then complete practice missions</Check>
              <Check>Upgrade to a real account when you're ready: a short questionnaire, review, then your own licensed broker</Check>
              <Check>Connect your own Alpaca account for live stock prices and real stock and crypto trading</Check>
              <Check>Signals cite moving averages, RSI, MACD, volatility and recent returns</Check>
              <Check>AI Autopilot can trade for you on a schedule, or ask before each trade</Check>
              <Check>You set the limits: per position (up to {cap}%), total invested, trades per day, minimum confidence</Check>
              <Check>A daily loss limit pauses the autopilot automatically; stop-losses close its positions</Check>
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

      <Section id="learn" tone="warm">
        <div className="split reverse">
          <div>
            <SectionHead eyebrow="Learn to trade" title="A demo account and an academy, built in" lead="Learn the essentials, practise with virtual money, and upgrade to a real account only when you've shown you're ready." />
            <ul className="check-list">
              <Check>Demo account with $1,000 to $1,000,000 of virtual money; restart it whenever you like</Check>
              <Check>Six core lessons (how markets work, market and limit orders, risk and stop-losses, reading charts, trading with AI, going live), plus crypto and futures</Check>
              <Check>Each lesson ends with a quiz (80% to pass), with explanations for every answer</Check>
              <Check>Practice missions tick off as you trade: your first buy, a limit order, a sale, three different stocks and more</Check>
              <Check>Upgrade to a real account: verified email, two-factor sign-in, the academy, a few demo trades and a short questionnaire</Check>
              <Check>Real trades go through a licensed broker in your name; Aurex never holds your investments</Check>
            </ul>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Rocket size={16} /> Upgrade to a real account</div>
            {[
              ["Verify your email address", true],
              ["Turn on two-factor authentication", true],
              ["Pass all 6 academy quizzes", true],
              ["Make 3 trades in your demo account", true],
              ["Complete your profile and questionnaire", false],
            ].map(([t, done]) => (
              <div key={String(t)} className="row small" style={{ gap: 10, padding: "8px 2px", borderBottom: "1px solid var(--border)" }}>
                <span className={`mission-check ${done ? "done" : ""}`} aria-hidden="true">{done ? "✓" : ""}</span>
                <span>{t}</span>
              </div>
            ))}
            <p className="faint xs" style={{ margin: "10px 0 0" }}>Applications are reviewed before real-money trading is unlocked.</p>
          </div>
        </div>
      </Section>

      <Section id="connections">
        <div className="split reverse">
          <div>
            <SectionHead eyebrow="Connections" title="All your money, wherever it lives" lead="Link banks, brokerages and crypto from around the world and see every balance, and your net worth, next to your Aurex wallet." />
            <ul className="check-list">
              <Check>Banks and cards across North America, the UK and Europe, through Plaid</Check>
              <Check>Banks in dozens more countries through Salt Edge, and African banks through Mono</Check>
              <Check>Brokerages such as Schwab, Fidelity, Robinhood and Interactive Brokers, through SnapTrade</Check>
              <Check>Crypto and cash at Coinbase, valued in your currency</Check>
              <Check>Read-only and revocable: you sign in at the provider, and Aurex never sees your password</Check>
            </ul>
            <p className="faint small">Available providers depend on your country and on what the Aurex operator has enabled.</p>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Link size={16} /> Connections</div>
            <div className="fv-field"><span className="faint xs">Net worth across linked accounts</span><strong className="num">$32,411.32</strong></div>
            {[["Demo Bank Zambia", "ZK 43,510.75"], ["Nairobi Demo Bank", "KSh 162,420.00"], ["Demo Brokerage", "$24,510.33"], ["Coinbase · BTC", "0.05 BTC ≈ $5,000"]].map(([n, v]) => (
              <div key={n} className="row between small" style={{ padding: "6px 2px", borderBottom: "1px solid var(--border)" }}><span>{n}</span><strong className="num">{v}</strong></div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="money">
        <div className="split">
          <div>
            <SectionHead eyebrow="Money in & out" title="Top up and cash out the way you already pay" lead="Add money from your phone, PayPal or Skrill, and withdraw to mobile money, PayPal, Venmo, Skrill, a bank account almost anywhere, or cash at a MoneyGram location." />
            <ul className="check-list">
              <Check>M-Pesa: approve a top-up with your PIN, and withdraw straight to M-Pesa</Check>
              <Check>MTN MoMo in Ghana, Uganda, Zambia, Cameroon, Côte d'Ivoire, Rwanda and more</Check>
              <Check>PayPal for top-ups, and payouts to PayPal or Venmo</Check>
              <Check>Skrill for top-ups and payouts to your Skrill wallet</Check>
              <Check>Cash pickup at MoneyGram locations in 200+ countries, with a reference number and ID</Check>
              <Check>Bank payouts to 160+ countries through Wise; the form asks for exactly what each country needs</Check>
              <Check>Cards almost anywhere through Stripe; cards, bank transfers and Airtel Money across Africa through Flutterwave</Check>
              <Check>Your wallet is credited only after the provider confirms the full amount</Check>
            </ul>
          </div>
          <div className="feature-visual">
            <div className="fv-title"><Icon.Phone size={16} /> Approve on your phone</div>
            <div className="stk-card" role="img" aria-label="Example M-Pesa prompt: pay KSh 2,500 to Aurex, enter your PIN">
              <div className="small" style={{ fontWeight: 650 }}>M-PESA</div>
              <p className="small" style={{ marginTop: 6 }}>Do you want to pay <strong>KSh 2,500</strong> to <strong>AUREX</strong>?</p>
              <div className="pin" aria-hidden="true"><span /><span /><span /><span /></div>
              <div className="row between small"><span className="faint">Cancel</span><strong className="gold-text">Send</strong></div>
            </div>
            <div className="rail-chips">
              {["M-Pesa", "MTN MoMo", "PayPal", "Venmo", "Skrill", "MoneyGram", "Wise", "Flutterwave", "Stripe"].map((r) => (
                <span key={r} className="pill">{r}</span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section>
        <SectionHead center eyebrow="And everywhere" title="Thoughtful details throughout" />
        <div className="mini-grid">
          {[
            ["Light & dark", "White and gold by day, black and gold by night."],
            ["Works on any screen", "Designed for phones first, roomy on desktops."],
            ["Activity log", "See every sign-in and sensitive change on your account."],
            ["Two-factor sign-in", "Protect your account with any authenticator app."],
            ["Verified accounts", "Verify your identity in about 5 minutes to raise your limits. Your documents are encrypted."],
            ["Monthly statements", "Print one, save it as a PDF or download a CSV for your accountant."],
            ["Your data, your call", "Download everything we hold about you, or close your account yourself."],
            ["Account numbers", "Every account gets a number with a check digit, so a typo never pays a stranger."],
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
