import { Link } from "react-router-dom";
import { useAuth } from "../state";
import { Check, CtaBand, Faq, PrimaryCta, Section, SectionHead, usePageTitle } from "./common";

const pctOrFree = (bps: number) => (bps === 0 ? "Free" : `${(bps / 100).toFixed(2)}%`);

export function PricingPage() {
  usePageTitle("Pricing");
  const { meta } = useAuth();
  const fees = meta?.fees ?? { p2pBps: 0, fxSpreadBps: 50, withdrawalBps: 0 };
  const limits = meta?.limits ?? { maxTxUsd: 10000, dailyUsd: 25000 };
  const cash = (meta?.trading.paperStartingCash ?? 100000).toLocaleString("en-US");

  const rows: [string, string, string][] = [
    ["Opening an account", "Free", "No monthly fee"],
    ["Sending money to Aurex users", pctOrFree(fees.p2pBps), "Any amount up to your limits"],
    ["Requesting money", "Free", "Your friend pays the amount you request"],
    ["Currency conversion", `${(fees.fxSpreadBps / 100).toFixed(2)}% spread`, "Shown before you confirm, no hidden markup"],
    ["Adding money", "Free from Aurex", "Your card or bank may charge its own fees"],
    ["Withdrawing", pctOrFree(fees.withdrawalBps), "To bank, card or mobile money where available"],
    ["AI Hub", "Free", "Built-in assistant included; providers bill your own API keys directly"],
    ["Paper trading", "Free", `$${cash} of practice cash`],
    ["Live trading via Alpaca", "No Aurex fee", "Your Alpaca account's own pricing applies"],
  ];

  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Pricing</span>
          <h1>Simple, <span className="gold-text">honest pricing.</span></h1>
          <p className="lead">No subscriptions and no surprises. The figures on this page come straight from the live platform settings.</p>
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
              <Check>AI analyst and paper trading</Check>
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
            { q: "Do I pay for AI?", a: "The built-in assistant is free. When you connect your own key for Claude, GPT, Gemini or another provider, that provider bills you directly at its usual rates. Aurex adds nothing." },
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
