# Aurex go-live pack

Everything needed to take Aurex from a working product to a licensed service holding real customer money. Drafts are marked as such: they need a lawyer and your own details before use.

| Document | For | Status |
|---|---|---|
| [Market research](market-research.md) | Choosing the first country and licensing route | Research notes, Nov 2026, to confirm locally |
| [Compliance pack](compliance-pack.md) | Regulators, bank and payment partners, auditors | What's built, the evidence, what's open |
| [Terms of Service](legal/terms-of-service.md) | Customers | Draft for legal review |
| [Privacy Policy](legal/privacy-policy.md) | Customers, data protection authority | Draft for legal review |
| [Fee Schedule](legal/fee-schedule.md) | Customers | Draft; matches the server settings |
| [AML/CFT and Sanctions Policy](legal/aml-kyc-policy.md) | MLRO, board, regulator | Draft for MLRO and board |
| [Complaints Policy](legal/complaints-policy.md) | Customers, regulator | Draft |
| [Risk Warnings](legal/risk-warnings.md) | Customers | Draft; use the regulator's wording where prescribed |
| [Server runbook](runbook.md) | Whoever runs the servers | Ready |
| [Security review, Nov 2026](../security-review-2026-11.md) | Partners' security questionnaires | Done; penetration test still to do |

## Placeholders to fill everywhere

`[COMPANY NAME]` · `[REGISTRATION NUMBER]` · `[REGISTERED ADDRESS]` · `[COUNTRY]` · `[SUPPORT EMAIL]` · `[COMPLAINTS EMAIL]` · `[REGULATOR]` · `[LICENCE TYPE]` · `[LICENCE NUMBER]` · `[PARTNER NAME]` · `[BROKER]` · `[MLRO NAME]` · `[DPO NAME]` · `[DPO EMAIL]` · `[EFFECTIVE DATE]`

## What only you can do

1. **Choose the first country and route:** a licensed partner, a sandbox, or your own licence. The [market research](market-research.md) recommends starting with a partner in one country.
2. **Engage a local fintech lawyer:** review these drafts and handle licensing.
3. **Appoint an MLRO and a data protection officer.** Either can be outsourced at first.
4. **Register** with the data protection authority, and with the FIU's reporting system (goAML).
5. **Sign contracts with providers:**
   - a licensed partner or bank, plus safeguarding accounts;
   - Smile ID production;
   - the payment rails;
   - Resend email;
   - a PEP screening provider.
6. **Commission an independent penetration test.**
7. **Fill in the placeholders, publish the legal pages, and set the fees** on the server ([runbook section 7](runbook.md#7-going-from-sandbox-to-real-money)).
