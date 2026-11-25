# Aurex Privacy Policy

> **DRAFT for legal review — not in force.** This draft describes what the Aurex software actually collects and does, as of November 2026. Fill in the `[BRACKETED]` items and check it against the data-protection law of each country of operation:
> - Kenya: Data Protection Act 2019.
> - Zambia: Data Protection Act 2021.
> - Nigeria: Nigeria Data Protection Act 2023.
> - Ghana: Data Protection Act 2012.
> - Uganda: Data Protection and Privacy Act 2019.
> - South Africa: POPIA.
>
> Register with each data protection authority where registration is required before launch.

**Effective date:** [EFFECTIVE DATE]

## 1. Who is responsible for your data

**[COMPANY NAME]** ([REGISTERED ADDRESS]) is the data controller for Aurex.

- **Data protection officer:** [DPO NAME], at [DPO EMAIL].
- **Registration (where required):** [e.g. registered with the Office of the Data Protection Commissioner (Kenya) under number [NUMBER]].

## 2. What we collect

| What | Examples | Why |
|---|---|---|
| **Account details** | Name, @handle, email address, password (stored only as a one-way hash), preferred currency | To run your account and sign you in |
| **Identity details** | Legal name, date of birth, nationality, phone, address, ID type and number | Required by anti-money-laundering law to verify who you are |
| **Identity documents** | Photos or scans of your ID, a selfie, proof of address | The same. Stored encrypted. |
| **Government record checks** | The result of checking your ID number with the issuing authority (name and birth date on record, match result) | To confirm your identity; done by our identity partner with your consent |
| **Sanctions and compliance** | Screening results, monitoring alerts, reviewer notes | Legal duty to prevent financial crime. We don't share these with you where the law forbids it. |
| **Money** | Balances, payments, requests, deposits, withdrawals, payout destinations, fees | To provide the service, keep accounts and meet record-keeping law |
| **Business accounts** | Business name, category, registration number, country, website | To review and run a business account |
| **Trading** | Demo and real orders, positions, trade history, watchlist, AI signals, Autopilot settings and history | To provide trading features and records |
| **Connected accounts** | Which providers you've linked, account names and balances they share, public wallet addresses (stored encrypted) | To show your accounts in one place, at your request |
| **AI conversations** | Your messages and the replies | To provide the AI assistant |
| **Security and devices** | IP address, browser and device description, sign-in history, sessions, security alerts, activity log | To protect your account and detect fraud |
| **Messages** | Emails we send you and your messages to support | To communicate with you |

We don't sell your data, and we don't use it for third-party advertising.

## 3. Who we share it with

We share only what each needs to do its job:

- **Identity verification:** [Smile ID (Smile Identity Inc.)], which checks ID numbers against government records.
- **Payment partners, when you use them:**
  - [Stripe, Flutterwave, Safaricom (M-Pesa), MTN (MoMo), PayPal, Wise, Skrill, MoneyGram];
  - they receive the payment details and the payer or recipient details needed.
- **Account connections, when you link one:** [Plaid, Mono, Salt Edge, SnapTrade, Coinbase]. Public blockchain data providers receive the wallet address only, when we look up its balance.
- **Brokerage, for real trading:** [Alpaca Securities LLC].
- **AI providers, when you use the AI assistant or AI signals:**
  - Your messages, and the market data needed for a signal, are sent to the provider you or we choose: [Anthropic, OpenAI, Google, Mistral, Groq, xAI, DeepSeek, OpenRouter, Together, Perplexity].
  - Don't share personal or sensitive details in AI chats.
