# Aurex

Peer-to-peer payments, a multi-provider AI hub and AI-assisted trading in stocks, crypto and futures in one web app.

| | |
|---|---|
| **Accounts** | Every customer gets a 10-digit account number (with a check digit). Identity verification in three levels raises limits as customers prove who they are, with documents reviewed by your team. Monthly statements (printable, PDF or CSV), a full download of the customer's data, and self-service account closure that keeps the records the law needs |
| **Payments** | Multi-currency wallets (19 currencies), send by @handle, email or account number, request money, currency conversion, deposits and withdrawals through pluggable payment rails, all on a double-entry ledger |
| **AI Hub** | Chat with Claude, GPT, Gemini, Mistral, Llama (Groq/Together), Grok, DeepSeek, OpenRouter's catalogue, Perplexity and self-hosted Ollama models. Responses stream live, conversations are saved, a compare mode runs up to 4 models side by side, and users can bring their own encrypted keys |
| **AI Autopilot** | Optional: the AI trades for the user on a schedule, strictly inside limits they set (per position, total invested, trades per day, minimum confidence, daily loss stop), or proposes trades for one-tap approval |
| **Reach** | Installable app (add to home screen, works offline for the app shell), shareable pay links that sign new people up and land them on the payment, WhatsApp sharing, and a free daily AI allowance |
| **Connections** | Link outside banks, cards, brokerages and crypto through Plaid, Salt Edge, Mono, SnapTrade and Coinbase to see a combined net worth. Move money in and out with M-Pesa, MTN MoMo, PayPal/Venmo, Wise (bank payouts to 160+ countries), Flutterwave and Stripe |
| **Trading** | Every US-listed stock and ETF (~12,000), hundreds of cryptocurrencies with live prices (24/7, fractional) and 20 futures contracts with real sizes, margin and leverage (long or short). A demo account with virtual cash, or each user's own Alpaca account for real stocks and crypto. Charts and indicators, plus an AI analyst that returns buy/sell/hold signals with position size, stop-loss and take-profit. Execution is one click, but the user must confirm and position caps apply |

It works out of the box with no keys at all: sandbox payments, simulated market data, a rule-based analyst and an offline demo assistant. Add keys to switch each part to real providers.

