# Anti-Money Laundering, Counter-Terrorist Financing and Sanctions Policy (AML/CFT)

> **DRAFT for review by the Money Laundering Reporting Officer and a lawyer — not adopted.** This is an internal policy. Regulators and bank partners will ask for it. It must be approved by the board, reviewed at least yearly, and matched to the AML law of each country of operation:
> - Kenya: Proceeds of Crime and Anti-Money Laundering Act (POCAMLA) and its Regulations.
> - Zambia: Financial Intelligence Centre Act 2010 (as amended).
> - Nigeria: Money Laundering (Prevention and Prohibition) Act 2022.
> - Ghana: Anti-Money Laundering Act 2020 (Act 1044).
> - Uganda: Anti-Money Laundering Act 2013.
>
> Sections marked **[SYSTEM]** describe controls the Aurex software already enforces. **[TO DO]** marks controls that still need a person, a provider or a decision.

**Owner:** [MLRO NAME], Money Laundering Reporting Officer
**Approved by the board on:** [DATE]
**Next review:** [DATE + 12 months]

## 1. Purpose and scope

[COMPANY NAME] will not let Aurex be used for money laundering, terrorist or proliferation financing, or sanctions evasion. This policy applies to all staff, directors, contractors and agents, and to every product: wallets, payments, business accounts, currency conversion, trading features and connected accounts.

## 2. Governance

- **Board:** approves this policy and the business-wide risk assessment, and receives an MLRO report at least [quarterly].
- **MLRO:** a senior, independent person who:
  - receives internal reports;
  - decides on and files suspicious transaction reports (STRs) with the Financial Intelligence Unit;
  - is the regulator's contact;
  - runs training.

  **[TO DO]** Appoint the MLRO and a deputy, and notify the FIU and regulator where required.
- **Independent audit:** the AML programme is tested independently at least every [12–24] months. **[TO DO]**
- **Staff:** vetted before hiring, and trained on joining and every year. **[TO DO]**

## 3. Risk assessment

A business-wide risk assessment covers:

- customers;
- countries;
- products (instant transfers, cash-out via mobile money, currency conversion, crypto-related connections);
- channels (fully remote onboarding);
- the business's own exposure.

It is reviewed yearly and before launching new products or countries. **[TO DO]** Write the first assessment; the [compliance pack](../compliance-pack.md) gives the inputs.

## 4. Customer due diligence (CDD)

### 4.1 Verification levels [SYSTEM]

| Level | What's collected and checked | Default limits (USD per payment / per 24 h) |
|---|---|---|
| 0 | Verified email address | 200 / 500 |
| 1 | Legal name, date of birth, nationality, phone, residential address, ID type and number; ID front (and back unless a passport); selfie | 2,000 / 5,000 |
| 2 | Level 1 plus proof of address and source of funds | 10,000 / 25,000 |

How each level is checked:

- **Documents:** checked for type by their content, and stored encrypted.
- **Government record (Smile ID):** where the country and ID type are supported, the ID number is checked against the issuing authority's records, and the name and date of birth are compared.
  - An exact match may be approved automatically, if `SMILEID_AUTO_APPROVE` is on.
  - Everything else goes to a person.
- **Selfie check (when switched on):** the selfie is compared with the photo on the ID document (Smile ID SmartSelfie Compare). Automatic approval then also needs a match.
- **Live selfie (when switched on):** customers take a live selfie with Smile ID's camera. Biometric KYC compares it with the photo on the government record and checks liveness, to catch photos of photos and masks.
- **Reviewers:** they see the record and the comparison. No one can approve their own verification.
- **Limits by country [SYSTEM]:** where a regulator sets its own limits for a level, they apply to customers by the country in their verified address. Admins set them under Admin → Limits by country, and a second admin approves each change.
- **Withdrawals and receiving money by email:** these need a verified email address.

**[TO DO]**

- Decide whether Level 0 accounts may hold balances at all in each country. Some regulators require identity verification before any value is held.
- Enter each regulator's tiered-KYC limits (for example CBN's tiered KYC for Nigeria) under Admin → Limits by country.

