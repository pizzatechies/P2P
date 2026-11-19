# Aurex server runbook

How to run Aurex day to day and what to do when something goes wrong. It assumes the AWS setup in [`deploy/aws`](../../deploy/aws/README.md):

- one EC2 server;
- Caddy for HTTPS;
- the app;
- Litestream streaming the SQLite database to S3;
- secrets in Parameter Store.

All commands run on the server through **Session Manager** (AWS console → EC2 → Connect → Session Manager), from `/opt/aurex/src/deploy/server` unless stated otherwise:

```bash
cd /opt/aurex/src/deploy/server
```

## 1. Daily checks (5 minutes)

1. **Admin → Overview:** everything here should be green.
   - Ledger "balanced".
   - Integrity chains "ok".
   - Safeguarding "covered", with no stale statements.
   - No unexpected open alerts or pending payouts.
2. **Admin → Payouts and Admin → Compliance:** clear the queues. Withdrawals wait while alerts are open.
3. **Admin → Ledger → Safeguarding:**
   - Record the day's bank and provider balances, or press "Refresh provider balances".
   - Reconcile.
   - A shortfall is an incident (section 6.4).
4. **Admin → Sanctions:** lists refreshed within the last 24 hours.
5. **Admin → Security checklist:** nothing newly failing.

## 2. Monitoring and alerting

| What | How | Set up? |
|---|---|---|
| Host failure | CloudWatch alarm recovers the instance automatically | Yes (CloudFormation) |
| Site up | External uptime check on `https://<domain>/api/health` every minute, alerting by SMS and email: UptimeRobot, Better Stack, or a Route 53 health check with an SNS alarm | **To do** |
| Disk space | CloudWatch agent disk metric with an alarm at 80% | **To do** |
| Backups flowing | Daily check that the newest object under `s3://<bucket>/aurex/` is less than 1 hour old: an S3 inventory or a small Lambda with an alarm | **To do** |
| Errors | `docker compose logs app` shows `[error]` lines. Ship logs to CloudWatch Logs (the awslogs driver) with a metric filter on `[error]` and `[integrity]` | **To do** |
| Cost | AWS Budget alert | Set in the setup guide |

Check health by hand:

```bash
curl -fsS https://<domain>/api/health
```

```bash
sudo docker compose --env-file .env ps
```

```bash
sudo docker compose --env-file .env logs --since 1h app | grep -E "\[error\]|\[integrity\]|\[security\]"
```

## 3. Deploying updates

```bash
cd /opt/aurex/src && sudo git pull && sudo ./deploy/server/install.sh
```

How it behaves:

- **Downtime:** about 5–10 seconds while the container restarts.
- **Migrations:** they run automatically at start-up and only ever move forward.
- **Before a release that adds a migration:** note the time, so you can restore to just before it if needed (section 5).
- **Settings:** add or change them in `/opt/aurex/src/deploy/server/.env`, or in Parameter Store for secrets, then re-run `install.sh`. Hand-added lines in `.env` are kept.

**Rolling back.** Check out the previous version and reinstall:

```bash
cd /opt/aurex/src && sudo git log --oneline -5
```

```bash
sudo git checkout <previous-commit> && sudo ./deploy/server/install.sh
```

If the release you're undoing added a migration, the older code may not understand the newer database. In that case also restore the database to just before the deploy (section 5); payments made since then would be lost. Prefer a fix-forward.

Return to the latest version afterwards:

```bash
cd /opt/aurex/src && sudo git checkout claude/gifted-ritchie-8xzdk9 && sudo git pull
```

## 4. Backups

- **Continuous:** Litestream uploads changes every 10 seconds, with a daily snapshot and 30 days of point-in-time history. The bucket is versioned and kept even if the stack is deleted.
- **Encryption keys:** `MASTER_KEY` is in Parameter Store (`/aurex/<stack>/MASTER_KEY`) and in `.env`. **A backup is useless without it**, so keep an offline copy in a safe or password manager with two named people.
- **Restore drill:** do one **monthly** (put it in the calendar):
  1. Launch a temporary server from the CloudFormation template, with a different stack name but the same `BACKUP_BUCKET` and `PARAM_PREFIX`. It restores the latest backup automatically.
  2. Sign in as admin and check that Admin → Overview shows the ledger balanced and integrity "ok". Spot-check a recent payment.
  3. Write down how long it took (your measured recovery time) and how old the newest data was (your recovery point; expect seconds).
  4. Delete the temporary stack.

## 5. Restoring

