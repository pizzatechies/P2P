# Going live in Africa: regulators, licences, sandboxes and partners

Research notes, November 2026, for choosing the first market and planning licensing. **This is a starting map, not legal advice.** Rules are changing fast: Kenya, Ghana and Zambia all have new or pending laws. Confirm every point with the regulator and a local lawyer before applying. Figures are from public sources and some conflict; where they do, it's noted.

## The key decision: your own licence, or a licensed partner

| Route | What it means | Time to market | Cost | Fit for Aurex |
|---|---|---|---|---|
| **A. Partner ("banking/payments-as-a-service")** | A licensed bank, e-money issuer or PSP holds customer money and the licence; Aurex is its technology provider or agent. | 2–4 months | Revenue share and set-up fees; low capital | **Recommended to start.** Launch in one country, prove demand, then license. |
| **B. Sandbox** | Test live with real customers under a regulator's supervision, with limits. | 3–9 months to get in; usually 12 months of testing | Low | Good if the product is novel (AI trading aids, crypto views) or a partner can't be found. |
| **C. Own licence** | Aurex holds the PSP or e-money licence itself. | 6–18 months | Capital, compliance staff, audits | Later, once volumes justify it. |

Whichever route you take:

- register with the data protection authority;
- register with the Financial Intelligence Unit (for STRs);
- treat trading and AI-advice features separately (section 5).

## Country by country

### Kenya

- **Payments regulator:** Central Bank of Kenya (CBK).
  - **Today:** National Payment System Act 2011 and NPS Regulations 2014. Payment service providers need CBK authorisation.
  - **Entry capital:** sources cite KES 10 million for a PSP (check the First Schedule of the 2014 Regulations); approval takes about 3–6 months.
  - **Coming:** a draft **National Payment System Bill 2026** (consultation closed in October 2026). It proposes:
    - 10 licence categories;
    - minimum core capital from KES 5 million to KES 250 million (e-money issuers at the top);
    - capital that stacks across categories.

  Watch its progress before applying.
- **Crypto:** the **Virtual Asset Service Providers Act 2025** is in force (commencement October–November 2025; sources differ on the exact date).
  - CBK and the Capital Markets Authority (CMA) license VASPs by activity.
  - Licensing starts with the **VASP Regulations 2026**. The draft was published in 2026, and a CBK/CMA notice on operationalising them was issued in November 2026.
  - Existing providers have one year to comply.
  - Aurex's watch-only wallets probably aren't a VASP activity, but confirm.
- **Securities:** CMA. It has run a **regulatory sandbox** since 2019. AI investment signals or a trading service likely need CMA licensing (investment adviser or online forex/securities rules) or the sandbox.
- **AML:** Financial Reporting Centre (FRC), under POCAMLA.
- **Data:** Office of the Data Protection Commissioner (ODPC). Registration as a controller is mandatory.
- **Rails:**
  - Safaricom M-Pesa (Daraja API: STK Push for pay-ins, B2C for payouts, already built);
  - Airtel Money;
  - PesaLink, through a bank.
- **Partners:** licensed banks with BaaS programmes, licensed PSPs, e-money issuers.
- **Why Kenya:** deepest mobile-money market, clear PSP regime, active sandbox culture. **Risk:** capital and licence changes in the NPS Bill.

### Zambia

- **Payments regulator:** Bank of Zambia (BoZ).
  - **Licensing:** payment system businesses need **designation/licensing under the National Payment Systems Act 2007**. E-money issuers follow the **NPS Directives on Electronic Money Issuance 2023**.
  - **Coming:** a bill to repeal and replace the NPS Act has been before Parliament; check its status.
  - **Unlicensed providers:** BoZ required them to apply by March 2023.
- **Sandbox:** BoZ runs a fintech sandbox; the SEC also has one for capital markets. Confirm current intake with each.
- **Securities:** Securities and Exchange Commission (SEC Zambia).
- **AML:** Financial Intelligence Centre (FIC), under the FIC Act 2010 as amended.
- **Data:** Data Protection Act 2021, with the Office of the Data Protection Commissioner. Registration is required for controllers and processors.
- **Rails:** MTN MoMo (already built), Airtel Money, Zamtel Kwacha, and banks through the Zambia Electronic Clearing House.
- **Why Zambia:** smaller, less crowded market, and the sandbox can be a quicker way in. **Risk:** pending NPS overhaul.

### Nigeria

