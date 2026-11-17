# Hosting Aurex on Amazon Web Services (AWS)

Everything needed to run Aurex on AWS. The server setup lives in [`deploy/server`](../server), so it
also works on Lightsail or any Ubuntu server:

| File | What it does |
|---|---|
| `aurex.cloudformation.yml` (this folder) | One-stack setup: server, static IP, firewall, IAM role, backup bucket and (optionally) the DNS record. It runs the installer on first boot. |
| `../server/install.sh` | Installs Docker, writes the settings file, generates the secrets, builds the app and starts it. Run it again at any time to update. |
| `../server/docker-compose.yml` | Runs three containers: the app, **Caddy** (free HTTPS certificates that renew automatically) and **Litestream** (streams every database change to S3). |
| `../server/Caddyfile`, `../server/litestream.yml` | Settings for those two containers. |

## How it fits together

```
 users ──HTTPS──▶ Elastic IP ──▶ EC2 server (Ubuntu 24.04)
                                  ├─ Caddy :443  → automatic Let's Encrypt certificate
                                  ├─ Aurex app   → SQLite database on the server's disk
                                  └─ Litestream  → copies every change to S3 within ~10 seconds
                                                      (30 days of point-in-time history)
 Secrets (MASTER_KEY, admin setup code) ──▶ Systems Manager Parameter Store (encrypted)
 You ──▶ Session Manager (a terminal in your browser; no SSH keys or open SSH port)
```

Aurex keeps its data in one SQLite file, so it runs on a single server with a real disk. Container
services without a persistent disk (App Runner, Lightsail containers, Fargate) would lose data.

---

## What you need

1. **An AWS account.** Sign up at <https://aws.amazon.com> with a payment card. Then:
   - turn on **MFA** for the root user (Account menu → Security credentials);
   - create a day-to-day admin user in **IAM Identity Center** (or IAM) and use that instead of root;
   - add a **budget alert** (Billing → Budgets → Create budget → Monthly cost, e.g. $30).
2. **A region near your users.** Pick it in the top-right corner of the console:
   - `eu-west-1` (Ireland) is a good default for Africa and Europe;
   - `af-south-1` (Cape Town) is closest for southern and eastern Africa, but you must enable it first (Account → AWS Regions) and it costs a little more;
   - `us-east-1` (N. Virginia) is the cheapest.
