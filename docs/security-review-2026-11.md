# Security review, November 2026

An internal code review of the whole Aurex codebase before going live with real money. It is not a substitute for an independent penetration test (see "Still to do" below).

## Scope and method

Every API route and the service code behind it was read, looking for:

- **Access control:** each route's sign-in, admin and recent-password checks, and whether a customer can reach another customer's records by changing an id.
- **Money:** amounts and rounding, overdrafts, limits, idempotency, races between simultaneous requests, and the ledger's balance checks.
- **Inputs:** SQL built from user input, uploaded files, URLs, CSV exports and anything shown back in the web app.
- **Webhooks:** how each provider's callback is verified, and what a forged or replayed one could do.
- **Sign-in and accounts:** sessions, 2FA, lockouts, step-up checks and account recovery.
- **Dependencies:** `npm audit` reported 0 known vulnerabilities.

## What held up

- **Customer records:** every customer route is scoped to the signed-in user, including orders, documents, connections, requests, transfers and sessions.
- **Admin tools:** admins need 2FA, and money, limit, KYC and status changes need a recent password check. Nobody can review their own payout, KYC, business application or compliance alert.
- **Ledger:**
  - Every journal balances, with integer amounts only.
  - Customer balances can't go negative, because the check is made in the same SQL statement as the update.
  - Journals and the audit log are sealed in a hash chain.
- **SQL:** all user values are bound parameters. The few interpolated pieces are fixed column lists or clamped numbers.
- **Uploads:** KYC files are identified by their content (magic bytes), not by name. They're encrypted at rest and served with a sandboxing CSP, `nosniff` and an attachment disposition for PDFs.
- **Webhooks:**
  - Stripe, Skrill, Flutterwave and Mono are signature- or secret-checked.
  - M-Pesa callbacks are only accepted at a secret URL, optionally from Safaricom's IP addresses.
  - Unsigned callbacks (MTN MoMo, PayPal, Plaid) only trigger a re-check through the provider's own API.
- **Web app:**
  - No `innerHTML`. AI replies are rendered as React elements, with http(s) links only.
  - Redirect targets are checked to stay in Aurex.
  - The CSP blocks inline scripts.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | **Daily limits could be exceeded with simultaneous payments.** The 24-hour limit was checked before the payment was recorded, and the check waits on exchange rates, so several payments sent at the same moment all passed. In a test, 6 payments of $150 went through against a $500 limit. | A customer's outgoing payments (sends, request payments and withdrawals) are now processed one at a time. The same test now lets exactly 3 through. |
| 2 | Medium | **Smile ID results weren't tied to the check Aurex started.** Smile ID signs only the timestamp, not the body, so a captured signature could be replayed with an edited result within 24 hours. That could mark someone else's ID as confirmed, or overwrite a result. | Aurex now sends a keyed check value that Smile ID echoes back, and a result counts only when it matches. The job id must match, and a result is recorded only once, while the check is pending. |
| 3 | Medium | **No way to recover a forgotten password.** Customers locked out would need staff to reset accounts by hand, which is the classic social-engineering route into an account. | A self-service reset by email:<ul><li>The link is single-use and expires after 30 minutes. Only its hash is stored, and the server sends it in a request body, never in a URL it logs.</li><li>It goes to confirmed addresses only. The form gives the same answer whether or not an account exists, and takes the same time.</li><li>With 2FA on, the authenticator or a recovery code is required too.</li><li>A reset signs out every device and pauses withdrawals.</li></ul> |
| 4 | Low | **Business websites accepted `javascript:` and `data:` links,** which were then shown as links in the admin queue. The CSP would have blocked the script, but it shouldn't rely on that. | Only `http(s)` addresses are accepted, and the admin page links only `http(s)` values. |
| 5 | Low | **An admin could give themselves free Aurex Pro.** | Another admin must do it. |
| 6 | Low | **CSV exports turned negative amounts into text** (`'-100.00`): the formula-injection guard also caught plain numbers, which broke statements and accounting imports. | Plain numbers stay numbers. Real formulas are still neutralised. |
| 7 | Low | **A withdrawal that reused another payment's idempotency key failed with a server error.** | It now gets a clear `idempotency_conflict` response. |
| 8 | Info | **The data download was incomplete.** It now includes the business profile, the Pro plan, trade fills and Autopilot history. | (Data-protection completeness.) |
| 9 | Info | **The merchant fee wasn't listed** with the other fees in `/api/meta`. | Added. |

Each fix has a regression test, in `server/test/review.test.ts`, `password-reset.test.ts` and `smileid.test.ts`.

## Accepted by design

- **Handle and email existence.** A pay link has to show whether a handle exists, and sign-up says when an email is already registered. Both are rate limited.
- **Single server process.**
  - The payment queue in finding 1 works within one process, which matches the SQLite design.
  - Before running several replicas, move it to a database-level check, such as Postgres row locks on the customer's account.

## Still to do (needs people, money or accounts)

1. **An independent penetration test** of the live system, by a firm the regulator or bank partner will accept, before taking real deposits.
2. **Bot protection** on sign-up, sign-in and password reset, for example Cloudflare Turnstile.
3. **The encryption key in a managed key service.** Today `MASTER_KEY` is in Parameter Store; AWS KMS would also give envelope encryption and key-use logs.
4. **Two-person approval** for the highest-impact admin actions (raising limits, setting KYC levels by hand), not just a second factor.
5. **A public bug bounty or disclosure programme** once live. `SECURITY.md` and `/.well-known/security.txt` already give the contact route.
6. **Repeat this review** after major features, and at least yearly.