- **Payments regulator:** Central Bank of Nigeria (CBN). Licence categories:

  | Licence | Capital most sources give |
  |---|---|
  | Switching and processing | ₦2 billion |
  | Mobile money operator (MMO) | ₦2 billion (one source says ₦5 billion+) |
  | Payment solution services (PSS) | ₦250 million |
  | PSSP | ₦100 million (some sources: ₦250 million) |
  | PTSP | ₦100 million |
  | Super-agent | ₦50 million |
  | Regulatory sandbox | No minimum |

  Confirm the current CBN circular.
- **Tiered KYC:** CBN's tiered KYC rules link BVN/NIN to limits, so Aurex's levels must match them.
- **Sandbox:** CBN regulatory sandbox, which takes applications in cohorts (a 2026 cohort closed on 31 August 2026).
- **Crypto and securities:** SEC Nigeria (Investments and Securities Act 2025 treats digital assets as securities).
- **AML:** NFIU, under the Money Laundering (Prevention and Prohibition) Act 2022.
- **Data:** Nigeria Data Protection Commission (NDPC), under the NDPA 2023.
- **Rails and partners:**
  - Paystack, Flutterwave (already built), Moniepoint, Interswitch;
  - NIBSS NIP for bank transfers;
  - Smile ID covers BVN and NIN checks.
- **Why Nigeria:** largest market. **Risk:** high capital, heavy competition, FX rules.

### Ghana

- **Payments regulator:** Bank of Ghana (BoG), under the **Payment Systems and Services Act 2019 (Act 987)**. Licence classes:
  - Dedicated Electronic Money Issuer;
  - Enhanced, Medium and Standard PSP;
  - Payment and Financial Technology Service Provider.
- **Crypto:** the **Virtual Asset Service Providers Act 2025 (Act 1154)** received assent on 30 December 2025.
  - BoG and the SEC license and supervise virtual asset businesses.
  - Rules are being phased in during 2026.
- **Sandbox:**
  - BoG's FinTech and Innovation Office runs a sandbox; it admitted six firms in January 2026 to test virtual asset frameworks.
  - The SEC admitted 11 crypto platforms to its sandbox in 2026.
- **AML:** Financial Intelligence Centre, under the AML Act 2020 (Act 1044).
- **Data:** Data Protection Commission, under the DPA 2012; registration required.
- **Rails:** MTN MoMo (already built), Telecel Cash, AirtelTigo Money, and GhIPSS for bank transfers.
- **Why Ghana:** clear payments licence tiers and an active, recent sandbox. Good for the crypto-related features.

### Also worth a look

| Country | Payments regulator and law | Notes |
|---|---|---|
| Uganda | Bank of Uganda, National Payment Systems Act 2020 | PSP and e-money licences; sandbox; MTN MoMo and Airtel. Data: PDPO. |
| Tanzania | Bank of Tanzania, NPS Act 2015 | M-Pesa, Tigo Pesa, Airtel; e-money licences. |
| Rwanda | National Bank of Rwanda | Fintech-friendly; Kenya and Rwanda are reported to be working on licence passporting. |
| South Africa | SARB (payments), FSCA (crypto-assets are financial products; CASPs licensed since 2023) | Mature but competitive; POPIA for data. |

## Trading and AI advice (all countries)

This is the area most likely to need a separate licence:

1. **Offering US stocks:**
   - Through Alpaca, the customer opens their own account with a US broker-dealer.
   - Many African regulators treat marketing foreign securities to residents as regulated activity. Ask CMA, SEC Zambia, SEC Nigeria and SEC Ghana whether a local licence, a partnership with a locally licensed broker, or a sandbox is needed.
   - Alpaca's own international onboarding rules also apply.
2. **AI signals and the Autopilot:**
   - Automated recommendations can count as **investment advice** or **portfolio management**.
   - Options: launch them as demo-only (already the default), present them strictly as education, or get the relevant licence or sandbox admission.
3. **Crypto:** Kenya's and Ghana's new VASP Acts license exchanges, custodians and wallet providers. Aurex's watch-only wallets hold no keys, but confirm in writing.

## Partners to approach

| Need | Options |
|---|---|
| Licensed partner to hold funds (route A) | Local banks with BaaS or agency programmes; licensed PSPs or EMIs such as Cellulant, Onafriq, Flutterwave (licensed in several countries), Paystack, Moniepoint; [RESEARCH per country] |
| Identity verification | Smile ID (built in; strong coverage in KE, NG, GH, ZA, UG. Check its supported ID types for each country before launch, because coverage is thinner in some markets, Zambia included); alternatives Youverify, Prembly (Dojah), VerifyMe |
| PEP and sanctions data | Smile ID AML check, ComplyAdvantage, Sanction Scanner, LexisNexis |
| Mobile money | Safaricom Daraja, MTN MoMo API, Airtel Money API (not yet built), or an aggregator (Flutterwave, Cellulant, pawaPay) |
| Brokerage | Alpaca (built in); locally licensed brokers if the regulator requires |
| Legal | A fintech practice in the first country, for licensing, the terms review and the data-protection registration |
| Compliance outsourcing | Outsourced MLRO or compliance consultancy for the first year |

