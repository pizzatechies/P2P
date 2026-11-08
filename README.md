# P2P Hub

Peer-to-peer payments, a multi-provider AI hub and AI-assisted stock trading in one web app.

| | |
|---|---|
| **Payments** | Multi-currency wallets (19 currencies), send by @handle or email, request money, currency conversion, deposits and withdrawals through pluggable payment rails, all on a double-entry ledger |
| **AI Hub** | Chat with Claude, GPT, Gemini, Mistral, Llama (Groq/Together), Grok, DeepSeek, OpenRouter's catalogue, Perplexity and self-hosted Ollama models. Responses stream live, conversations are saved, a compare mode runs up to 4 models side by side, and users can bring their own encrypted keys |
| **Trading** | Paper trading with $100k virtual cash, or each user's own Alpaca account. Charts and indicators, plus an AI analyst that returns buy/sell/hold signals with position size, stop-loss and take-profit. Execution is one click, but the user must confirm and position caps apply |

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

Create two accounts in two browser windows, add sandbox money and send it back and forth. To make yourself an admin, set `ADMIN_EMAILS=you@example.com` before registering.

### Configuration

Copy `.env.example` to `server/.env` and fill in what you need. The server loads it automatically. Common setups:

| Goal | Set |
|---|---|
| Claude in the AI Hub and as the trading analyst | `ANTHROPIC_API_KEY` |
| Any other AI provider for every user | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, … |
| Real market data | `ALPACA_DATA_KEY_ID`, `ALPACA_DATA_SECRET_KEY` (a free Alpaca account works) |
| Card deposits | `PAYMENT_RAILS=sandbox,stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
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
- Per-transaction and rolling 24h limits are applied in USD-equivalent.
- `GET /api/admin/overview` (and the Admin page) runs a full integrity check: journals balance, cached balances match entries, and system totals net to zero.

System accounts: `external` (the outside world), `clearing` (withdrawals in flight), `fees`, `fx`.

**Payment rails** are how money enters and leaves the platform (`server/src/services/rails`):

| Rail | Deposits | Withdrawals | Notes |
|---|---|---|---|
| `sandbox` | instant | instant | Test money. Account numbers ending in `0000` fail, to demo reversals |
| `stripe` | Stripe Checkout | – | Wallet credited only from the signed `checkout.session.completed` webhook. Point Stripe at `POST /api/webhooks/stripe` |

To add bank transfers, mobile money (M-Pesa, MTN, Airtel via an aggregator such as Flutterwave or Paystack), or card payouts, implement the `PaymentRail` interface in `rails/types.ts` and register it in `rails/index.ts`. The ledger and UI don't change.

### AI Hub

- **Anthropic** uses the official `@anthropic-ai/sdk`. Default model: `claude-opus-5-5`. Server-side refusal fallback (`fallbacks: "default"`) is enabled on models that support it, so a safety-classifier decline is retried on Anthropic's recommended fallback model instead of failing.
- **OpenAI-compatible providers** share one adapter (`ai/openaiCompat.ts`). Adding a provider is usually one entry in `ai/providers.ts`.
- **Model discovery:** each provider's catalogue loads live from its `/models` endpoint when a key is present. Users can also type any model id.
- **Credentials:** the user's own key is used first, then the server-wide key from the environment.
- Replies stream to the browser over **Server-Sent Events**. Closing the tab aborts the upstream request.
- The offline **demo** provider keeps everything usable without keys.

### Trading

- **Market data:** Alpaca (real, IEX feed) when the user or server has Alpaca keys. Otherwise a deterministic simulated market of 20 well-known tickers, clearly labelled as synthetic.
- **Brokers:** the built-in paper broker (market and limit orders, long-only, instant fills) or the user's **own** Alpaca account through their own keys. Paper is the default. Live Alpaca accounts are refused unless the operator sets `ALLOW_LIVE_TRADING=true`.
- **AI analyst:** computes SMA 20/50/200, RSI, MACD, ATR, volatility, returns and the 52-week range, then asks the selected model for a structured signal. Claude responses use structured outputs, which are schema-guaranteed; other providers use JSON mode plus validation. With no AI connected, a transparent rule-based model is used.
- **Guardrails** are enforced on the server:
  - Every AI-originated order needs explicit confirmation.
  - Each signal can be executed only once.
  - AI buys are capped at `AI_MAX_POSITION_PCT` of portfolio equity (default 10%).
  - "Sell" without a position is downgraded to "hold", because the account is long-only.

### Security

- Passwords use scrypt (N=2¹⁵) and are compared in constant time. Login takes the same time whether or not the user exists.
- Sessions use random 256-bit tokens in `HttpOnly`, `SameSite=Lax` cookies (`Secure` in production). Only a SHA-256 of the token is stored, so sessions can be revoked.
- Optional **TOTP two-factor** login works with any authenticator app.
- **CSRF:** every state-changing request must carry a custom `X-P2P-CSRF` header, which other origins can't send.
- Third-party API keys and 2FA secrets are encrypted at rest with AES-256-GCM, using a key derived from `MASTER_KEY`.
- Helmet security headers include a strict Content-Security-Policy.
- Rate limits apply per IP (auth, API) and per user (money movement, AI, orders).
- All input is validated with Zod and all SQL is parameterised. AI Markdown is rendered as React elements, never as raw HTML.
- An audit log covers logins, money movement, key changes and orders. Users can see their own events under Settings.

---

## Going to production

The software is a foundation. Running a real money or brokerage business has requirements that code alone can't meet:

1. **Licensing and partners.** Holding and transmitting customer funds generally needs a money transmitter / e-money / payment institution licence in each jurisdiction, or a regulated partner (a banking-as-a-service provider, or a payments platform with marketplace features such as Stripe Connect). Brokerage likewise needs a broker-dealer or a partner (for example Alpaca's Broker API for multi-user brokerage). Users here trade only their *own* Alpaca accounts.
2. **KYC/AML.** Add identity verification (Persona, Onfido, Sumsub, …), sanctions screening and transaction monitoring. The schema has a `kyc_level` column; tie limits to it.
3. **Disable the sandbox rail.** Set `PAYMENT_RAILS=stripe` or your licensed rails. The server warns at startup if `sandbox` is enabled in production.
4. **Secrets.** Set a strong `MASTER_KEY` (`openssl rand -hex 32`) and keep it safe. Losing it makes stored user keys unreadable; rotating it requires re-encryption.
5. **HTTPS.** Run behind a TLS-terminating proxy with `TRUST_PROXY=true` and `APP_URL=https://…`.
6. **Scale-out.** SQLite in WAL mode handles a single instance well. For several replicas, move to Postgres (the SQL is portable) and put the rate limiter on a shared store such as Redis.
7. **Backups.** Back up the database file continuously (for example with Litestream) and test restores.
8. **Disclosures.** AI trading signals are decision aids, not financial advice. Keep the in-app disclaimers and add your own terms.