### 4.2 Business accounts (know your business) [SYSTEM]

- **What's collected:** business name, category, registration number, country and website.
- **Who can apply:** the owner must be identity-verified first.
- **Screening:** the business name is screened against sanctions lists, for both individuals and entities.
- **Review:** an admin reviews each application; no one can approve their own.

- **Registered companies [SYSTEM]:** they also list their directors and everyone owning 25% or more, each sanctions-screened, and upload a registration certificate and a record of directors and shareholders. Reviewers check the documents name the same people.
- **Directors' and owners' identity [SYSTEM]:**
  - everyone listed other than the applicant gets a private link to confirm their identity: ID details, a photo of their ID and a selfie;
  - where Smile ID covers their ID, the number is checked with the issuing authority;
  - the company isn't approved until everyone has done this.

**[TO DO]**

- For higher-risk categories, record the nature of the business and expected volumes.

### 4.3 Enhanced due diligence (EDD)

EDD applies to:

- politically exposed persons (PEPs), their family and close associates;
- customers from high-risk countries (FATF "black" and "grey" lists);
- high volumes relative to the profile;
- complex or unusual patterns;
- monitoring matches that aren't cleared quickly.

EDD means source of funds and wealth, senior-management approval, and closer monitoring.

**PEP screening [SYSTEM]**, once `OPENSANCTIONS_API_KEY` is set:
- **Who is checked:** the legal name from identity verification, and each company director and owner. They are checked against OpenSanctions' data on politically exposed persons and their relatives and close associates.
- **A possible match:** it opens an alert, payouts wait, and identity checks aren't approved automatically, including when the check couldn't run.
- **A confirmed PEP:** escalating the alert marks the customer for enhanced due diligence, and every payout waits for a second person.

**[TO DO]**
- Buy the OpenSanctions credits, or choose another provider.
- Define the enhanced due diligence steps for a confirmed PEP: source of wealth, and senior management approval.
- Confirm the re-screening interval (`PEP_RESCREEN_DAYS`, yearly by default) in the risk assessment.

### 4.4 Ongoing due diligence

- **Re-screening [SYSTEM]:** customers are re-screened whenever the sanctions lists change.
- **Refreshing details [SYSTEM]:**
  - **When:** verified customers update their identity details every `KYC_REFRESH_YEARS` (3 by default). For confirmed PEPs and customers with an escalated case, it's every `KYC_REFRESH_HIGH_RISK_YEARS` (1 by default).
  - **Reminders:** they're reminded 30 days before and on the due date.
  - **If they don't:** after the grace period (`KYC_REFRESH_GRACE_DAYS`, 30), sending and withdrawing pause until they've re-verified with fresh photos.
- **[TO DO]** Confirm these intervals in the risk assessment.

## 5. Sanctions screening [SYSTEM]

- **Lists:**
  - the UN Security Council Consolidated List, the US OFAC SDN list, the EU Consolidated Financial Sanctions List and the UK Sanctions List, downloaded from the official sources every day (`SANCTIONS_LISTS`);
  - our own list, uploaded under Admin → Sanctions lists, for national designations and anyone else we must screen for;
  - a broken download never replaces a good copy.
- **Who is screened:**
  - names given at sign-up;
  - legal names from identity verification (with year of birth);
  - business names;
  - every payout recipient.
- **Matching:** fuzzy matching handles word order, accents and spelling.
- **A possible match:**
  - opens a high-severity compliance alert;
  - blocks money in and out of the account, with a message that doesn't reveal why;
  - stops automatic approval of identity verification;
  - stays in place until a compliance reviewer clears it, or escalates it and reports and freezes as the law requires.

**[TO DO]**

