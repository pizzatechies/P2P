import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/icons";
import { Check, Faq, Section, SectionHead, usePageTitle } from "./common";

const REPO_URL = "https://github.com/pizzatechies/P2P";
const BRANCH = "claude/gifted-ritchie-8xzdk9";
const repoFile = (path: string) => `${REPO_URL}/blob/${BRANCH}/${path}`;

export const AZURE_DEPLOY_URL = `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(
  `https://raw.githubusercontent.com/pizzatechies/P2P/refs/heads/${BRANCH}/deploy/azure/azuredeploy.json`,
)}`;
const RENDER_DEPLOY_URL = `https://render.com/deploy?repo=${REPO_URL}`;

function Ext({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

type HostOption = {
  name: string;
  tag: string;
  icon: ReactNode;
  featured?: boolean;
  intro: string;
  points: string[];
  cost: ReactNode;
  extra?: ReactNode;
  actions: ReactNode;
};

const OPTIONS: HostOption[] = [
  {
    name: "Microsoft Azure",
    tag: "Free for 12 months",
    icon: <Icon.Rocket />,
    featured: true,
    intro: "One click from the Azure portal. Enter your email and a password, and your own Aurex is live about 20 minutes later.",
    points: [
      "B2ats v2 server, one of Azure's free sizes for new accounts",
      "Every change backed up to Blob Storage within 10 seconds, with 30 days of history",
      "Keys in Key Vault, Secure Boot, and only web ports open",
      "Free web address with automatic HTTPS, or your own domain",
    ],
    cost: <><strong>About $0–4 a month</strong> the first year, then about $16–21</>,
    actions: (
      <>
        <Ext className="btn" href={AZURE_DEPLOY_URL}>Deploy to Azure</Ext>
        <Ext className="btn secondary" href={repoFile("deploy/azure/README.md")}>Azure guide</Ext>
      </>
    ),
  },
  {
    name: "Amazon Web Services",
    tag: "One stack",
    icon: <Icon.Columns />,
    intro: "A CloudFormation template builds the server, firewall, backups and permissions together, then installs Aurex.",
    points: [
      "Graviton (Arm) server with a fixed IP address",
      "Every change backed up to S3 within 10 seconds, with 30 days of history",
      "Keys in Parameter Store; a terminal in your browser through Session Manager",
      "Moves itself to healthy hardware if AWS detects a fault",
    ],
    cost: <><strong>About $18 a month</strong></>,
    actions: (
      <>
        <Ext className="btn secondary" href={repoFile("deploy/aws/README.md")}>AWS guide</Ext>
        <Ext className="btn ghost" href={repoFile("deploy/aws/aurex.cloudformation.yml")}>Template</Ext>
      </>
    ),
  },
  {
    name: "Render",
    tag: "No server to manage",
    icon: <Icon.Sparkle />,
    intro: "Render builds Aurex from GitHub and runs it for you. There's no operating system to update.",
    points: [
      "One click from the repository's blueprint",
      "Managed HTTPS and a 1 GB persistent disk for the database",
      "Generates the encryption key and the admin setup code for you",
    ],
    cost: <><strong>From about $7 a month</strong> (Starter plan plus disk)</>,
    actions: (
      <>
        <Ext className="btn secondary" href={RENDER_DEPLOY_URL}>Deploy to Render</Ext>
        <Ext className="btn ghost" href={repoFile("README.md#render-one-click")}>Notes</Ext>
      </>
    ),
  },
  {
    name: "Any Ubuntu server",
    tag: "Any provider",
    icon: <Icon.Monitor />,
    intro: "DigitalOcean, Hetzner, Lightsail, Oracle Cloud or a machine in your office: one command sets everything up.",
    points: [
      "Installs Docker, automatic HTTPS and the app",
      "Optional continuous backups to S3-compatible storage or Azure Blob Storage",
      "Free <ip>.sslip.io address until you add a domain",
    ],
    extra: <code className="host-cmd">sudo ADMIN_EMAIL=you@example.com ./deploy/server/install.sh</code>,
    cost: <><strong>Your server's price</strong> (2 GB of memory recommended)</>,
    actions: <Ext className="btn secondary" href={repoFile("deploy/server/install.sh")}>Installer</Ext>,
  },
];

const COMPARE: [string, string, string, string, string][] = [
  ["Monthly cost", "$0–4 first year*, then ~$16–21", "~$18", "From ~$7", "Your server's price"],
  ["Setup", "Deploy button", "CloudFormation stack", "Deploy button", "One command"],
  ["HTTPS", "Automatic", "Automatic", "Automatic", "Automatic"],
  ["Backups", "Blob Storage, every 10s, 30 days", "S3, every 10s, 30 days", "Daily disk snapshots", "Optional, every 10s"],
  ["Keys kept off the server", "Key Vault", "Parameter Store", "Render settings", "Settings file (root only)"],
  ["Getting in", "Portal: Run command, Serial console", "Session Manager", "Render shell", "SSH"],
];

export function HostingPage() {
  usePageTitle("Hosting");
  return (
    <>
      <section className="page-hero">
        <div className="site-container">
          <span className="eyebrow">Hosting</span>
          <h1>Run Aurex on <span className="gold-text">your own cloud.</span></h1>
          <p className="lead">
            Launch your own copy of Aurex with HTTPS, continuous backups and protected keys set up for you. Start free on
            Microsoft Azure, or choose AWS, Render or any Ubuntu server.
          </p>
          <div className="row wrap" style={{ marginTop: 24 }}>
            <Ext className="btn lg" href={AZURE_DEPLOY_URL}>Deploy to Azure</Ext>
            <a className="btn lg secondary" href="#compare">Compare options</a>
          </div>
        </div>
      </section>

      <Section>
        <SectionHead center eyebrow="Choose a host" title="Four ways to go live" lead="Each option runs the same Aurex, with the same security, on infrastructure you control." />
        <div className="host-grid">
          {OPTIONS.map((o) => (
            <div key={o.name} className={`host-card${o.featured ? " featured" : ""}`}>
              <div className="host-top">
                <span className="pillar-ico">{o.icon}</span>
                <div className="grow">
                  <h3>{o.name}</h3>
                  <span className={`pill ${o.featured ? "good" : "brand"}`}>{o.tag}</span>
                </div>
              </div>
              <p className="muted">{o.intro}</p>
              <ul className="check-list">
                {o.points.map((p) => (
                  <Check key={p}>{p}</Check>
                ))}
              </ul>
              {o.extra}
              <div className="host-cost">{o.cost}</div>
              <div className="host-actions">{o.actions}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="azure" tone="warm">
        <SectionHead center eyebrow="Microsoft Azure" title="Live on Azure in three steps" lead="No command line needed. Everything happens in your browser." />
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <h3>Click Deploy to Azure</h3>
            <p>Sign in, create a resource group called aurex, and pick a region near your users, such as South Africa North or West Europe.</p>
          </li>
          <li>
            <span className="step-n">2</span>
            <h3>Enter your email and a password</h3>
            <p>Leave the rest as it is and click Create. Azure sets up the server, backup storage and Key Vault in about five minutes.</p>
          </li>
          <li>
            <span className="step-n">3</span>
            <h3>Sign up and take admin</h3>
            <p>About 20 minutes later your address is live. Sign up with your email, turn on two-factor sign-in, and enter the setup code from Key Vault.</p>
          </li>
        </ol>
        <div className="row wrap" style={{ justifyContent: "center", marginTop: 28 }}>
          <Ext className="btn lg" href={AZURE_DEPLOY_URL}>Deploy to Azure</Ext>
          <Ext className="btn lg secondary" href={repoFile("deploy/azure/README.md")}>Read the step-by-step guide</Ext>
        </div>
      </Section>

      <Section id="compare">
        <SectionHead center eyebrow="Compare" title="Side by side" />
        <div className="card flush">
          <div className="table-wrap">
            <table className="table compare-table">
              <thead>
                <tr><th></th><th>Azure</th><th>AWS</th><th>Render</th><th>Ubuntu server</th></tr>
              </thead>
              <tbody>
                {COMPARE.map(([label, ...cells]) => (
                  <tr key={label}>
                    <td style={{ fontWeight: 600 }}>{label}</td>
                    {cells.map((c, i) => (
                      <td key={i} className={i === 0 ? "" : "muted"}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="footnote">
          *New Azure accounts get 12 months of free services, including 750 hours a month of the B2ats v2 server and a 64 GB SSD, plus $200 of credit for the
          first 30 days. Switch to pay-as-you-go within 30 days to keep the server running; the free allowances continue. All prices are estimates, so check
          each provider's calculator.
        </p>
      </Section>

      <Section tone="warm">
        <SectionHead center eyebrow="Included everywhere" title="Production-ready from the first minute" />
        <div className="mini-grid">
          {[
            ["HTTPS from day one", "Certificates are issued and renewed automatically, with strict security headers."],
            ["Test money first", "Payments start in sandbox mode. Switch on M-Pesa, PayPal and other providers when you're ready."],
            ["A locked-down admin", "Taking admin needs a verified email, two-factor sign-in and a one-time setup code."],
            ["Easy updates", "Run the installer again to update. Your data, keys and settings are kept."],
          ].map(([t, d]) => (
            <div key={t} className="mini">
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHead center eyebrow="Questions" title="Hosting questions" />
        <Faq
          items={[
            {
              q: "Is Azure really free?",
              a: "For a new Azure account, the server and its disk are free for the first 12 months: the B2ats v2 size and a 64 GB SSD are part of Azure's free services. The fixed IP address, Key Vault and backup storage cost a few dollars at most, covered at first by the $200 starting credit. You need a card to sign up, and you must switch to pay-as-you-go within 30 days to keep the server running. The free allowances continue after you switch.",
            },
            {
              q: "Do I need my own domain?",
              a: "No. Azure gives you a free address like aurex-xxxx.southafricanorth.cloudapp.azure.com, and the other options have free addresses too, all with HTTPS. Add your own domain whenever you like.",
            },
            {
              q: "Where is the data kept?",
              a: "In a database on your own server, in the region you choose. On Azure and AWS every change is also copied within about 10 seconds to private storage in your own account, and a replacement server restores it automatically.",
            },
            {
              q: "Can I take real money straight away?",
              a: <>Aurex starts with test money. Real payments need accounts with providers such as M-Pesa or PayPal and, in most countries, a licence or a licensed partner. The guides show how to switch providers on. See <Link to="/security#disclosures">disclosures</Link>.</>,
            },
            {
              q: "How do I update to a new version?",
              a: "On Azure, AWS or your own server, run one command from the cloud portal or a terminal. It pulls the latest version and restarts the app with a pause of a few seconds. On Render, deploy the latest commit from the dashboard.",
            },
          ]}
        />
      </Section>

      <section className="cta-band">
        <div className="site-container cta-inner">
          <div>
            <h2>Launch your own Aurex</h2>
            <p>Free for a year on a new Azure account. About 20 minutes from click to live.</p>
          </div>
          <div className="row wrap">
            <Ext className="btn lg" href={AZURE_DEPLOY_URL}>Deploy to Azure</Ext>
            <Ext className="btn lg secondary" href={REPO_URL}>View the code</Ext>
          </div>
        </div>
      </section>
    </>
  );
}