- **Email delivery:** [Resend].
- **Card payments, if you get an Aurex card:**
  - The card is issued by [Stripe's card-issuing partner], or for customers in Africa by Bitnob. Your name, billing address, email and phone number go to the issuer to issue it.
  - Bitnob also checks who you are: your verified date of birth, ID number and ID photos, and your answers about your work and income, go to Bitnob when you apply.
  - Each card payment comes back to us so we can approve it: the merchant, amount and place.
  - The card number is shown to you only in Stripe's secure fields; we never see or store it.
  - If you add the card to Apple Wallet, Google Wallet or Samsung Wallet, that wallet's provider handles it under its own terms. We're told which wallet and device, so we can warn you if it wasn't you.
- **Tap to Pay, if you take card payments as a business:**
  - Payments are processed by Stripe.
  - Your phone's location is used while you take a payment, because Stripe's Tap to Pay software requires it.
- **NFC stickers and phone-to-phone taps** only pass your public pay link; nothing else is shared.
- **Phone notifications, if you turn them on:**
  - They're sent from our own notification server to the ntfy app on your phone.
  - On iPhone, the ntfy.sh service (and Apple's push service) is told only that a new message is waiting, with a message ID and a scrambled form of your private channel name. The notification text comes from our server.
  - Notifications can show amounts and names on your lock screen. You can turn them off, or choose which kinds you get, under Settings → Notifications.
- **Hosting:** [Amazon Web Services, region eu-north-1 (Stockholm, Sweden)].
- **Authorities:** regulators, the Financial Intelligence Unit, tax authorities, courts and law enforcement, when the law requires it.
- **Professional advisers and auditors**, under confidentiality.

## 4. International transfers

Some of these partners, and our hosting, are outside your country (for example in the European Union and the United States).

- **Safeguards:** we transfer data only where the law allows, with appropriate safeguards [standard contractual clauses / adequacy / your consent], as required by [the relevant Act].
- **Copies:** you can ask us for a copy of the safeguards.

## 5. How long we keep it

- **Financial, identity and transaction records:** kept for at least [5 to 10] years after the relationship ends, as anti-money-laundering law requires.
  - Kenya POCAMLA: 7 years.
  - [Zambia FIC Act: 10 years].
  - [Nigeria MLPPA 2022: 5 years].
  - [Ghana Act 1044: 5 years].
  - Confirm each period.
- **Everything else:** kept while your account is open and for [2] years after, unless needed for a dispute.
- **When the period ends:** the personal data of a closed account is deleted automatically: identity documents and details, support messages, payout details and contact details. Your account record is anonymised. We keep it longer only when the law requires it, for example during an investigation.
- **Ledger and audit records:** these are tamper-evident and can't be edited, so they're kept as financial records. Once your personal data is deleted, they're linked only to the anonymised account.

## 6. Your rights

You can:

- **get a copy of your data:** Account → Your data → Download, or ask us;
- **correct it:** in the app, or ask us;
- **ask us to delete it:** we'll delete what the law doesn't require us to keep;
- **object to or restrict processing**, and withdraw consent where we rely on consent (for example to a government record check, before it's done);
- **complain** to us at [DPO EMAIL], or to the data protection authority: [ODPC Kenya / ODPC Zambia / NDPC Nigeria / DPC Ghana / PDPO Uganda / Information Regulator South Africa].

We'll answer within [30] days.

## 7. How we protect it

- **Encryption:** identity documents and details, keys and wallet addresses are encrypted (AES-256-GCM). Passwords are hashed (scrypt), and connections use HTTPS.
- **Protecting your account:** two-factor authentication, sign-in alerts and session controls.
- **Staff access:** limited, needs two-factor authentication, and every view of an identity document is logged.
- **Tamper evidence:** the ledger and audit log are sealed so changes can be detected.
- **Breaches:** if a breach puts you at risk, we'll tell you and the authority as the law requires.

## 8. Cookies

Aurex uses one strictly necessary cookie to keep you signed in. We don't use advertising or analytics cookies. [Update if analytics are added.]

## 9. Children

Aurex isn't for anyone under 18. We delete data we learn was collected from a child, unless the law requires us to keep it.

## 10. Changes

We'll tell you about important changes by email and in the app before they take effect.
