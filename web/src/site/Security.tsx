import { Icon } from "../components/icons";
import { useAuth } from "../state";
import { Check, CtaBand, Section, SectionHead, usePageTitle } from "./common";

export function SecurityPage() {
  usePageTitle("Security");
  const { meta } = useAuth();
  const cap = Math.round((meta?.trading.aiMaxPositionPct ?? 0.1) * 100);

  const blocks = [
    {
      icon: <Icon.Shield />,
      title: "Your account",
      items: [
        "Passwords are hashed with scrypt and never stored in readable form",
        "Optional two-factor sign-in with any authenticator app",
        "Sessions use secure, HTTP-only cookies and can be revoked; changing your password signs out other devices",
        "Sign-in attempts and sensitive actions are rate-limited",
      ],
    },
    {
      icon: <Icon.Wallet />,
      title: "Your money",
      items: [
        "A double-entry ledger: every transfer's entries must sum to zero, so money is never created or lost",
        "Ledger entries are permanent; corrections are new entries, never edits",
        "Retried requests can't pay twice, and a request can only be paid once",
        "Withdrawals are held aside before payout and returned automatically if a payout fails",
        "Per-payment and daily limits apply across every currency",
      ],
    },
    {
      icon: <Icon.Settings />,
      title: "Your data",
      items: [
        "AI provider and brokerage keys are encrypted with AES-256-GCM and never shown again",
        "Strict browser security headers, including a Content-Security-Policy",
        "Requests from other websites can't act on your account (CSRF protection)",
        "AI replies are rendered safely, so model output can't inject code into the page",
      ],
    },
    {
      icon: <Icon.Chart />,
      title: "AI & trading safeguards",
      items: [
        "The AI analyst only suggests; every AI order needs your explicit confirmation",
        `AI-suggested buys are capped at ${cap}% of your portfolio`,
        "Each AI signal can be executed once, and long-only rules prevent accidental short selling",
        "Live, real-money brokerage is off unless the platform operator explicitly enables it",
      ],
    },
  ];

  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Security</span>
          <h1>Protection built into <span className="gold-text">every layer.</span></h1>
          <p className="lead">From how your password is stored to how each cent is recorded, Aurex is designed so that mistakes are hard to make and easy to catch.</p>
        </div>
      </section>

      <Section>
        <div className="security-grid">
          {blocks.map((b) => (
            <div key={b.title} className="security-card">
              <span className="pillar-ico">{b.icon}</span>
              <h3>{b.title}</h3>
              <ul className="check-list">
                {b.items.map((i) => (
                  <Check key={i}>{i}</Check>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="warm">
        <div className="split">
          <SectionHead eyebrow="Transparency" title="See everything that happens on your account" lead="Your settings include an activity log of sign-ins, password and key changes, payments and orders, with the time and network address of each." />
          <div className="ledger-card" aria-hidden="true">
            {[
              ["auth login", "just now"],
              ["security 2fa enabled", "2m ago"],
              ["payments send", "1h ago"],
              ["trading ai order", "3h ago"],
            ].map(([a, t]) => (
              <div key={a} className="row between ledger-row"><span>{a}</span><span className="faint">{t}</span></div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="disclosures">
        <SectionHead eyebrow="Disclosures" title="Important information" />
        <div className="disclosures">
          <p><strong>Sandbox mode.</strong> Aurex is currently operating in sandbox mode. Deposits and withdrawals use test money and no real funds are moved until licensed payment partners are connected. Do not treat sandbox balances as real money.</p>
          <p><strong>Not financial advice.</strong> AI-generated trading signals, analysis and chat responses are provided for educational purposes as decision aids. They are not personalised investment, legal or tax advice. Past performance does not guarantee future results.</p>
          <p><strong>Investment risk.</strong> Investing in securities involves risk, including the possible loss of principal. Paper-trading results do not reflect real trading costs, liquidity or emotions. Live brokerage, where enabled, is provided by your own account with a third-party broker.</p>
          <p><strong>Third-party AI providers.</strong> When you connect your own API key, your prompts are sent to that provider and processed under its terms and privacy policy.</p>
        </div>
      </Section>

      <CtaBand title="Open an account you can trust" />
    </>
  );
}