### Docker

```bash
cp .env.example .env
```

Edit `.env` (at least `MASTER_KEY` and `APP_URL`), then:

```bash
docker compose up --build -d
```

The app serves on port 4000, and data lives in the `p2p-data` volume.

---

## API overview

All endpoints are under `/api` and use JSON bodies. Mutations need the header `X-P2P-CSRF: 1`. Errors look like `{ "error": { "code", "message" } }`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Wallet | `GET /payments/balances`, `GET /payments/activity`, `GET /payments/transfers`, `POST /payments/deposits`, `POST /payments/withdrawals` |
| P2P | `POST /payments/send`, `GET/POST /payments/requests`, `POST /payments/requests/:id/{pay,decline,cancel}`, `GET /payments/users/search` |
| FX | `GET /payments/fx/quote`, `POST /payments/convert` |
| AI | `GET /ai/providers`, `GET /ai/providers/:id/models`, `POST /ai/chat` (SSE), `POST /ai/compare` (SSE), `GET/DELETE /ai/conversations/:id` |
| Trading | `GET /trading/account`, `GET /trading/quote/:symbol`, `GET /trading/bars/:symbol`, `GET/POST/DELETE /trading/watchlist`, `GET/POST /trading/orders`, `POST /trading/orders/:id/cancel`, `POST /trading/analyze`, `GET /trading/signals`, `POST /trading/signals/:id/execute` |
| Settings | `PATCH /settings/profile`, `POST /settings/password`, `POST /settings/2fa/{setup,confirm,disable}`, `GET/PUT/DELETE /settings/api-keys/:provider`, `PUT/DELETE /trading/alpaca-keys`, `PUT /trading/broker` |
| Admin | `GET /admin/overview`, `GET /admin/users`, `POST /admin/users/:id/status` |
| Webhooks | `POST /webhooks/stripe` |

## Tests

```bash
npm test
```

The suite covers money parsing and formatting, password hashing, encryption, TOTP (RFC 6238 vectors), and ledger invariants after every scenario. It also covers transfers, idempotent retries, fees, payment requests (including double-pay protection), FX, withdrawals with failed-payout reversal, limits, and Stripe webhook signatures with replay. On the AI side: provider resolution, SSE streaming, and key secrecy. On trading: paper buy/sell, limit orders, and AI signal guardrails.
