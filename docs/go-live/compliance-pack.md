# Aurex compliance pack

What a regulator, bank partner or auditor will ask to see, mapped to what Aurex already does, where to find the evidence, and what's still open. Use it for licence applications, partner due diligence questionnaires and the first risk assessment.

## 1. The business in one paragraph

Aurex is a mobile-first wallet that lets verified customers:

- hold several currencies;
- pay each other instantly by @handle, phone, email or account number;
- pay in and cash out through local rails (mobile money, cards, bank transfer, remittance partners);
- accept payments as small businesses.

It also offers demo and partner-brokered trading with AI decision aids, and read-only views of connected bank, broker and crypto accounts.

Revenue comes from:

- a currency-conversion spread;
- a merchant fee on payments to business accounts;
- optional withdrawal and transfer fees;
- an optional Pro subscription.

## 2. Control map

| Area | Requirement (typical) | What Aurex does | Evidence | Open |
|---|---|---|---|---|
| **Governance** | Board, MLRO, compliance function, fit-and-proper directors | — | — | Appoint MLRO and compliance officer; board minutes adopting policies |
| **Customer due diligence** | Tiered KYC; ID verification; limits by tier | 3 levels with limits; ID, selfie and address documents; government record check via Smile ID; no self-approval | Account → Identity verification; Admin → KYC queue; `server/src/services/kyc.ts`, `smileid.ts` | Liveness and face match (Smile ID SmartSelfie / Biometric KYC); country-specific tier limits |
| **Business customers (KYB)** | Verify businesses and beneficial owners | Business applications reviewed by an admin; business names sanctions-screened; owner must be verified | Account → Business account; Admin → Business accounts to review; `services/business.ts` | Company documents, directors and UBO verification |
| **Sanctions** | Screen customers and payees against UN and national lists; freeze and report | UN and OFAC lists refreshed daily; screening at sign-up, KYC, business and payout; matches block money both ways until cleared | Admin → Sanctions; `services/sanctions.ts`; tests in `server/test/sanctions.test.ts` | National lists, plus EU and UK if banks require; written freeze-and-report procedure |
| **PEPs** | Identify PEPs; EDD | — | — | Add a PEP data provider |
| **Transaction monitoring** | Risk-based rules; alert handling; audit trail | 7 rules; alerts hidden from customers; payouts held while alerts are open; reviewer can't review own account | Admin → Compliance; `services/monitoring.ts` | Threshold tuning after launch; case-management notes for STR decisions |
| **STR reporting** | File with FIU within deadline; no tipping off | Escalation in Admin → Compliance; no customer visibility | `services/monitoring.ts` | goAML registration with each FIU; MLRO procedure |
| **Admin controls** | Four-eyes on high-impact admin actions | Custom limits and hand-set identity levels need a second admin's approval (`TWO_PERSON_APPROVAL`) | Admin → Waiting for approval; `services/approvals.ts` | — |
| **Payout controls** | Four-eyes on high-risk outflows | Withdrawals ≥ US$1,000 or with open alerts wait for a second person; rejected payouts are refunded | Admin → Payouts; `services/payments.ts` | — |
| **Safeguarding** | Segregate customer funds; daily reconciliation | Safeguarding accounts register; daily reconciliation against the ledger; stale or short positions flagged; fee sweeps journaled | Admin → Ledger → Safeguarding; `services/safeguarding.ts` | Open trust or safeguarding accounts at partner banks; name the reconciliation owner |
| **Books and records** | Accurate books; immutable records; retention | Double-entry ledger with balance checks in SQL; sealed hash chain over journals and audit log; database triggers block edits; end-of-day snapshots; trial balance and journal exports | Admin → Ledger; `services/ledger.ts`, `integrity.ts`, `ledgerData.ts` | Retention and deletion procedure per country; external accountant |
| **Customer funds limits** | Per-transaction and daily limits | Enforced per level and per customer; simultaneous payments can't get around them | `services/payments.ts`; `server/test/review.test.ts` | — |
| **Consumer protection** | Clear fees, terms, complaints handling, disclosures | Fees shown before confirming; drafts of Terms, Fee Schedule, Complaints and Risk Warnings | `docs/go-live/legal/` | Lawyer review; publish in app; complaints log and reporting |
| **Data protection** | Lawful basis, consent, rights, security, registration, cross-border transfers | Encrypted identity data; data download; account closure; consent recorded for government checks; staff document views audited | Account → Your data; `services/account.ts` | Register with each DPA; DPIA for KYC and AI; transfer safeguards (AWS EU, US providers) |
| **Information security** | Access control, MFA, logging, vulnerability management, pen testing, BCP | See section 3 | `SECURITY.md`; `docs/security-review-2026-11.md` | Independent penetration test; ISO 27001 or SOC 2 roadmap if partners ask |
| **Outsourcing** | Due diligence and contracts for critical providers | Provider list in section 4 | — | Contracts, SLAs and exit plans for hosting, KYC and payment partners |
| **Business continuity** | Backups, recovery, incident response | Continuous database backup to S3 (Litestream, 30-day history); auto-recovery alarm; runbook | `deploy/`; `docs/go-live/runbook.md` | Restore drill; RTO and RPO sign-off; second region if required |
| **Trading** | Licensed broker; suitability; disclosures | Demo by default; real trading only via a licensed partner (Alpaca) with the customer's own account; checklist and quiz before real accounts; risk warnings | `services/upgrade.ts`; Academy | Confirm local securities licensing for offering foreign securities and AI signals (section 5 of the market research) |

