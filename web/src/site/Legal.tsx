import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { COUNTRIES } from "../countries";
import { useAuth } from "../state";
import complaintsMd from "../../../docs/go-live/legal/complaints-policy.md?raw";
import privacyMd from "../../../docs/go-live/legal/privacy-policy.md?raw";
import riskMd from "../../../docs/go-live/legal/risk-warnings.md?raw";
import termsMd from "../../../docs/go-live/legal/terms-of-service.md?raw";
import { Section, usePageTitle } from "./common";

/**
 * The legal pages. Their text is the documents in docs/go-live/legal (one source for the lawyer and
 * the app); company and contact details come from the server's LEGAL_* and SUPPORT_* settings.
 * Until LEGAL_FINAL=true each page says it's a draft.
 */
export interface LegalInfo {
  final: boolean;
  effectiveDate: string | null;
  company: { name: string | null; registrationNumber: string | null; address: string | null; country: string | null };
  contact: { supportEmail: string | null; supportPhone: string | null; complaintsEmail: string | null; dpoName: string | null; dpoEmail: string | null };
}

export const LEGAL_PAGES = {
  terms: { title: "Terms of Service", text: termsMd },
  privacy: { title: "Privacy Policy", text: privacyMd },
  complaints: { title: "Complaints", text: complaintsMd },
  risk: { title: "Risk warnings", text: riskMd },
} as const;

const FILE_TO_PATH: Record<string, string> = {
  "terms-of-service.md": "/terms",
  "privacy-policy.md": "/privacy",
  "fee-schedule.md": "/fees",
  "complaints-policy.md": "/complaints",
  "risk-warnings.md": "/risk",
};
const resolveLink = (href: string) => FILE_TO_PATH[href.replace(/^\.\//, "").split("#")[0]] ?? null;

export function useLegalInfo() {
  const [info, setInfo] = useState<LegalInfo | null>(null);
  useEffect(() => {
    api.get<LegalInfo>("/api/public/legal").then(setInfo, () => setInfo(null));
  }, []);
  return info;
}

/** The document as customers read it: no reviewer notes, your details in place of the placeholders. */
export function prepareLegal(md: string, info: LegalInfo | null) {
  const c = info?.company;
  const k = info?.contact;
  const fill: Record<string, string | null | undefined> = {
    "COMPANY NAME": c?.name,
    "REGISTRATION NUMBER": c?.registrationNumber,
    "REGISTERED ADDRESS": c?.address,
    ADDRESS: c?.address,
    COUNTRY: c?.country,
    "SUPPORT EMAIL": k?.supportEmail,
    "SUPPORT PHONE": k?.supportPhone,
    PHONE: k?.supportPhone,
    "COMPLAINTS EMAIL": k?.complaintsEmail,
    "DPO NAME": k?.dpoName,
    "DPO EMAIL": k?.dpoEmail,
    "EFFECTIVE DATE": info?.effectiveDate,
  };
  const out: string[] = [];
  let seenTitle = false;
  let inNote = false;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (!seenTitle && line.startsWith("# ")) {
      seenTitle = true; // the page shows its own title
      continue;
    }
    // The reviewer's note is the quoted block that starts "DRAFT"; the version line is for the lawyer.
    if (line.startsWith(">") && (inNote || /DRAFT/.test(line))) {
      inNote = true;
      continue;
    }
    inNote = false;
    if (/^\*\*Version:\*\*/.test(line)) continue;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\*\*\(licence\)\*\*\s*/g, "")
    .replace(/\s\(licence\)/g, "")
    .replace(/\[([A-Z][A-Z ]+)\]/g, (whole, key: string) => fill[key] ?? whole)
    .trim();
}

function LegalShell({ title, final, children }: { title: string; final: boolean; children: ReactNode }) {
  return (
    <Section>
      <article className="legal-doc">
        <h1>{title}</h1>
        {!final && (
          <div className="banner" role="note" style={{ margin: "12px 0 20px" }}>
            <span className="small">
              <strong>Draft.</strong> This text is being finalised with our lawyers and isn't in force yet. Items in [brackets] are still to be filled in.
            </span>
          </div>
        )}
        {children}
        <p className="small muted legal-links">
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/fees">Fees and limits</Link> · <Link to="/complaints">Complaints</Link> · <Link to="/risk">Risk warnings</Link>
        </p>
      </article>
    </Section>
  );
}

export function LegalPage({ doc }: { doc: keyof typeof LEGAL_PAGES }) {
  const page = LEGAL_PAGES[doc];
  usePageTitle(page.title);
  const info = useLegalInfo();
  return (
    <LegalShell title={page.title} final={info?.final ?? false}>
      <Markdown text={prepareLegal(page.text, info)} resolveLink={resolveLink} className="legal-md" />
    </LegalShell>
  );
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const usd = (n: number) => `US$${n.toLocaleString("en-US")}`;
const LEVEL_NAMES = ["Level 0 (email confirmed)", "Level 1 (identity verified)", "Level 2 (address and source of funds)"];
const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));

