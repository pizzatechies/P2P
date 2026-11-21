import { Link } from "react-router-dom";
import { useAuth } from "../state";
import { AppLink, Check, CtaBand, Faq, PrimaryCta, Section, SectionHead, usePageTitle } from "./common";

const pctOrFree = (bps: number) => (bps === 0 ? "Free" : `${(bps / 100).toFixed(2)}%`);

export function PricingPage() {
  usePageTitle("Pricing");
  const { meta } = useAuth();
  const fees: { p2pBps: number; fxSpreadBps: number; withdrawalBps: number; merchantBps?: number } = meta?.fees ?? { p2pBps: 0, fxSpreadBps: 50, withdrawalBps: 0 };
  const limits = meta?.limits ?? { maxTxUsd: 10000, dailyUsd: 25000 };
  const freeAi = meta?.ai?.freeDailyRequests ?? 25;
  const pro = meta?.pro ?? null;

  const rows: [string, string, string][] = [
    ["Opening an account", "Free", "No monthly fee"],
    ["Sending money to Aurex users", pctOrFree(fees.p2pBps), "Any amount up to your limits"],
    ["Requesting money", "Free", "Your friend pays the amount you request"],
    [
      "Getting paid as a business",
      fees.merchantBps ? `${(fees.merchantBps / 100).toFixed(2)}% of each payment` : "Free",
      "Approved business accounts show your business name on your pay link; the fee comes out of what you receive, so your customers pay exactly your price",
    ],
    ["Currency conversion", `${(fees.fxSpreadBps / 100).toFixed(2)}% spread`, "Shown before you confirm, no hidden markup"],
    ["Adding money", "Free from Aurex", "M-Pesa, MTN MoMo, PayPal, Skrill, card or bank; your provider may charge its own fees"],
    ["Withdrawing", pctOrFree(fees.withdrawalBps), "To M-Pesa, MTN MoMo, PayPal, Venmo, Skrill, a bank in 160+ countries or MoneyGram cash pickup, where enabled"],
    ["Connecting accounts", "Free", "Banks, brokerages and Coinbase, read-only"],
    ["AI Hub", "Free", freeAi > 0 ? `${freeAi} free AI requests a day on Aurex's models; unlimited with your own API keys` : "Built-in assistant included; providers bill your own API keys directly"],
    pro
      ? ["AI Autopilot", "With Aurex Pro", "Trades for you within your limits; AI model usage counts toward your allowance"]
      : ["AI Autopilot", "Free", "Trades for you within your limits; AI model usage counts toward your allowance"],
    ["Demo account & trading academy", "Free", "Virtual money from $1,000 to $1,000,000; stocks, crypto and futures; lessons with quizzes and practice missions"],
    ["Futures (demo account)", "Free", "Long or short, with real contract sizes, margin and leverage"],
    ["Upgrading to a real account", "Free", "Questionnaire and review; trade through your own licensed broker"],
    ["Real stock & crypto trading via Alpaca", "No Aurex fee", "Your Alpaca account's own pricing applies"],
    ...(pro
      ? ([["Aurex Pro (optional)", `${pro.currency} ${pro.price.toFixed(2)} a month`, `${pro.aiDailyRequests} AI requests a day, the AI Autopilot and up to 25 watched Web3 wallets (${pro.freeWeb3Wallets} on the free plan). Paid from your wallet; cancel any time`]] as [string, string, string][])
      : []),
  ];

  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Pricing</span>
          <h1>Simple, <span className="gold-text">honest pricing.</span></h1>
          <p className="lead">No required subscriptions and no surprises. The figures on this page come straight from the live platform settings.</p>
        </div>
      </section>

      <Section>
        <div className="pricing-layout">
          <div className="plan-card">
            <span className="pill brand">Personal</span>
            <div className="plan-price">Free</div>
            <p className="muted">Everything in Aurex, for everyone.</p>
            <ul className="check-list">
              <Check>Wallets in {meta?.currencies.length ?? 19} currencies</Check>
              <Check>Send & request money {fees.p2pBps === 0 ? "with no fee" : ""}</Check>
              <Check>AI Hub with every major provider</Check>
              <Check>Stocks, crypto and futures in a demo account, with an AI analyst</Check>
              <Check>Two-factor sign-in and activity log</Check>
            </ul>
            <PrimaryCta>Create free account</PrimaryCta>
          </div>
          <div className="fee-table card flush">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>What you do</th><th>Cost</th><th className="hide-sm">Details</th></tr>
                </thead>
                <tbody>
                  {rows.map(([what, cost, note]) => (
                    <tr key={what}>
                      <td style={{ fontWeight: 560 }}>{what}<div className="faint xs show-sm">{note}</div></td>
                      <td><strong className={cost === "Free" ? "good" : ""}>{cost}</strong></td>
                      <td className="muted small hide-sm">{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Every fee, and the limits for each verification level: <AppLink to="/fees">fees and limits</AppLink>.
          </p>
        </div>
      </Section>

      <Section tone="warm">
        <SectionHead center eyebrow="Limits" title="Sensible limits that keep you safe" lead="Limits protect you if your account is ever misused. They're applied in US-dollar equivalent across all currencies." />
        <div className="stat-band two">
          <div><strong>${limits.maxTxUsd.toLocaleString("en-US")}</strong><span>per single payment or withdrawal</span></div>
          <div><strong>${limits.dailyUsd.toLocaleString("en-US")}</strong><span>sent or withdrawn per rolling 24 hours</span></div>
        </div>
      </Section>

      <Section>
        <SectionHead center title="Pricing questions" />
        <Faq
          items={[
            { q: "Why is sending money free?", a: "Moving money between Aurex wallets happens on our own ledger, so there's no card network or bank in the middle to charge for it." },
            { q: "How does currency conversion pricing work?", a: <>You get the mid-market rate minus a {(fees.fxSpreadBps / 100).toFixed(2)}% spread. The exact amount you'll receive is shown before you confirm.</> },
            { q: "Do I pay for AI?", a: <>No. Every account gets {freeAi > 0 ? `${freeAi} free AI requests a day` : "free AI access"} on Aurex's models, plus the built-in assistant. Connect your own key for Claude, GPT, Gemini or another provider for unlimited use; that provider bills you directly and Aurex adds nothing.</> },
            { q: "Can limits be raised?", a: "Limits are set by the platform operator and will grow as identity verification levels are introduced." },
          ]}
        />
        <p style={{ textAlign: "center", marginTop: 20 }} className="muted small">
          Looking for how your money is protected? <Link to="/security">Read about security</Link>.
        </p>
      </Section>

      <CtaBand title="Free to open. Free to send." />
    </>
  );
}
