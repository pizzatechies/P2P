# Security policy

## Reporting a vulnerability

Please report security issues privately, never in a public issue:

- **GitHub:** [open a private security advisory](https://github.com/pizzatechies/P2P/security/advisories/new)
- Or use the contact in `/.well-known/security.txt` on the running app.

Include what you found, how to reproduce it and what an attacker could do with it. We aim to acknowledge reports within 3 working days and to fix confirmed issues as fast as their severity calls for. Please give us reasonable time to fix an issue before disclosing it, and don't access other people's data, move real money or degrade the service while testing.

## Supported versions

Only the latest commit on the default branch receives security fixes.

## What's in place

See the README's **Security** section for the full list. In short:

- Accounts: scrypt password hashing; minimum length plus common- and breached-password checks; per-account lockout with escalating lock times; TOTP two-factor sign-in with replay protection and one-time recovery codes; idle and absolute session timeouts; device list with remote sign-out; new-device and security-change alerts.
- Money: re-authentication before withdrawals and large sends; a 24-hour hold on outgoing money after a password change, 2FA removal or recovery-code sign-in; a double-entry ledger; provider-confirmed deposits and payouts; automatic refunds of failed payouts.
- Admin: requires 2FA and a fresh re-check for every admin action. In production, admin rights are granted only with a setup code, never from an email address alone.
- Platform: strict CSP, HSTS preload, `__Host-` session cookie, Origin/Sec-Fetch-Site checks plus a CSRF header, no-store API caching, rate limits, AES-256-GCM secrets with key rotation, CodeQL, Dependabot and `npm audit` in CI.