- Upload the national lists that apply (for example, each country's domestic terrorism designations) as our own list, and keep it current.
- Document the freezing and reporting procedure for a confirmed match (to the FIU and, where required, the sanctions authority), within the legal deadline.

## 6. Transaction monitoring [SYSTEM]

Every payment, deposit and withdrawal is checked against these rules:

| Rule | Severity | What it looks for |
|---|---|---|
| Large payment | Medium | A single movement at or above `MONITOR_LARGE_USD` (US$3,000 by default) |
| Money in and straight out | High | Funds deposited and withdrawn or sent on quickly |
| Payments just under the limit | Medium | Repeated amounts just below limits or thresholds (structuring) |
| Paying many people | Medium | Many different recipients in a short period |
| Paid by many people | Medium | Many different senders in a short period |
| Withdrawal from a new account | Medium | Cash-out soon after opening |
| Possible sanctions match | High | See section 5 |

How alerts are handled:

- **Who sees them:** alerts are visible only to admins, never to the customer, to avoid tipping off.
- **Effect on payouts:** an open medium or high alert holds the customer's withdrawals for review.
- **Reviewing:** a reviewer clears the alert (with a reason) or escalates it. Reviewers can't review alerts on their own account.
- **Case files [SYSTEM]:** each alert has running notes, which can't be edited or deleted. Each escalated case gets a recorded reporting decision.
- **Payout review:** withdrawals at or above `PAYOUT_REVIEW_USD` (US$1,000), or by customers with open alerts, wait for a second person. Rejected payouts are refunded to the wallet.

**[TO DO]** Tune thresholds to real customer behaviour after the first [3] months, and record why.

## 7. Suspicious transaction reporting

- **Escalation:** staff report suspicions to the MLRO straight away, through Admin → Compliance (escalate) or [INTERNAL CHANNEL].
- **Filing:** the MLRO decides and files STRs with the FIU, through goAML where used, within the legal deadline. The relevant FIUs are:
  - Kenya: Financial Reporting Centre;
  - Zambia: Financial Intelligence Centre;
  - Nigeria: NFIU;
  - Ghana: FIC;
  - Uganda: FIA.
- **Cash and threshold reports:** these are filed where the law requires them, such as currency transaction reports above national thresholds.
- **No tipping off:** we don't tell a customer that a report is being considered or has been made. The software never shows customers compliance alerts.
- **Records [SYSTEM]:** every decision on an escalated case is recorded, as reported (with the FIU's reference and the filing date) or not reported, with the reasons. Admin → Monitoring alerts → Reporting register exports them all.

## 8. Record keeping [SYSTEM, partly]

- **Ledger:** every money movement is recorded in a double-entry ledger, sealed so later changes are detectable. Journals can't be edited or deleted.
- **Audit log:** customer and staff actions are logged in a sealed audit log, including every view of an identity document.
- **Other records:** identity records, screening results and alert decisions are kept.
- **Retention:** records are kept for at least [the longest period required in our countries: 5–10 years] after the relationship ends.
  - **[SYSTEM]** With `RECORD_RETENTION_YEARS` set to that period, a closed account's personal data is deleted when it ends, and the account is anonymised.
  - The ledger, audit log and compliance records are kept.
  - Accounts under a legal hold, or with an open case, are kept.
- **Exports:** records can be exported for regulators (Admin → Ledger: trial balance, journal export).

## 9. Safeguarding customer money [SYSTEM, partly]

- **Where it's held:** customer balances are held in designated safeguarding accounts.
- **Daily reconciliation:**
  - customer money is reconciled every day against the ledger (Admin → Ledger → Safeguarding);
  - stale statements, and any shortfall, are flagged;
  - fee income is swept out only through a recorded journal.

**[TO DO]**

- Open the safeguarding or trust accounts with partner banks, as required by the licence.
- Name the person responsible for daily reconciliation, and for escalating a shortfall to the board and regulator.

## 10. Prohibited customers and activities

We don't onboard or keep:

- sanctioned persons;
- shell banks;
- anonymous accounts;
- customers who refuse due diligence;
- businesses in [PROHIBITED LIST from the Terms, section 11].

## 11. Training

All staff complete AML/CFT and sanctions training on joining and every year. Training records are kept. **[TO DO]**

## 12. Review

The MLRO reviews this policy at least yearly, and after any change in law, product or a significant incident. The board approves changes.