3. **The admin email** you'll sign up with.
4. **Optional:**
   - **A domain**, e.g. `aurexpay.com`. Without one, you get a free working address like `https://3-120-45-67.sslip.io`.
   - **A [Resend](https://resend.com) account** for verification and alert emails. It needs your own domain.
   - **Payment and AI provider keys** (see `.env.example` in the repository root). Aurex runs on test money until you add them.

### What it costs (approximate, on-demand, us-east-1)

| Item | Monthly |
|---|---|
| EC2 `t4g.small` (2 vCPU, 2 GB) | ~$12.30 |
| 20 GB encrypted gp3 disk | ~$1.60 |
| Static public IPv4 address | ~$3.65 |
| S3 backups, Parameter Store, Session Manager | under $1 |
| Data transfer | the first 100 GB/month out is free |
| **Total** | **≈ $18/month** |

`t4g.medium` (4 GB) costs about $12 more per month if you need more headroom. Check current prices with the [AWS Pricing Calculator](https://calculator.aws/).

### On a brand-new AWS account (Free plan)

Accounts opened since July 2025 usually start on the **Free plan**. Aurex runs on it, with these rules:

- **Credits:** $100 when you sign up, plus $20 for each of five activities in the **Explore AWS** box on Console
  Home (filter: *Earn AWS credits*). Setting up the budget above is one of them. Aurex uses up to about $18 a
  month of credits.
- **Nothing is ever charged** on the Free plan. Your credit balance and the days left are on the
  **Billing and Cost Management** home page.
- **Server size:** only small sizes are allowed. Keep **InstanceType** at `t4g.small` (or `t3.small`);
  medium and large sizes fail on the Free plan.
- **Region:** stay with `eu-west-1` or another standard region. Opt-in regions such as Cape Town cost more
  and use up the credits faster.
- **Buying a domain** inside AWS may not be allowed on the Free plan. Buy it from another registrar
  (Cloudflare, Namecheap…) and point an A record at the server.
- **The plan ends after up to 6 months**, or sooner if the credits run out. Then **the account closes and
  Aurex goes offline**. You have 90 days to upgrade and get everything back; after that, AWS deletes the
  account, including the backups. So, **2–3 weeks before the end** (or when about $20 of credits is left),
  go to **Billing → Upgrade plan → Upgrade account**. Leftover credits carry over; after them you pay about
  $18 a month.
- **Brand-new accounts** can take from a few minutes to a few hours to be fully activated. If the stack fails
  with *PendingVerification*, wait and create it again (see Troubleshooting).

---

## Option A: one stack with CloudFormation (recommended, about 15 minutes)

1. **Download the template.** Open
   <https://github.com/pizzatechies/P2P/blob/claude/gifted-ritchie-8xzdk9/deploy/aws/aurex.cloudformation.yml>,
   click **Download raw file**, and save `aurex.cloudformation.yml`.
2. In the AWS console, check the **region** (top right), then open **CloudFormation → Create stack → With new resources (standard)**.
3. Choose **Upload a template file**, pick `aurex.cloudformation.yml`, and click **Next**.
4. **Stack name:** `aurex`. **Parameters:**
   - **AdminEmail:** your admin email (required).
   - **DomainName:** leave empty for a free `sslip.io` address, or enter your domain, e.g. `app.aurexpay.com`.
   - **HostedZoneId:** only if that domain is in Route 53; the DNS record is then created for you.
   - **InstanceType:** `t4g.small` is fine to start.
   - Leave **SshCidr** and **KeyName** empty. You'll use Session Manager instead of SSH.
   - Leave **PaymentRails** as `sandbox` (test money) until your provider keys are ready.
5. Click **Next**, then **Next** again. Tick **"I acknowledge that AWS CloudFormation might create IAM resources"**, then **Submit**.
6. Wait for **CREATE_COMPLETE** (about 3 minutes). The server then builds and starts Aurex, which takes **another 5–10 minutes**.
7. Open the **Outputs** tab:
   - **AppUrl:** your Aurex address. Open it once the build is done.
   - **PublicIp:** the static IP. If you used your own domain without Route 53, create an **A record** for the domain pointing to this IP at your DNS provider now. HTTPS starts working a minute or so after the record is live.
   - **ConnectToServer:** a terminal on the server in your browser.
   - **AdminSetupCode:** where the admin setup code is stored.
8. **Become the admin:**
   1. Open AppUrl → **Get started** → sign up with the admin email.
   2. Turn on two-factor authentication (**Settings → Two-factor authentication**).
   3. Get the code: **Systems Manager → Parameter Store →** the AdminSetupCode name **→ Show decrypted value**.
   4. Enter it under **Settings → Admin access**.

If the address doesn't load after 15 minutes, open **ConnectToServer** and run `sudo tail -n 100 /var/log/aurex-setup.log`.

## Option B: set up the server by hand

1. **Create the backup bucket:** S3 → Create bucket (for example `aurex-backups-<yourname>`) with Block all public access **on** and Bucket Versioning **on**.
2. **Create an IAM role:** IAM → Roles → Create role → AWS service → **EC2**.
   - Add the policy **AmazonSSMManagedInstanceCore**.
   - Add an inline policy allowing `s3:ListBucket` on the bucket and `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `bucket/*`.
   - Add `ssm:GetParameter` and `ssm:PutParameter` on `arn:aws:ssm:<region>:<account>:parameter/aurex/*`.
3. **Launch the server:** EC2 → Launch instance.
   - **Ubuntu Server 24.04 LTS** (64-bit Arm), instance type **t4g.small**, storage **20 GB gp3**.
   - A new **security group** allowing HTTP (80) and HTTPS (443) from anywhere.
   - Under Advanced details, set the **IAM instance profile** to the role above, and set **Metadata response hop limit** to **2**.
4. **Give it a static IP:** EC2 → Elastic IPs → Allocate → Associate with the instance.
5. **Connect:** select the instance → Connect → **Session Manager** → Connect. Then run (with your own values):

   ```bash
   sudo git clone --depth 1 --branch claude/gifted-ritchie-8xzdk9 https://github.com/pizzatechies/P2P.git /opt/aurex/src
   cd /opt/aurex/src
   sudo ADMIN_EMAIL=you@example.com BACKUP_BUCKET=aurex-backups-yourname PARAM_PREFIX=/aurex/prod ./deploy/server/install.sh
   ```

   Add `DOMAIN=app.yourdomain.com` if your DNS A record already points to the Elastic IP. The script
   prints your address and where the admin setup code is.

`install.sh` also works on **Amazon Lightsail** (a $12/month 2 GB Ubuntu instance) or any Ubuntu VPS.
Without an IAM role, leave out `PARAM_PREFIX` (the secrets then live only in `.env`, so keep a copy of
`MASTER_KEY` somewhere safe). For backups, add `AWS_ACCESS_KEY_ID=...` and `AWS_SECRET_ACCESS_KEY=...`
lines for a user that can only use the bucket to `deploy/server/.env.litestream`, then re-run
`install.sh`. Only the backup container reads that file; the app never sees the keys.

---

## After it's running

All settings live in **`/opt/aurex/src/deploy/server/.env`** on the server. To change something, connect with Session Manager:

```bash
sudo nano /opt/aurex/src/deploy/server/.env
```

Then apply the change:

```bash
cd /opt/aurex/src && sudo ./deploy/server/install.sh
```

### Use your own domain later

Point the domain's **A record** at the Elastic IP, then run:

```bash
cd /opt/aurex/src && sudo DOMAIN=app.yourdomain.com ./deploy/server/install.sh
```

Caddy gets the new certificate automatically.

### Add API keys without the terminal (Parameter Store)

The browser terminal often won't paste, so the easiest way to give the server a key is a normal AWS web form:

1. **Systems Manager → Parameter Store → Create parameter** (in your stack's region).
2. **Name:** `/aurex/<stack name>/` followed by the key's name from `.env.example`, for example
   `/aurex/aurex/RESEND_API_KEY` or `/aurex/aurex/MPESA_CONSUMER_SECRET`.
3. **Type:** **SecureString** (keep the default key). **Value:** paste the key. Click **Create parameter**.
4. In the browser terminal, run (short enough to type):

   ```bash
   cd /opt/aurex/src && sudo git pull && sudo ./deploy/server/install.sh
   ```

   It prints `Found: RESEND_API_KEY …` and writes the keys into `.env`. Keys in Parameter Store override the
   same names in `.env`, stay encrypted, and come back automatically on a rebuilt server. To change or
   remove one, edit or delete it in Parameter Store and run the command again.

### Turn on email (verification codes and security alerts)

1. Create a Resend account and add your domain (Resend shows DNS records to create).
2. Create an API key in Resend (**Sending access**).
3. Store it as `/aurex/<stack name>/RESEND_API_KEY` in Parameter Store (see above) and re-run `install.sh`,
   or add `RESEND_API_KEY=re_...` to `.env` yourself. Emails come from `Aurex <no-reply@your-domain>`;
   set `EMAIL_FROM` in `.env` to change that.

### Turn on real payment, AI and trading providers

Put secret keys in Parameter Store (see above), and copy the other lines you need from `.env.example` in
the repository root into `.env` (for example `ANTHROPIC_API_KEY`, `MPESA_*`, `PAYPAL_*`, `SKRILL_*`,
`MONEYGRAM_*`). Add the rail names to
`PAYMENT_RAILS` (for example `PAYMENT_RAILS=mpesa,paypal,skrill`; remove `sandbox` for real money),
then re-run `install.sh`.

Webhook addresses to register with providers (replace the domain with yours):

| Provider | Webhook URL |
|---|---|
| Stripe | `https://YOUR-DOMAIN/api/webhooks/stripe` |
| Flutterwave | `https://YOUR-DOMAIN/api/webhooks/flutterwave` |
| PayPal | `https://YOUR-DOMAIN/api/webhooks/paypal` |
| Skrill | set automatically (`/api/webhooks/skrill`) |
| MTN MoMo | set automatically (`/api/webhooks/mtn-momo`) |
| M-Pesa | set automatically (secret URL) |
| Plaid | `https://YOUR-DOMAIN/api/webhooks/plaid` |
| Mono | `https://YOUR-DOMAIN/api/webhooks/mono` |
| Coinbase OAuth redirect | `https://YOUR-DOMAIN/api/connections/oauth/coinbase/callback` |

Skrill payouts and M-Pesa/MoMo production access require the server's Elastic IP to be
whitelisted with the provider.

### Point the public website at the app

On GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**.
Name it `AUREX_APP_URL` and set it to your app address. The "Launching soon" buttons on the website
become sign-up links on the next website build.

### Update to the latest version

```bash
cd /opt/aurex/src && sudo git pull && sudo ./deploy/server/install.sh
```

Your data, secrets and settings are kept. The app restarts after the new build, which means a short
pause of a few seconds.

### Backups and restoring

- **Continuous:** Litestream copies every change to the S3 bucket (`aurex/` folder) within about 10 seconds, and keeps 30 days of history. Deleting the CloudFormation stack keeps the bucket.
- **New or replaced server:** run `install.sh` with the same `BACKUP_BUCKET` and `PARAM_PREFIX`. On a server with no data yet, it **restores the latest backup automatically** before starting, and takes the same `MASTER_KEY` from Parameter Store, so stored keys stay readable.
- **Point-in-time restore** (for example to undo a mistake):

  ```bash
  cd /opt/aurex/src/deploy/server
  ```

  Stop the app:

  ```bash
  sudo docker compose --env-file .env stop app litestream
  ```

  Restore the database as it was at a given time:

  ```bash
  sudo docker compose --env-file .env --profile backup run --rm --no-deps litestream restore -timestamp 2026-11-16T09:00:00Z -o /data/restored.db /data/aurex.db
  ```

  Move the current database aside and put the restored copy in its place:

  ```bash
  sudo docker run --rm -v aurex_aurex-data:/data busybox sh -c 'mv /data/aurex.db /data/aurex.db.before-restore && rm -f /data/aurex.db-wal /data/aurex.db-shm && mv /data/restored.db /data/aurex.db'
  ```

  Start everything again:

  ```bash
  sudo ./install.sh
  ```

- **Keep `MASTER_KEY` safe.** It's in Parameter Store (`/aurex/<stack>/MASTER_KEY`) and in `.env`. Without it, stored API keys and 2FA secrets can't be decrypted.

### Logs and health

Follow the app's log:

```bash
cd /opt/aurex/src/deploy/server && sudo docker compose --env-file .env logs -f app
```

Check that all containers are running:

```bash
sudo docker compose --env-file .env ps
```

Check HTTPS and certificate logs:

```bash
sudo docker compose --env-file .env logs caddy
```

The CloudFormation stack adds a CloudWatch alarm that moves the server to healthy hardware if AWS
detects a host failure. Ubuntu installs security updates automatically.

### Security checklist

- [ ] MFA on the AWS root user; daily work done as an admin user, not root
- [ ] Budget alert set
- [ ] No SSH port open (use Session Manager)
- [ ] Two-factor authentication on the Aurex admin account; setup code entered, then kept private
- [ ] `PAYMENT_RAILS` without `sandbox` before handling real money (and the licensing in the main README's "Going to production")
- [ ] Email set up (Resend) so verification is enforced
- [ ] A test restore done once, so you know backups work

### Removing everything

CloudFormation → select the stack → **Delete**. The backup bucket and Parameter Store entries are
kept on purpose; delete them by hand (S3 → empty then delete the bucket; Parameter Store →
`/aurex/<stack>/…`) if you really want all data gone.

## Troubleshooting

| Problem | What to check |
|---|---|
| Address doesn't load | Wait 10–15 minutes after the stack completes, then check `/var/log/aurex-setup.log`. |
| "Not secure" or no HTTPS | The domain's A record must point to the Elastic IP, and ports 80/443 must be open. See `docker compose logs caddy`. |
| Build ran out of memory | The installer adds 2 GB of swap; if it still fails, use `t4g.medium`. |
| Backups not appearing in S3 | The instance role needs the bucket permissions, and the metadata hop limit must be 2. See `docker compose logs litestream`. |
| Stack failed: *PendingVerification* or "your account is being validated" | A brand-new account isn't fully activated yet. Delete the stack, wait (minutes to a few hours), and create it again. |
| Stack failed: *VcpuLimitExceeded* | Service Quotas → Amazon EC2 → *Running On-Demand Standard instances* → **Request increase** (ask for 4), then create the stack again. |
| Stack failed: instance type not allowed or not available | Delete the stack and create it again with **InstanceType** `t3.small`. |
| Cookies not sticking / can't sign in | Always use the `https://` address in `APP_URL`; production cookies require HTTPS. |
