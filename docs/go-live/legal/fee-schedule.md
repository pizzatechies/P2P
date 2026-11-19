# Aurex Fee Schedule

> **DRAFT — not in force.** The amounts below are the software's settings. Set your real prices in `/opt/aurex/src/deploy/server/.env` (setting names in brackets), keep this page in step with them, and publish it in the app and on the website.

**Effective date:** [EFFECTIVE DATE]

| Service | Fee | Setting |
|---|---|---|
| Opening and keeping an account | Free | |
| Sending money to another Aurex customer | **Free** [or [x]% of the amount, paid by the sender] | `P2P_FEE_BPS` (0) |
| Receiving money (personal account) | Free | |
| Receiving money (approved business account) | **[1.5]%** of each payment received, kept from the amount; the payer pays nothing extra | `MERCHANT_FEE_BPS` (0 until set) |
| Converting between currencies | **[0.5]%** spread on the mid-market rate; the exact rate and amount are shown before you confirm | `FX_SPREAD_BPS` (50) |
| Depositing money | Free from Aurex. Your provider (mobile money, card issuer, bank) may charge its own fee. | |
| Withdrawing money | **[Free / [x]%]** of the amount, shown before you confirm. The receiving provider may charge its own fee. | `WITHDRAWAL_FEE_BPS` (0) |
| Aurex Pro (optional) | **[US$4.99]** per 30 days, paid from your wallet in any currency you hold, at the mid-market rate | `PRO_PRICE`, `PRO_CURRENCY` |
| AI assistant | [25] requests a day free; more with Aurex Pro [200 a day] or your own AI provider key | `AI_FREE_DAILY_REQUESTS`, `PRO_AI_DAILY_REQUESTS` |
| Demo trading, statements, data download, academy | Free | |
| Real trading | No Aurex fee. [BROKER]'s own fees and regulatory fees apply. | |

## Limits

These limits are in US dollars or the equivalent in your currency.

| Verification level | Per payment | Per 24 hours |
|---|---|---|
| Level 0 (email confirmed) | [200] | [500] |
| Level 1 (identity verified) | [2,000] | [5,000] |
| Level 2 (address and source of funds) | [10,000] | [25,000] |

Settings: `TIER0_*`, `TIER1_*`, `MAX_TX_USD`, `DAILY_LIMIT_USD`.

- Withdrawals of [US$1,000] or more (`PAYOUT_REVIEW_USD`) may wait for a review before they're sent.

## Changes

- **Notice:** we'll give you at least [30] days' notice before raising a fee.
- **Applies from:** a fee change applies only to payments made after it takes effect.