/** The fee schedule, built from the server's live settings so it can't disagree with what's charged. */
export function FeesPage() {
  usePageTitle("Fees and limits");
  const { meta } = useAuth();
  const info = useLegalInfo();
  const fees = meta?.fees;
  const limits = meta?.limits;
  const rows: [string, string][] = fees
    ? [
        ["Opening and keeping an account", "Free"],
        ["Sending money to another Aurex customer", fees.p2pBps ? `${pct(fees.p2pBps)} of the amount, paid by the sender` : "Free"],
        ["Receiving money (personal account)", "Free"],
        ["Receiving money (approved business account)", fees.merchantBps ? `${pct(fees.merchantBps)} of each payment received, kept from the amount; the payer pays nothing extra` : "Free"],
        ["Converting between currencies", fees.fxSpreadBps ? `${pct(fees.fxSpreadBps)} spread on the mid-market rate; the exact rate and amount are shown before you confirm` : "At the mid-market rate"],
        ["Adding money", "Free from Aurex; your provider (mobile money, card issuer, bank) may charge its own fee"],
        ["Withdrawing", fees.withdrawalBps ? `${pct(fees.withdrawalBps)} of the amount, shown before you confirm` : "Free from Aurex; the receiving provider may charge its own fee"],
        ...(meta?.pro ? ([["Aurex Pro (optional)", `${meta.pro.currency} ${meta.pro.price.toFixed(2)} per 30 days, paid from your wallet`]] as [string, string][]) : []),
        ["AI assistant", `${meta?.ai?.freeDailyRequests ?? 0} requests a day free${meta?.pro ? `; ${meta.pro.aiDailyRequests} a day with Aurex Pro` : ""}; unlimited with your own AI provider key`],
        ["Demo trading, statements, your data, the academy", "Free"],
        ["Real trading through a broker", "No Aurex fee; the broker's own fees apply"],
      ]
    : [];
  const levels = limits?.byLevel ?? (limits ? [{ level: -1, txUsd: limits.maxTxUsd, dailyUsd: limits.dailyUsd }] : []);
  return (
    <LegalShell title="Fees and limits" final={info?.final ?? false}>
      <div className="md legal-md">
        {info?.effectiveDate && <p className="muted">Effective {info.effectiveDate}.</p>}
        {!fees ? (
          <p className="muted">Loading the current fees…</p>
        ) : (
          <>
            <div className="md-table">
              <table>
                <thead><tr><th>Service</th><th>Fee</th></tr></thead>
                <tbody>{rows.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}</tbody>
              </table>
            </div>
            <h2>Limits</h2>
            <p>In US dollars, or the equivalent in your currency.</p>
            <div className="md-table">
              <table>
                <thead><tr><th>Account</th><th>Per payment</th><th>Per 24 hours</th></tr></thead>
                <tbody>
                  {levels.map((l) => (
                    <tr key={l.level}>
                      <td>{LEVEL_NAMES[l.level] ?? "All accounts"}</td>
                      <td>{usd(l.txUsd)}</td>
                      <td>{usd(l.dailyUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {limits?.byCountry && limits.byCountry.length > 0 && (
              <>
                <p>Where a country's regulator sets its own limits, they apply to customers whose verified address is in that country:</p>
                <div className="md-table">
                  <table>
                    <thead><tr><th>Country</th><th>Account</th><th>Per payment</th><th>Per 24 hours</th></tr></thead>
                    <tbody>
                      {limits.byCountry.map((c) => (
                        <tr key={c.country + c.level}>
                          <td>{COUNTRY_NAMES[c.country] ?? c.country}</td>
                          <td>{LEVEL_NAMES[c.level]}</td>
                          <td>{usd(c.txUsd)}</td>
                          <td>{usd(c.dailyUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {limits?.payoutReviewUsd ? <p>Withdrawals of {usd(limits.payoutReviewUsd)} or more may wait for a review by our team before they're sent.</p> : null}
            <h2>Changes</h2>
            <p>We'll give you at least 30 days' notice before raising a fee. A change applies only to payments made after it takes effect.</p>
          </>
        )}
      </div>
    </LegalShell>
  );
}