> **Read [Going to production](#going-to-production) before handling real money.** Moving customer funds legally requires licensed partners, KYC/AML and more. The code gives you a sound ledger and integration points, but it does not replace those obligations.

---

## Quick start

Requirements: **Node.js 22.13+**, which ships the built-in `node:sqlite` module. Nothing else is needed: no database server and no native modules.

```bash
npm install
```

```bash
npm run dev
```

- Web app: http://localhost:5173 (Vite, proxies `/api` to the server)
- API: http://localhost:4000

Create two accounts in two browser windows, add sandbox money and send it back and forth. To make yourself an admin, set `ADMIN_EMAILS=you@example.com`. It applies when that account registers or next signs in.

### Configuration

Copy `.env.example` to `server/.env` and fill in what you need. The server loads it automatically. Common setups:

| Goal | Set |
|---|---|
| Claude in the AI Hub and as the trading analyst | `ANTHROPIC_API_KEY` |
| Any other AI provider for every user | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, … |
| Real market data | `ALPACA_DATA_KEY_ID`, `ALPACA_DATA_SECRET_KEY` (a free Alpaca account works) |
| Card deposits | `PAYMENT_RAILS=sandbox,stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Mobile money, cards and bank payouts in Africa | `PAYMENT_RAILS=…,flutterwave`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` |
| M-Pesa direct (Kenya) | `PAYMENT_RAILS=…,mpesa`, `MPESA_*` |
| MTN MoMo direct | `PAYMENT_RAILS=…,mtn-momo`, `MTN_MOMO_*` |
| PayPal and Venmo | `PAYMENT_RAILS=…,paypal`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |
| Bank payouts to 160+ countries | `PAYMENT_RAILS=…,wise`, `WISE_API_TOKEN`, `WISE_PROFILE_ID` |
| Skrill wallets | `PAYMENT_RAILS=…,skrill`, `SKRILL_EMAIL`, `SKRILL_SECRET_WORD`, `SKRILL_API_PASSWORD` |
| Cash pickup worldwide | `PAYMENT_RAILS=…,moneygram`, `MONEYGRAM_CLIENT_ID`, `MONEYGRAM_CLIENT_SECRET`, `MONEYGRAM_PARTNER_ID` |
| Link outside banks, brokerages and crypto | Any of `PLAID_*`, `SALTEDGE_*`, `MONO_*`, `SNAPTRADE_*`, `COINBASE_*` (see [Connections](#connections)) |
| Live exchange rates | `FX_LIVE=true` |

Users can also add their own AI keys and Alpaca keys under **Settings**. These are stored encrypted with AES-256-GCM.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + web (Vite) with hot reload |
| `npm test` | Server test suite (Vitest + Supertest) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run build` | Compiles the server to `server/dist` and the web app to `web/dist` |
| `npm start` | Runs the built server, which also serves the built web app |

---

## Architecture

```
web/  (React 19 + Vite)                 server/  (Express 5 + node:sqlite)
┌──────────────────────────┐   /api    ┌──────────────────────────────────────────┐
│ Dashboard · Wallet       │ ────────▶ │ routes/     auth, payments, ai, trading, │
│ Payments · AI Hub        │  cookies  │             settings, admin, webhooks    │
│ Trading · Settings       │  + SSE    │ services/   ledger ─ payments ─ fx       │
└──────────────────────────┘           │             rails/  sandbox · stripe     │
                                       │             ai/     anthropic SDK ·      │
                                       │                     OpenAI-compatible ·  │
                                       │                     demo                 │
                                       │             trading/ market · indicators │
                                       │                     · paper · alpaca ·   │
                                       │                     analyst              │
                                       │ SQLite (WAL) – one file, migrations      │
                                       └──────────────────────────────────────────┘
```

### Payments: the ledger

Every money movement is a **journal** of signed **entries**. For each currency the entries sum to zero, so money is only ever moved, never created or lost. Some guarantees:

- Amounts are integer minor units (cents). Decimal input is parsed without floating-point maths.
- Balances are cached on accounts, updated in the same transaction, and protected by a `CHECK` constraint, so an account can't be overdrawn even by a bug.
- Ledger entries are immutable: database triggers reject `UPDATE`/`DELETE`, and corrections are new journals.
- Transfers, conversions and withdrawals accept an **idempotency key**, so a retried request never pays twice.
- Withdrawals move funds into a `clearing` account *before* calling the payment rail, then settle or reverse.
- Per-transaction and rolling 24h limits are applied in USD-equivalent, and depend on the customer's verification level (see [Accounts](#accounts-and-identity-verification)).
- `GET /api/admin/overview` (and the Admin page) runs a full integrity check: journals balance, cached balances match entries, and system totals net to zero.

System accounts: `external` (the outside world), `clearing` (withdrawals in flight), `fees`, `fx`.

**Reading the books** (Admin → Ledger & records). Everything here is computed from the immutable entries, so any figure can be recomputed and checked:

- **Trial balance** for now or the end of any past day: per currency, what customers are owed, external, clearing, fees and FX, with a check that each currency sums to zero. Download as CSV.
- **Journals:** search by journal reference, transfer id or the provider's reference, filter by kind, currency, customer and dates, and open any journal to see its entries (debit, credit and the account's balance after each one) and the deposit, withdrawal or payment request it belongs to.
- **End-of-day snapshots:** after each day ends (UTC) the server stores that day's closing totals per currency, the money moved and the journals posted. Opening the page recomputes the last 31 days from the entries and flags any figure that changed after the day closed.
- **Export:** every entry in a date range (up to a year) as CSV with debit and credit columns, for accounting software. It needs a recent sign-in and is written to the audit log.

Customers can download their wallet activity for any dates (up to a year) as CSV from Account → Statements, alongside the monthly statements.

### Real money: payout review, monitoring and safeguarding

These provisions matter once real money flows through the rails.

**Payout review (two people for money leaving).** A withdrawal at or over `PAYOUT_REVIEW_USD` ($1,000), or from a customer with an open medium or high monitoring alert, isn't sent straight away:

- The money moves to clearing so it can't be spent twice. The customer sees "In review", and admins get an alert.
- Under **Admin → Withdrawals to review**, a second admin either approves it (it goes to the payment provider then) or returns the money with a reason the customer sees.
- Nobody can review their own withdrawal, and decisions need a recent sign-in and are audited.
- `PAYOUT_REVIEW=false` turns this off.

**Transaction monitoring.** Every deposit, payment and withdrawal is checked against common money-laundering patterns:

| Pattern | Severity |
|---|---|
| A single payment at or over `MONITOR_LARGE_USD` ($3,000) | medium |
| Money withdrawn within a day of arriving (80% or more of it) | high |
| Three or more payments in a day just under the per-payment limit (structuring) | medium |
| Paying, or being paid by, 10 or more different people in a day | medium |
| A withdrawal from an account less than 3 days old | medium |

Alerts appear under **Admin → Monitoring alerts** and on the customer's admin page. An admin clears them with a note, or escalates them (optionally freezing the account). Customers never see alerts: in most AML regimes, telling a customer they're under review ("tipping off") is itself an offence.

**Safeguarding** (Admin → Ledger & records → Safeguarding). Customers' money must be kept apart from the business's own and be there in full.

- **Register where the money is held:** safeguarding bank accounts, mobile-money (e.g. an M-Pesa paybill) and provider balances. Account numbers are stored encrypted, and viewing one is audited.
- **Record balances:** type them in from statements, or fetch them from **Stripe**, **Wise** and **Flutterwave** with the server's keys.
- **Reconciliation** compares, per currency, what Aurex owes (every customer wallet plus withdrawals not yet paid out) with the latest balances held:
  - The result is **covered**, **shortfall** or **not verified** (no account, or a balance older than `SAFEGUARDING_STALE_HOURS`, 48).
  - It runs every 6 hours and on demand. Results are stored and can't be changed, and a shortfall alerts every admin.
- **Income to move out:** fees and FX income belong to the business. After moving them from the safeguarding account to the operating account at the bank, record the sweep, which posts an `income_sweep` journal so the books keep matching the money held.
- **Who holds customers' assets:**
  - Wallet money is held by Aurex (safeguarded).
  - Stocks and crypto on real accounts are held by the customer's own Alpaca account.
  - Linked accounts stay at their bank or broker (read-only).
  - Demo money is virtual.

**Payment rails** are how money enters and leaves the platform (`server/src/services/rails`):

| Rail | Deposits | Withdrawals | Notes |
|---|---|---|---|
| `sandbox` | instant | instant | Test money. Account numbers ending in `0000` fail, to demo reversals |
| `stripe` | Stripe Checkout | – | Wallet credited only from the signed `checkout.session.completed` webhook. Point Stripe at `POST /api/webhooks/stripe` |

Rails included: `sandbox`, `stripe`, `flutterwave`, `mpesa`, `mtn-momo`, `paypal`, `wise`, `skrill` and `moneygram` (see [Connections](#connections)). To add another rail, implement the `PaymentRail` interface in `rails/types.ts` and register it in `rails/index.ts`. The ledger and UI don't change.

### Accounts and identity verification

Everything about a customer's account lives on the **Account** page (click your name in the sidebar).

**Account numbers.** Each customer gets a 10-digit number, shown as `1234 567 890`. The last digit is a Luhn check digit, so a mistyped number is rejected instead of paying a stranger. People can pay an account number the same way they pay an @handle or email. Accounts created before this feature get a number on the next start.

**Identity verification (KYC)** has three levels. Limits are in US-dollar equivalent and apply to each payment, withdrawal and deposit, and to the rolling 24 hours:

| Level | What the customer provides | Per payment | Per 24 hours |
|---|---|---|---|
| 0 · Basic | Email sign-up | `TIER0_TX_USD` ($200) | `TIER0_DAILY_USD` ($500) |
| 1 · Verified identity | Legal name, date of birth (18+), nationality, phone, home address, an ID document (passport, national ID or driving licence; front, plus back for cards), and a selfie holding the ID | `TIER1_TX_USD` ($2,000) | `TIER1_DAILY_USD` ($5,000) |
| 2 · Enhanced | Occupation, source of funds, expected monthly volume, whether they hold a public role (PEP), and a proof of address from the last 3 months | `MAX_TX_USD` ($10,000) | `DAILY_LIMIT_USD` ($25,000) |

- Details and documents are encrypted with AES-256-GCM (and re-encrypted when `MASTER_KEY` rotates). Uploads are checked by their content, not their name: JPEG, PNG, WebP or PDF, 1 KB to 5 MB, and a selfie must be a photo.
- Submissions go to **Admin → Identity verification**. Reviewers see the details and the documents, and approve or send back with a note the customer sees. Opening a document is written to the audit log, and nobody can review their own submission.
- `KYC_AUTO_APPROVE=true` approves complete submissions instantly. Use it only for testing, or once a verification provider makes the decision for you.
- `KYC_LIMITS=false` turns the levels off and applies `MAX_TX_USD` / `DAILY_LIMIT_USD` to everyone. Admin accounts are never tiered.

**Statements.** Customers pick a month and a wallet and get the opening balance, every movement and the closing balance, built from the ledger. The page prints cleanly, so "Save as PDF" in the browser gives a PDF statement, and there's a CSV download. Cells that would start a spreadsheet formula are neutralised.

**Your data.** "Download my data" exports a JSON file with the profile, verification details, wallets, transactions, payment requests, deposits and withdrawals, linked accounts, trading, AI conversations, academy progress and security history. Password hashes, 2FA secrets and API keys are never included. It needs a recent sign-in and is rate-limited.

**Closing an account.** The customer types their @handle to confirm. Closing is blocked while money is left in any wallet, a deposit or withdrawal is in flight, the account is an admin, or a live brokerage is connected. It signs them out everywhere and deletes AI chats, keys, linked accounts and the watchlist. The ledger, verification records and audit trail are kept, as financial law requires. An admin can reopen a closed account.

**Admin tools.** Admin → Customers searches by name, @handle, email or account number. Each customer has a page with their profile, balances, limits, verification (with documents), recent activity, deposits and withdrawals, trading, sessions, security events and internal notes. From there an admin can freeze or reopen the account, set custom limits (leave them empty to use the level's default), set the verification level by hand with a reason, and add notes. Every view and change is audited.

### AI Hub

- **Anthropic** uses the official `@anthropic-ai/sdk`. Default model: `claude-opus-5-5`. Server-side refusal fallback (`fallbacks: "default"`) is enabled on models that support it, so a safety-classifier decline is retried on Anthropic's recommended fallback model instead of failing.
- **OpenAI-compatible providers** share one adapter (`ai/openaiCompat.ts`). Adding a provider is usually one entry in `ai/providers.ts`.
- **Model discovery:** each provider's catalogue loads live from its `/models` endpoint when a key is present. Users can also type any model id.
- **Credentials:** the user's own key is used first, then the server-wide key from the environment.
- Replies stream to the browser over **Server-Sent Events**. Closing the tab aborts the upstream request.
- The offline **demo** provider keeps everything usable without keys.

### Trading

**Demo accounts, the academy and real accounts**
- Every user starts with a **demo account** of virtual money. They can restart it any time with a balance from $1,000 to $1,000,000.
- **Learn** (`/app/learn`) has six core lessons: how markets work, order types, risk and position sizing, reading charts, trading with the AI analyst, and going live, plus an optional lesson on crypto and futures (margin, leverage, margin calls, going short). Each ends with a quiz graded on the server (80% to pass); the answers never reach the browser. **Practice missions** are detected from demo activity: first buy, a limit order, a sale, three different stocks, a crypto trade, a futures position, an AI analysis and a watchlist.
- **Upgrade to real** (`/app/upgrade`) requires:
  - a verified email and 2FA;
  - the six core quizzes passed and `LIVE_MIN_PRACTICE_TRADES` demo trades;
  - an appropriateness questionnaire and four acknowledgements.
- The questionnaire gives warnings for risky answers (for example, speculating with no experience or limited savings). The user must acknowledge them before applying.
- The applicant must be 18+, and `LIVE_COUNTRIES` can restrict where real accounts are offered. Personal details are encrypted with `MASTER_KEY`.
- Admins review applications under Admin → Real-account applications, or set `LIVE_UPGRADE_AUTO_APPROVE=true`.
- Live brokerage keys and the live broker are refused until the application is approved and `ALLOW_LIVE_TRADING=true`. Revoking an approval returns the user to their demo account immediately.
- Real trades go through the user's own licensed broker (Alpaca), which runs its own identity checks; Aurex never holds securities.

- **Markets** (symbols tell them apart: `AAPL`, `BTC-USD`, `ES=F`; `BTC/USD` and `/ES` are accepted too):
  - **Stocks and ETFs:** every US listing (~12,000), from Nasdaq Trader's daily symbol files (`STOCK_DIRECTORY=nasdaq`, the default; `builtin` limits search to ~60 popular names). Prices from Alpaca (real, IEX feed) when the user or server has Alpaca keys, otherwise a deterministic simulator that prices any listed ticker, clearly labelled.
  - **Crypto:** every coin Coinbase trades against USD (~400, stablecoins excluded), with live prices and daily history from Coinbase's public market data, no key needed (`CRYPTO_DATA=coinbase`, the default; `simulated` for offline use). Trades 24/7 in fractions (up to 8 decimals, $1 minimum).
  - **Futures:** 20 front-month contracts (E-mini and micro S&P 500, Nasdaq-100, Dow, Russell 2000; WTI crude, micro crude, natural gas; gold, micro gold, silver, copper; corn, wheat, soybeans; 10-year Treasury note; euro FX; CME Bitcoin and Micro Bitcoin) with real multipliers, tick sizes and approximate exchange margin. Prices are simulated, because live futures data needs a paid exchange licence. Demo account only: Alpaca doesn't offer futures.
- **Brokers:** the built-in demo broker or the user's **own** Alpaca account through their own keys. The demo broker fills market orders instantly and limit orders when the price crosses. Stocks and crypto are long-only and paid in full; futures are margined, go long or short, settle profit and loss to cash as positions close, and are closed automatically if the account falls below maintenance margin (a margin call, shown in the order history). The Alpaca broker trades stocks and crypto (`BTC-USD` becomes Alpaca's `BTC/USD`, good-till-canceled) and refuses futures. Live Alpaca accounts are refused unless the operator sets `ALLOW_LIVE_TRADING=true`.
- **AI analyst:** computes SMA 20/50/200, RSI, MACD, ATR, volatility, returns and the 52-week range, then asks the selected model for a structured signal. Claude responses use structured outputs, which are schema-guaranteed; other providers use JSON mode plus validation. With no AI connected, a transparent rule-based model is used.
- **Guardrails** are enforced on the server:
  - Every AI-originated order needs explicit confirmation.
  - Each signal can be executed only once.
  - AI buys are capped at `AI_MAX_POSITION_PCT` of portfolio equity (default 10%); for futures the cap applies to the margin a new position ties up.
  - "Sell" without a position is downgraded to "hold" for stocks and crypto, which are long-only. For futures it means going short.
  - The autopilot trades stocks and crypto only, never leveraged futures.

**Trading records** (Trading → Records & P&L):

- Every execution is stored once, in an immutable trade record: quantity, price, value, the contract multiplier, how much of a position it closed, the cost basis and the realised profit or loss, and the position and cash after it. Demo orders are recorded as they fill. Real (Alpaca) orders are recorded when Alpaca reports them final, including what filled before a cancel. Their profit or loss is left as "unknown", because Aurex may not have seen the account's earlier trades.
- Stocks and crypto use the **average-cost method**. Futures realise profit or loss as positions are reduced, closed or flipped.
- The demo account has a **cash journal**: every buy, sale, futures settlement and reset, with the balance after it. It always adds up to the account's cash, and Admin → Ledger & records → Trading checks that for every account.
- Each portfolio is **valued once a day** (and whenever the customer opens Trading), which draws the value chart.
- Reports: performance since the last demo reset (change in value, largest fall from a peak, win rate, profit factor, best and worst trade), realised profit and loss by year, month and symbol, and the full trade history with filters. Each downloads as CSV.
- Orders filled before trading records existed are added from the order history on the next start. Their profit or loss is unknown.

### AI Autopilot

`server/src/services/trading/autopilot.ts`. Off by default; each user switches it on after accepting a plain-language summary of what it will do. A background scheduler (started in `index.ts`) runs each user's autopilot at their chosen interval. On every run:

1. **Safety first:** live (real-money) accounts are refused unless the server sets `ALLOW_LIVE_AUTOPILOT=true` *and* the user opts in. Alpaca accounts only trade while the market is open. If the portfolio is down more than the user's daily loss limit since the day started, the autopilot pauses until the user resumes it.
2. **Exits:** positions it opened are sold at the AI's stop-loss or take-profit.
3. **Decisions:** the analyst reviews each watched symbol (up to 10). It acts only at or above the user's confidence threshold, sizes buys within the per-position and total-invested caps (never above `AI_MAX_POSITION_PCT`), and stops at the daily trade limit. In "ask me first" mode it records proposals the user approves with one tap.
4. **Logging:** every decision, including holds and errors, is logged and shown in the Trading page. Three failed runs in a row pause it.

Orders record who placed them (`placed_by`: user or autopilot).

### Connections

**Connections** links accounts a user holds elsewhere: banks, cards, brokerages and wallets. Aurex reads their balances and shows a combined net worth, converted to the user's default currency at mid-market rates. No one network reaches every institution in the world, so Aurex goes through licensed aggregators, each covering a region:

| Provider | Coverage | Keys | Webhook |
|---|---|---|---|
| Plaid (Hosted Link) | US, Canada, UK, Europe | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | `/api/webhooks/plaid` |
| Salt Edge (AIS v6) | Europe, Middle East, Asia, Latin America, Africa | `SALTEDGE_APP_ID`, `SALTEDGE_SECRET` | none (the redirect completes the link) |
| Mono (beta) | Nigeria and other African markets | `MONO_SECRET_KEY`, `MONO_WEBHOOK_SECRET` | `/api/webhooks/mono` |
| SnapTrade | Retail brokerages (Schwab, Fidelity, Robinhood, IBKR, …) | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | none |
| Coinbase (OAuth) | Crypto and cash held at Coinbase | `COINBASE_CLIENT_ID`, `COINBASE_CLIENT_SECRET` | none; redirect URI `/api/connections/oauth/coinbase/callback` |
| Demo institutions | Six simulated banks and a brokerage | enabled with the `sandbox` rail | none |

How it works:

- The user picks a provider and is sent to that provider's own consent page. Their bank password never touches Aurex.
- The provider redirects back to `/app/connections?callback=<provider>&link=<id>`. The server then confirms the link with the provider and stores the access token encrypted (AES-256-GCM).
- Webhooks never mark a link active on their own. They only make the server ask the provider again.
- Linked balances are **read-only snapshots**. They never enter the ledger. Moving money in or out of an Aurex wallet still goes through a payment rail.
- **Disconnect** revokes access at the provider (best effort) and deletes the stored token and accounts.

Each provider needs its own operator agreement and keys, and production access usually needs the provider's review. The provider cards in the app tell admins which variables to set.

Coinbase links with OAuth. The `state` carries the link id plus a nonce, and only the nonce's hash is stored and checked. Refresh tokens are single-use, so each one is saved the moment it rotates and syncs never run twice at once. Crypto is valued in USD with Coinbase's public rates so it counts toward net worth.

**Payment rails** move money in and out of the Aurex wallet:

| Rail | Deposits | Payouts | Currencies | How a result is confirmed |
|---|---|---|---|---|
| `stripe` | Cards, Apple Pay, Google Pay (hosted checkout) | none | many | Checkout Session lookup and signed webhook |
| `flutterwave` | Card, bank, mobile money (hosted checkout) | Banks and mobile wallets (needs a bank/network code, e.g. `MPS`) | NGN, GHS, KES, UGX, TZS, ZAR, ZMW, USD, EUR, GBP | `verify_by_reference`, transfer lookup; webhook needs `verif-hash` |
| `mpesa` | STK Push: PIN prompt on the customer's phone | B2C to M-Pesa | KES (whole shillings) | STK Push Query; B2C results by callback |
| `mtn-momo` | Request to Pay: PIN prompt on the phone | Disbursement transfer | The market's currency | `GET …/requesttopay/{id}` and `GET …/transfer/{id}` |
| `paypal` | PayPal approval, then capture | PayPal (email/phone) or Venmo (US, USD) | USD, EUR, GBP, CAD, AUD, CHF, JPY, MXN | Order and capture lookup; payout batch lookup |
| `wise` | none | Bank accounts in 160+ countries | 18 of Aurex's currencies | Transfer status lookup |
| `skrill` | Skrill Quick Checkout (wallet, cards, local methods) | To a Skrill account email | EUR, USD, GBP, CAD, AUD, CHF, JPY, INR, AED, ZAR | Merchant Query Interface; status notification with `md5sig` |
| `moneygram` | none | Cash pickup in 200+ countries (reference number + ID) | `MONEYGRAM_SEND_CURRENCIES` | Quote → update (compliance screening) → commit; Status API (`RECEIVED` = collected) |

Details:

- **No redirect or webhook moves money on its own.** Aurex asks the provider for the real state first. The exception is M-Pesa B2C, because Safaricom offers no synchronous lookup. Those results are only accepted on a callback URL that contains a secret derived from `MASTER_KEY`, and their conversation ids must match the payout Aurex sent. A B2C queue timeout leaves the payout pending for review rather than guessing.
- **Idempotency.** MoMo `X-Reference-Id`, Wise `customerTransactionId`, PayPal `PayPal-Request-Id`, M-Pesa `OriginatorConversationID`, Skrill `frn_trn_id` and MoneyGram `X-MG-ClientRequestId`/`partnerTransactionId` all derive from Aurex's transfer id, so a retry can't pay twice.
- **Skrill** deposits are confirmed through the Merchant Query Interface. Without an API password, the status notification is accepted only when its `md5sig` matches the secret word, and only for the amount and currency Aurex asked for. Payouts need the API enabled for the server's IP.
- **MoneyGram** payouts give the user a reference number, shown once in the app and kept in their transfer history. The recipient collects the cash with it and a matching ID. If it's never collected and MoneyGram refunds it, the user is refunded too.
- **Deposits to a phone** (M-Pesa, MoMo) ask for the number. The app then waits on an "Approve on your phone" screen and polls `/api/payments/transfers/:id/refresh`.
- **Wise payouts** use the form Wise describes for each currency (`POST /api/payments/payout-requirements`, refreshed when a field such as the country changes). Aurex creates the recipient, a quote for the exact amount, the transfer, and then funds it from the operator's Wise balance. That balance is in the same currency when the profile holds one, otherwise `WISE_FUNDING_CURRENCY`. If funding fails, the transfer is cancelled and the user is refunded.
- **Withdrawals** are held in clearing before the provider is called, and refunded automatically if it rejects them.

Each provider needs its own business account, keys and usually a review before going live. The provider cards in the app show admins which variables to set.

### Free AI allowance

Requests that run on the server's own provider keys count against `AI_FREE_DAILY_REQUESTS` per user per UTC day. `AI_FREE_MODELS` can restrict those keys to low-cost models, for example `anthropic:claude-haiku-5-5`. Users' own keys and the offline demo assistant are never limited. The AI Hub shows how many free requests are left today.

### Installable app & pay links

- `web/public/sw.js` + `manifest.webmanifest` make Aurex installable (Android/desktop install prompt, iOS "Add to Home Screen"). The service worker caches only the app shell and static assets, never API responses.
- `/pay/@handle?amount=12&currency=USD&note=Dinner` is a public page anyone can open. Signed-in visitors pay in one tap. Others sign up or sign in and are returned straight to the payment. **Payments → Your pay link** builds these links with Copy, Share and WhatsApp buttons.

### Security

No system can honestly promise to be unhackable. Aurex is built so that a single failure doesn't lose anyone's money: a stolen password, a stolen session, a leaked database file or a forged webhook each run into another layer.

**Accounts**
- Email verification: 6-digit codes sent through Resend (`RESEND_API_KEY`, `EMAIL_FROM`). In development the code is shown in the app instead. Codes are stored hashed, expire after 15 minutes, allow 5 attempts and can be resent after a minute. A verified email is required for withdrawals, being found or paid by email (so nobody can intercept money by registering someone else's address), admin access and real accounts. Security alerts are also emailed to verified addresses. Without an email provider in production, verification is off and the server warns at startup.
- Passwords: scrypt (N=2¹⁵), at least `PASSWORD_MIN_LENGTH` (12) characters. Common, repetitive and personal passwords are refused, and so are passwords found in known breaches. The breach check uses the Have I Been Pwned range API, so only 5 characters of a SHA-1 hash leave the server.
- Lockout: `LOGIN_MAX_ATTEMPTS` failed passwords or 2FA codes lock the account for `LOGIN_LOCK_MINUTES`. The lock doubles each time, up to 24 hours, and a locked account doesn't even check passwords. Per-IP limits apply on top.
- Two-factor (TOTP): each code is accepted only once (replay protection). Ten one-time **recovery codes** are issued and stored only as hashes. Signing in with one starts a security hold.
- Sessions: random 256-bit tokens, stored only as SHA-256. In production the cookie is `__Host-`, `HttpOnly`, `Secure` and `SameSite=Lax`. Sessions end after `SESSION_IDLE_MINUTES` idle or `SESSION_TTL_HOURS` total. **Settings → Security center** lists every device and can sign any of them out. Changing the password signs out all others.
- Alerts: new-device sign-ins, lockouts, password and 2FA changes, recovery-code use and admin changes appear in the Security center and on the dashboard.
- The first withdrawal to a destination the customer has never used before triggers an alert (and email), so someone who gets into an account can't empty it quietly. Customers are also told when an admin changes their limits, verification level or account status.

**Money**
- **Re-authentication:** withdrawals, sends over `STEP_UP_SEND_USD`, saving AI or brokerage keys, connecting live trading, switching on Autopilot and every admin action need the password (and 2FA) within the last `REAUTH_WINDOW_MINUTES`. The app asks with a "Confirm it's you" prompt and then continues.
- **Security hold:** after a password change, 2FA removal or recovery-code sign-in, withdrawals and large sends pause for `SECURITY_HOLD_HOURS` (24). Someone who just took over an account can't empty it.
- A double-entry ledger, idempotency keys, per-payment and daily limits, and provider-confirmed deposits and payouts (see [Connections](#connections)). Failed payouts are refunded automatically. A reconciler re-checks pending transfers every 5 minutes.

**Admins**
- Admin tools require 2FA (`REQUIRE_ADMIN_2FA`). Admins can't turn 2FA off or freeze their own account.
- In production an `ADMIN_EMAILS` address alone grants nothing, because email addresses aren't verified. The account must also enter `ADMIN_SETUP_CODE` (with 2FA on) under Settings → Admin access. The deploy scripts generate the code and print it once. Every other admin is alerted when someone gains admin access.
- `ADMIN_ALLOWED_IPS` (comma-separated addresses or CIDR ranges) restricts admin tools to your office or VPN. Admin sessions end after `ADMIN_SESSION_IDLE_MINUTES` (30) idle.
- Two people for sensitive money decisions: nobody can approve their own withdrawal, review their own identity check or clear an alert on their own account.
- **Admin → Security checklist** shows what's in place and what still needs doing, worst first: encryption key, admin 2FA and IP allowlist, HTTPS and proxy settings, test money in production, payout review, identity-based limits, safeguarding, ledger balance and the integrity seals. It reports whether settings are set, never their values.

**Platform**
- Headers: strict CSP (`frame-ancestors 'none'`, `object-src 'none'`, no inline scripts), HSTS with preload (2 years), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a locked-down `Permissions-Policy`, and `Cache-Control: no-store` on every API response.
- CSRF protection has two layers. Every state-changing request needs the `X-Aurex-CSRF` header, *and* requests marked `Sec-Fetch-Site: cross-site`, or from an origin other than `APP_URL`/`ALLOWED_ORIGINS`, are refused.
- Secrets (API keys, 2FA secrets, provider tokens) are encrypted with AES-256-GCM under `MASTER_KEY`. To **rotate** it, set the new key and put the old one in `MASTER_KEY_PREVIOUS`; secrets are re-encrypted at startup. SQLite runs with `secure_delete`, and the container writes the database with `umask 077`.
- Webhooks are rate-limited and verified per provider. M-Pesa callbacks can be limited to Safaricom's IPs (`MPESA_CALLBACK_IPS`), and the callback secret is redacted from logs.
- **Tamper evidence:** every journal (with its entries) and every audit event carries a seal, an HMAC over the row and the previous row's seal, keyed from `MASTER_KEY`.
  - Database triggers refuse edits and deletions of journals, entries and the audit log.
  - Someone who gets past them (by editing the database file or dropping the triggers) breaks the chain, and without `MASTER_KEY` they can't recompute it.
  - The chains are checked every 6 hours, on the Admin page and on demand, and a break alerts every admin.
  - Rotating `MASTER_KEY` reseals the chains; a broken chain is never resealed.
  - End-of-day ledger snapshots are recomputed from the entries as a further check.
- All input is validated with Zod, and all SQL is parameterised. AI output is rendered as React elements, never as raw HTML. An audit log covers sign-ins, money movement and key changes.
- Container: the app runs as an unprivileged user with no Linux capabilities, a read-only system disk, `no-new-privileges` and a process limit. The database files are readable only by that user.
- Supply chain: `npm audit` gates CI, CodeQL (`security-extended`) scans every push and weekly, Dependabot keeps npm, Actions and Docker dependencies patched, and [SECURITY.md](SECURITY.md) and `/.well-known/security.txt` explain how to report a vulnerability.

**Recommended on GitHub** (repository settings, not code): turn on secret scanning with push protection and Dependabot alerts, and protect the default branch (require CI and CodeQL to pass).

---

## Going to production

The software is a foundation. Running a real money or brokerage business has requirements that code alone can't meet:

1. **Licensing and partners.** Holding and transmitting customer funds generally needs a money transmitter / e-money / payment institution licence in each jurisdiction, or a regulated partner (a banking-as-a-service provider, or a payments platform with marketplace features such as Stripe Connect). Brokerage likewise needs a broker-dealer or a partner (for example Alpaca's Broker API for multi-user brokerage). Users here trade only their *own* Alpaca accounts.
2. **Safeguarding.** Open a designated safeguarding account with your bank for each currency you hold. Register it under Safeguarding, and record its balance every day (or fetch it by API) so reconciliation can prove customers' money is all there. Payout review and transaction monitoring are on by default; tune `PAYOUT_REVIEW_USD` and `MONITOR_LARGE_USD` to your risk appetite and your regulator's expectations.
3. **KYC/AML.** Aurex collects identity details and documents and ties limits to the verification level (see [Accounts](#accounts-and-identity-verification)), but a person on your team reviews them. For real customers, add a verification provider (Persona, Onfido, Sumsub, …) for document and liveness checks and sanctions screening, consider a dedicated monitoring service as volumes grow, and keep records for as long as your regulator requires.
4. **Disable the sandbox rail.** Set `PAYMENT_RAILS=stripe` or your licensed rails. The server warns at startup if `sandbox` is enabled in production.
5. **Secrets.** Set a strong `MASTER_KEY` (`openssl rand -hex 32`) and keep it safe. Losing it makes stored user keys unreadable; rotating it requires re-encryption.
6. **HTTPS.** Run behind a TLS-terminating proxy with `TRUST_PROXY=true` and `APP_URL=https://…`.
7. **Scale-out.** SQLite in WAL mode handles a single instance well. For several replicas, move to Postgres (the SQL is portable) and put the rate limiter on a shared store such as Redis.
8. **Backups.** Back up the database file continuously (for example with Litestream) and test restores.
9. **Disclosures.** AI trading signals are decision aids, not financial advice. Keep the in-app disclaimers and add your own terms.

### Website on GitHub Pages

The public website (Home, Features, Pricing, Security, About) also builds as a static site:

```bash
npm run build:site
```

`.github/workflows/pages.yml` publishes it to `https://<owner>.github.io/<repo>/` on every push. One-time setup: **Settings → Pages → Source: GitHub Actions**. Set the repository variable `AUREX_APP_URL` to the live app's URL so the sign-up buttons point at it; until then they read "Launching soon". GitHub Pages can't run the app itself (accounts, payments, AI, trading), which needs a server such as Railway.

### AWS (EC2, one CloudFormation stack)

See **[deploy/aws/README.md](deploy/aws/README.md)**. It sets up one EC2 server with Caddy (automatic HTTPS) and Litestream (continuous backups to S3), keeps secrets in Parameter Store, and gives you a browser terminal through Session Manager. It costs about $18/month. The installer (`deploy/server/install.sh`) also works on Lightsail or any Ubuntu server.

### Render (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/pizzatechies/P2P)

The button reads `render.yaml`: a Docker web service on the Starter plan in Frankfurt with a 1 GB disk at `/data`. It generates `MASTER_KEY` and `ADMIN_SETUP_CODE`, and asks only for `ADMIN_EMAILS`. `APP_URL` defaults to the service's own address.

Or from the command line with an API key:

```bash
RENDER_API_KEY=<api key> ADMIN_EMAILS=you@example.com ./scripts/deploy-render.sh
```

The script creates (or reuses) a Docker web service from this public repository on the Starter plan in Frankfurt. It attaches a 1 GB persistent disk at `/data`, sets the production variables (generating `MASTER_KEY`), waits for the build and checks `/api/health`. It's safe to re-run: on later runs it deploys the latest commit. You can also use **New → Blueprint** in the Render dashboard with `render.yaml`. A persistent disk needs a paid instance type, because free instances lose data and sleep (which would also stop the autopilot).

### Railway (one command)

```bash
npm i -g @railway/cli
```

```bash
RAILWAY_API_TOKEN=<account token> ADMIN_EMAILS=you@example.com ./scripts/deploy-railway.sh
```

The script is safe to re-run. It creates (or reuses) the project and service, attaches a persistent volume at `/data` for the database, creates a public domain, sets the production variables (generating `MASTER_KEY` once), uploads the code, waits for the build and checks `/api/health`. Any optional setting from `.env.example` that's in your shell (for example `ANTHROPIC_API_KEY`) is copied to the service. Use an **account** token from railway.com/account/tokens with no workspace selected.

### Docker

```bash
cp .env.example .env
```

Edit `.env` (at least `MASTER_KEY` and `APP_URL`), then:

```bash
docker compose up --build -d
```

The app serves on port 4000, and data lives in the `aurex-data` volume.

---

## API overview

All endpoints are under `/api` and use JSON bodies. Mutations need the header `X-Aurex-CSRF: 1`. Errors look like `{ "error": { "code", "message" } }`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Wallet | `GET /payments/balances`, `GET /payments/activity`, `GET /payments/transfers`, `POST /payments/deposits`, `POST /payments/withdrawals` |
| P2P | `POST /payments/send`, `GET/POST /payments/requests`, `POST /payments/requests/:id/{pay,decline,cancel}`, `GET /payments/users/search` |
| FX | `GET /payments/fx/quote`, `POST /payments/convert` |
| AI | `GET /ai/providers`, `GET /ai/providers/:id/models`, `POST /ai/chat` (SSE), `POST /ai/compare` (SSE), `GET/DELETE /ai/conversations/:id` |
| Trading | `GET /trading/account`, `GET /trading/quote/:symbol`, `GET /trading/bars/:symbol`, `GET/POST/DELETE /trading/watchlist`, `GET/POST /trading/orders`, `POST /trading/orders/:id/cancel`, `POST /trading/analyze`, `GET /trading/signals`, `POST /trading/signals/:id/execute`, `GET /trading/records/{trades,realized,performance,cash}` (`?format=csv` on trades and realized) |
| Settings | `PATCH /settings/profile`, `POST /settings/password`, `POST /settings/2fa/{setup,confirm,disable}`, `GET/PUT/DELETE /settings/api-keys/:provider`, `PUT/DELETE /trading/alpaca-keys`, `PUT /trading/broker` |
| Account | `GET /account`, `GET /account/verification`, `PUT /account/verification/:level`, `POST /account/documents/:kind` (raw file body), `GET /account/documents/:id`, `POST /account/verification/:level/submit`, `GET /account/statements`, `GET /account/statements/:period?currency=&format=csv`, `GET /account/activity?from=&to=&currency=`, `GET /account/export`, `POST /account/close` |
| Admin | `GET /admin/overview`, `GET /admin/users?q=`, `GET /admin/users/:id`, `POST /admin/users/:id/{status,limits,notes,kyc-level}`, `GET /admin/kyc`, `POST /admin/kyc/:id/review`, `GET /admin/kyc/documents/:id`, `GET /admin/ledger/{journals,journals/:id,trial-balance,snapshots,export}`, `GET /admin/trading`, `GET /admin/payouts`, `POST /admin/payouts/:id/{approve,reject}`, `GET /admin/compliance`, `POST /admin/compliance/:id`, `GET /admin/safeguarding`, `POST /admin/safeguarding/{accounts,refresh,reconcile,sweep}`, `PATCH /admin/safeguarding/accounts/:id`, `GET/POST /admin/safeguarding/accounts/:id/balances`, `GET /admin/safeguarding/accounts/:id/details` |
| Connections | `GET /connections/providers`, `GET /connections`, `POST /connections/:provider/start`, `POST /connections/links/:id/complete`, `POST /connections/:id/sync`, `DELETE /connections/:id`, `GET /connections/oauth/:provider/callback` |
| Payouts | `POST /payments/payout-requirements`, `POST /payments/transfers/:id/refresh` |
| Academy & upgrade | `GET /learn`, `POST /learn/lessons/:id/quiz`, `POST /trading/account/reset`, `GET/PUT /trading/upgrade`, `POST /trading/upgrade/submit`, `GET /admin/upgrades`, `POST /admin/upgrades/:userId/review` |
| Security | `POST /auth/reauth`, `POST /auth/email/send`, `POST /auth/email/verify`, `GET /settings/security`, `POST /settings/security/alerts/read`, `DELETE /settings/sessions/:id`, `POST /settings/sessions/revoke-others`, `POST /settings/2fa/recovery-codes`, `POST /settings/admin/claim` |
| Webhooks | `POST /webhooks/stripe`, `/flutterwave`, `/plaid`, `/mono`, `/paypal`, `/skrill`, `/mtn-momo` (PUT or POST), `/mpesa/<secret>/stk`, `/mpesa/<secret>/b2c/result`, `/mpesa/<secret>/b2c/timeout` |

## Tests

```bash
npm test
```

The suite covers money parsing and formatting, password hashing, encryption, TOTP (RFC 6238 vectors), and ledger invariants after every scenario. It also covers transfers, idempotent retries, fees, payment requests (including double-pay protection), FX, withdrawals with failed-payout reversal, limits, and Stripe webhook signatures with replay. On the AI side: provider resolution, SSE streaming, and key secrecy. On trading: paper buy/sell, limit orders, and AI signal guardrails. Connections and payment rails are tested against stub servers that answer like the Plaid, Salt Edge, SnapTrade, Coinbase, Flutterwave, Daraja (M-Pesa), MTN MoMo, PayPal, Wise, Skrill and MoneyGram APIs. An integrity suite covers the seals (refused edits, tampering with the triggers removed, a slipped-in row, sealing older data, resealing after key rotation), and a hardening suite covers the admin IP allowlist, admin idle timeout, new-admin and admin-change alerts, new-destination alerts and the security checklist. An accounts suite covers account numbers and their check digit, paying by account number, the identity levels and their limits, document checks, admin review (including no self-review), custom limits, statements and CSV formula neutralising, the data export (no secrets) and closing and reopening an account. A money suite covers payout review (holding, approving, returning, no self-review), the monitoring rules and their review (including that customers never see alerts), safeguarding reconciliation (shortfall, covered, stale statements, immutable records), fetching provider balances, and sweeping fee income with the books still balanced. A records suite covers trade records and realised profit and loss (average cost, futures flips), the demo cash journal adding up to the cash, immutability, reports and CSVs, performance from the last reset, backfilling older orders, Alpaca executions recorded once, the journal explorer, the trial balance, end-of-day snapshots catching a changed figure, and the audited ledger export. Further suites cover email verification (including Resend delivery and alert emails), the academy (server-side grading, missions), demo resets and the real-account upgrade (checklist, encryption, warnings, admin review, live-key enforcement). A security suite covers password rules and the breach check, lockouts, 2FA replay and recovery codes, re-authentication, security holds, sessions and idle timeout, admin 2FA and the setup code, headers, Origin checks, the `__Host-` cookie and `MASTER_KEY` rotation. They cover link and OAuth flows (state checks, refresh-token rotation), cross-user isolation, forged and early webhooks, underpaid deposits, and failed-payout refunds.