- **Whole server lost:** create the stack again, or run `install.sh` on a new server, with the same `BACKUP_BUCKET` and `PARAM_PREFIX`. It restores automatically before starting.
- **Undo a mistake (point in time):** follow "Point-in-time restore" in [`deploy/aws/README.md`](../../deploy/aws/README.md#backups-and-restoring).
- **After any restore:**
  - Reconcile safeguarding.
  - Check providers for payments that completed after the restore point, such as deposits confirmed by webhook or payouts sent. Match them using Admin → Ledger and each provider's dashboard.
  - Apply missing ones by hand with journals, and record why.

## 6. Incidents

Every incident needs four things:

- a lead person;
- a timeline, kept in a shared document;
- a customer message, if customers are affected;
- a short review afterwards.

Some incidents must be reported to regulators or data protection authorities within fixed deadlines. Know the deadlines for your country, for example 72 hours for many personal-data breaches.

### 6.1 Site down

1. Check the health URL and `docker compose ps`.
2. Restart:

   ```bash
   sudo docker compose --env-file .env up -d
   ```

3. Read the last errors:

   ```bash
   sudo docker compose --env-file .env logs --tail 200 app
   ```

4. Check disk space with `df -h` and AWS status.
5. If a deploy caused it, roll back (section 3).

### 6.2 Customer account taken over

1. Admin → user → **Freeze** (signs out all sessions).
2. Check the activity log, devices and recent payouts, and stop any waiting payouts (Admin → Payouts → **Return money**).
3. Help the customer recover:
   - verify them through a channel you already know, never only the one the attacker might control;
   - after a password reset, withdrawals pause automatically.
4. Report to the payment providers involved if money left.

### 6.3 Ledger or audit chain "broken"

Treat it as possible tampering.

1. Don't fix anything yet. Save a copy of the database as evidence (from the latest backup):

   ```bash
   sudo docker compose --env-file .env --profile backup run --rm --no-deps litestream restore -o /data/evidence.db /data/aurex.db
   ```

2. Admin → Overview → **Ledger integrity** shows where a seal is broken. Compare with a point-in-time restore from before that moment (section 5).
3. Rotate admin credentials. Review AWS CloudTrail for console or Session Manager access.
4. Escalate to the MLRO and directors.

### 6.4 Safeguarding shortfall

The customer money held at banks or providers is less than customer balances in the ledger.

1. Recheck the balances you entered and their dates.
2. Look for unrecorded movements, such as provider fees and chargebacks.
3. If it's real:
   - pause withdrawals (set `PAYOUT_REVIEW_USD=1` so every payout waits);
   - top up from company funds;
   - tell the board, and the regulator if the licence requires.

### 6.5 Payment provider outage

1. Remove the rail from `PAYMENT_RAILS` in `.env`, then run `install.sh`. Customers will see the other rails.
2. Pending transfers keep being re-checked automatically. Look at Admin → Payouts once the provider is back.

### 6.6 Secret or key exposed

| Secret | Action |
|---|---|
| Provider API key | Revoke it in the provider's dashboard, put the new key in Parameter Store, run `install.sh`. |
| `MASTER_KEY` | Generate a new one. Put the **old** value in `MASTER_KEY_PREVIOUS` and the new one in `MASTER_KEY` (Parameter Store and `.env`), then run `install.sh`. Secrets are re-encrypted at start-up; the log says how many. Remove `MASTER_KEY_PREVIOUS` after confirming. |
| `ADMIN_SETUP_CODE` | Change it in Parameter Store and run `install.sh`. Review the admin list. |
| AWS access | Rotate IAM credentials. Review CloudTrail. |

### 6.7 Personal-data breach

1. Contain it.
2. Assess what data and whom it affects.
3. Inform the DPO.
4. Notify the data protection authority and the affected customers within the legal deadline.
5. Keep a record, even if you decide notification isn't needed.

## 7. Going from sandbox to real money

Do these in order. Each step is a settings change in `.env` followed by `install.sh`.

1. **Email:** set `RESEND_API_KEY` and `EMAIL_FROM` (verified domain). Then email verification is enforced and password reset works.
2. **Identity:**
   - `SMILEID_PARTNER_ID`, `SMILEID_API_KEY` and `SMILEID_ENV=production`;
   - set the callback URL in the Smile ID portal;
   - keep `KYC_AUTO_APPROVE=false`.
3. **Beta gate:** `REGISTRATION_MODE=invite` and `MAX_USERS=<n>`.
4. **Real trading:** keep `ALLOW_LIVE_TRADING=false` until the securities question is settled (see the market research). `LIVE_COUNTRIES` then limits where real trading accounts can be opened.
5. **One payment rail first**, for example M-Pesa (`MPESA_*`, plus `MPESA_CALLBACK_IPS` with Safaricom's addresses) or Flutterwave.
   - Set `PAYMENT_RAILS=mpesa` (no `sandbox`).
   - Test with small amounts between staff accounts.
   - Reconcile the same day.
6. **Safeguarding:** register the trust or safeguarding accounts in Admin → Ledger → Safeguarding, and reconcile daily.
7. **Fees:** set `MERCHANT_FEE_BPS`, `FX_SPREAD_BPS` and the others, then publish the matching [Fee Schedule](legal/fee-schedule.md).
8. **Legal pages:** publish the reviewed Terms, Privacy Policy, Risk Warnings and Complaints Policy. Set `SMILEID_PRIVACY_URL` to the published privacy policy.
9. **Admin hardening:**
   - two admins, both with 2FA;
   - `ADMIN_ALLOWED_IPS` if your office has a fixed address;
   - `REQUIRE_ADMIN_2FA=true` (the default).
10. **Widen gradually:** raise `MAX_USERS`, add rails, then countries.

## 8. Capacity

- **Current setup:** one SQLite database on one server comfortably handles thousands of active customers.
- **When to scale:** move to Postgres and several app servers when you need high availability or reach roughly 50–100 payments a second at peak. This needs:
  - the code changes noted in `docs/security-review-2026-11.md` (the payment queue must become a database lock);
  - a shared rate-limit store.
- **Bigger server:** change the instance type in CloudFormation (a few minutes' downtime).

## 9. Contacts

| Role | Name | Phone | Email |
|---|---|---|---|
| On-call (primary) | [NAME] | [PHONE] | [EMAIL] |
| On-call (backup) | [NAME] | [PHONE] | [EMAIL] |
| MLRO | [NAME] | [PHONE] | [EMAIL] |
| DPO | [NAME] | [PHONE] | [EMAIL] |
| AWS support | AWS console → Support | | |
| Payment partners | [PARTNER support lines] | | |
| Smile ID | [support contact] | | |