## Suggested path

1. **Pick one country.** Kenya or Ghana are best for clarity and sandboxes; Zambia is best if you're based there.
2. **Talk to two or three licensed partners** (route A) and the regulator's fintech or innovation office (route B) at the same time.
3. **Register** with the data protection authority, and prepare FIU registration.
4. **Launch an invite-only beta** (`REGISTRATION_MODE=invite`, already built), with:
   - payments and wallets live through the partner;
   - trading kept demo-only;
   - AI kept as education.
5. **Get the independent penetration test** and the lawyer-reviewed legal pack before taking public deposits.
6. **Apply for your own licence** once volumes justify it, using the beta's data in the application.

## Sources

- Kenya VASP Act 2025:
  - [CBK public notice](https://www.centralbank.go.ke/uploads/press_releases/665231223_Public%20Notice%20on%20the%20Virtual%20Assets%20Service%20Providers%20Act%202025.pdf)
  - [CBK/CMA notice on operationalising the VASP Regulations 2026](https://www.centralbank.go.ke/wp-content/uploads/2026/11/CBK-CMA-Public-Notice-Operationalisation-of-the-VASP-Regulations-2026-.pdf)
  - [EY summary](https://taxnews.ey.com/news/2025-2314-kenya-enacts-virtual-asset-service-providers-act-2025-a-new-regulatory-era)
  - [Kenyans.co.ke on licensing timing](https://www.kenyans.co.ke/news/118063-cbk-delays-licensing-crypto-firms-treasury-drafts-new-regulations)
  - [CM Advocates](https://cmadvocates.com/blog/legal-alert-the-virtual-assets-service-providers-act-2025-is-now-in-force/)
- Kenya payments:
  - [Bowmans on the draft NPS Bill 2026](https://bowmanslaw.com/insights/kenya-national-payment-system-bill-2026-proposes-comprehensive-overhaul-of-the-payments-regulatory-framework/)
  - [Capital FM on proposed capital](https://capitalfm.africa/bill-proposes-sh250mn-minimum-capital-for-e-money-issuers/)
  - [CM Advocates PSP licence guide](https://cmadvocates.com/fr/blog/obtaining-a-psp-license-in-kenya-a-comprehensive-legal-and-regulatory-guide)
  - [RegAlert Kenya fintech guide](https://regalert.today/guides/fintech/KE)
- Zambia:
  - [RegAlert Zambia fintech guide](https://regalert.today/guides/fintech/ZM)
  - [Afriwise legal guide](https://www.afriwise.com/blog/regulation-of-fintech-in-zambia---a-legal-guide)
  - [Mondaq](https://www.mondaq.com/fin-tech/1283892/regulation-of-fintech-in-zambia-a-legal-guide)
  - [Parliament of Zambia](https://www.parliament.gov.zm/node/12689)
- Ghana:
  - [Bank of Ghana: virtual assets](https://www.bog.gov.gh/virtual-assets/)
  - [AllAfrica on the VASP law](https://allafrica.com/stories/202512270006.html)
  - [US Trade.gov market intelligence](https://www.trade.gov/market-intelligence/ghana-financial-services-new-virtual-assets-framework)
  - [Graphic Online on the BoG sandbox cohort](https://www.graphic.com.gh/business/business-news/six-fintech-firms-cleared-to-test-virtual-asset-frameworks-under-bank-of-ghana-sandbox.html)
  - [Cointelegraph on the SEC sandbox](https://regional-front.cointelegraph.com/news/ghana-greenlights-11-crypto-companies-sandbox)
- Nigeria:
  - [TechCabal: CBN licences](https://techcabal.com/2025/05/13/cbn-licences-in-nigeria/)
  - [PwC on the CBN circular](https://www.pwc.com/ng/en/assets/pdf/cbn-circular-payment-service-providers.pdf)
  - [Mondaq licence categorisation](https://www.mondaq.co.uk/nigeria/fin-tech/1044968/summary-of-the-revised-licence-categorisation-for-operators-in-the-nigerian-payments)
- Sandboxes:
  - [Open Bank Project: regulatory sandboxes in Africa](https://www.openbankproject.com/blog/regulatory-sandboxes-in-africa/)
  - [Chambers Fintech 2026](https://gpg-pdf.chambers.com/fintech-2026/466/)
