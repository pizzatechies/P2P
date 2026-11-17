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
        "Passwords are hashed with scrypt; common, reused-from-breach and too-short passwords are refused",
        "Email addresses are verified with a one-time code, so nobody can receive money sent to your email by registering it first",
        "Repeated wrong passwords or codes lock the account, for longer each time",
        "Two-factor sign-in with any authenticator app; every code works only once, with backup recovery codes",
        "See every signed-in device and sign any of them out; idle sessions end automatically",
        "Alerts for new-device sign-ins, lockouts and every security change",
        "An alert the first time money is sent to a new destination, so nobody can empty your account quietly",
      ],
    },
    {
      icon: <Icon.Wallet />,
      title: "Your money",
      items: [
        "A double-entry ledger: every transfer's entries must sum to zero, so money is never created or lost",
        "Ledger entries are permanent; corrections are new entries, never edits",
        "Retried requests can't pay twice, and a request can only be paid once",
        "Withdrawals and large sends need your password (and 2FA code) again, even when you're signed in",
        "After a password change or 2FA removal, money can't leave for 24 hours, so a hijacker can't empty your account",
        "Withdrawals are held aside before payout and returned automatically if a payout fails",
        "Per-payment and daily limits apply across every currency, and rise only as you verify your identity",
        "Larger withdrawals are checked by a second person before they're sent; the money is set aside meanwhile",
        "Customers' money is kept apart from the business's own and reconciled against the bank several times a day",
        "Every payment and admin action is sealed in a tamper-evident chain, so records can't be changed after the fact",
      ],
    },
    {
      icon: <Icon.Settings />,
      title: "Your data",
      items: [
        "AI provider and brokerage keys are encrypted with AES-256-GCM and never shown again; encryption keys can be rotated",
        "Strict browser security headers: Content-Security-Policy, HTTPS-only (HSTS), no framing, no caching of account data",
        "Requests from other websites can't act on your account (two layers of CSRF protection)",
        "Admins must use two-factor sign-in, re-confirm every admin action, and can't approve their own requests",
        "Automated code scanning and dependency updates; report issues privately via our security policy",
        "AI replies are rendered safely, so model output can't inject code into the page",
      ],
    },
    {
      icon: <Icon.Link />,
      title: "Connected accounts & payment partners",
      items: [
        "Linked banks, brokerages and Coinbase are read-only: you approve access on the provider's own page",
        "Access tokens are encrypted, and disconnecting revokes them at the provider",
        "Money is credited only after Aurex confirms the amount with the payment provider, never on a redirect or notification alone",
        "M-Pesa and MTN MoMo payments are approved with your own PIN on your own phone",
        "Withdrawals that a provider rejects are refunded to your wallet automatically",
      ],
    },
    {
      icon: <Icon.Learn />,
      title: "Real trading accounts",
      items: [
        "Everyone starts in a demo account with virtual money; real money needs an approved upgrade",
        "Upgrading requires a verified email, two-factor sign-in, the academy quizzes and practice trades",
        "Your profile and questionnaire answers are encrypted, and applications are reviewed before live trading unlocks",
        "Live brokerage keys are refused until you're approved, and trading stops at once if approval is withdrawn",
      ],
    },
    {
      icon: <Icon.Chart />,
      title: "AI & trading safeguards",
      items: [
        "AI orders need your confirmation unless you switch on Autopilot, which you must explicitly accept first",
        "Autopilot only trades within your limits and pauses itself at your daily loss limit or after repeated errors",
        `AI-suggested buys are capped at ${cap}% of your portfolio`,
        "Each AI signal can be executed once, and long-only rules prevent accidental short selling",
        "Live, real-money brokerage is off unless the platform operator explicitly enables it, and live autopilot needs a second, separate opt-in",
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
          <p><strong>Investment risk.</strong> Investing in securities involves risk, including the possible loss of principal. Demo-account results do not reflect real trading costs, liquidity or emotions. Live brokerage, where enabled, is provided by your own account with a third-party broker.</p>
          <p><strong>Third-party AI providers.</strong> When you connect your own API key, your prompts are sent to that provider and processed under its terms and privacy policy.</p>
        </div>
      </Section>

      <CtaBand title="Open an account you can trust" />
    </>
  );
}