## 3. Security summary (for questionnaires)

- **Authentication:**
  - scrypt password hashing with breached-password checks;
  - TOTP two-factor sign-in with replay protection and recovery codes;
  - lockouts that lengthen with repeated failures;
  - new-device alerts;
  - secure self-service password reset (single-use link, plus 2FA when it's on).
- **Sessions:** `__Host-` HttpOnly Secure cookie, idle and absolute timeouts, remote sign-out, step-up re-authentication for sensitive actions.
- **Money:**
  - withdrawals and large sends need a recent re-check;
  - 24-hour hold after security changes;
  - provider-confirmed deposits;
  - automatic refunds of failed payouts.
- **Admin:**
  - 2FA required;
  - setup code needed to claim admin access;
  - optional IP allowlist;
  - short idle timeout;
  - no self-review anywhere;
  - every action audited.
- **Platform:**
  - strict CSP and HSTS preload;
  - Origin and Sec-Fetch checks plus a CSRF header;
  - rate limits;
  - AES-256-GCM encryption for secrets and identity data, with key rotation;
  - webhook signatures;
  - container hardening;
  - CodeQL, Dependabot and `npm audit` in CI (0 known vulnerabilities in November 2026).
- **Review:** internal code review in November 2026, with 9 findings fixed (see `docs/security-review-2026-11.md`). An independent penetration test is still to come.

## 4. Critical providers

| Provider | Service | Data shared |
|---|---|---|
| Amazon Web Services | Hosting (EC2, S3 backups, Parameter Store) | All (encrypted at rest) |
| Smile ID | Government ID checks | Identity details |
| Resend | Email | Email address, message |
| Stripe, Flutterwave, Safaricom M-Pesa, MTN MoMo, PayPal, Wise, Skrill, MoneyGram | Pay-in and pay-out (as enabled) | Payment details |
| Plaid, Mono, Salt Edge, SnapTrade, Coinbase | Account connections (at the customer's request) | Connection tokens |
| Alpaca | Brokerage and market data | Trading details |
| Anthropic, OpenAI and others | AI features (as enabled) | Chat content, market data |

## 5. Documents in this pack

- [Terms of Service](legal/terms-of-service.md)
- [Privacy Policy](legal/privacy-policy.md)
- [Fee Schedule](legal/fee-schedule.md)
- [AML/CFT and Sanctions Policy](legal/aml-kyc-policy.md)
- [Complaints Policy](legal/complaints-policy.md)
- [Risk Warnings](legal/risk-warnings.md)
- [Market research: regulators, licences, sandboxes, partners](market-research.md)
- [Server runbook](runbook.md)
- [Security review, November 2026](../security-review-2026-11.md)
