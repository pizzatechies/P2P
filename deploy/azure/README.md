# Hosting Aurex on Microsoft Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpizzatechies%2FP2P%2Frefs%2Fheads%2Fclaude%2Fgifted-ritchie-8xzdk9%2Fdeploy%2Fazure%2Fazuredeploy.json)

Everything needed to run Aurex on Azure. The server setup is shared with the AWS kit and lives in
[`deploy/server`](../server).

| File | What it does |
|---|---|
| `main.bicep` (this folder) | The whole setup: server, fixed IP with a free address, firewall, backup storage, Key Vault and permissions. |
| `azuredeploy.json` | `main.bicep` compiled for the **Deploy to Azure** button. Rebuild it after editing: `bicep build main.bicep --outfile azuredeploy.json`. |
| `cloud-init.sh` | Runs once when the server first starts: downloads Aurex and runs the installer. |
| `../server/install.sh` | Installs Docker, writes the settings file, keeps the secrets in Key Vault, restores a backup if there is one, builds the app and starts it. Run it again at any time to update. |
| `../server/docker-compose.yml` | Runs three containers: the app, **Caddy** (free HTTPS certificates that renew automatically) and **Litestream** (streams every database change to Blob Storage). |

## How it fits together

```
 users ──HTTPS──▶ public IP  aurex-xxxx.<region>.cloudapp.azure.com
                    │
                    ▼  firewall: only 80 and 443 open
                 Ubuntu 24.04 VM (Secure Boot + virtual TPM)
                  ├─ Caddy :443  → automatic Let's Encrypt certificate
                  ├─ Aurex app   → SQLite database on the server's SSD
                  └─ Litestream  → copies every change to Blob Storage within ~10 seconds
                                      (30 days of point-in-time history; storage firewall
                                       admits only the server's network)
 Secrets (MASTER-KEY, ADMIN-SETUP-CODE, storage key) ──▶ Key Vault, read by the VM's managed identity
 You ──▶ Azure portal: Run command and Serial console (no open SSH port needed)
```

Aurex keeps its data in one SQLite file, so it runs on a single server with a real disk. Container
services without a persistent disk (Container Apps, App Service containers) would lose data.

---

## What you need

1. **An Azure account.** Sign up at <https://azure.microsoft.com/free>. A new account gets
   **$200 of credit for 30 days** and **12 months of free services**. You need a payment card for
   identity checks, but you aren't charged unless you upgrade to pay-as-you-go. Then:
   - turn on **multi-factor authentication** for your sign-in (Microsoft account security settings);
   - add a **budget alert**: **Cost Management → Budgets → Add**, monthly, e.g. $10.
2. **A region near your users.** For example: **South Africa North** (Johannesburg) for southern
   and eastern Africa, **West Europe** or **North Europe** for Africa and Europe, **East US** for the
   Americas. A few regions don't offer every free size. If the deployment says a size isn't
   available, pick another region.
3. **The admin email** you'll sign up with.
4. **Optional:**
   - **A domain**, e.g. `aurexpay.com`. Without one, you get a free working address like `https://aurex-xxxx.southafricanorth.cloudapp.azure.com`.
   - **A [Resend](https://resend.com) account** for verification and alert emails. It needs your own domain.
   - **Payment and AI provider keys** (see `.env.example` in the repository root). Aurex runs on test money until you add them.

### What it costs

**First 12 months on a new account: about $0–4 a month.** The default server size,
**B2ats v2** (2 vCPU, 1 GiB, AMD), is one of the free sizes: 750 hours a month, which is enough to run one
server all month. The 64 GB Premium SSD (P6) is within the free disk allowance. The fixed public IP,
Key Vault and backup storage cost a few dollars at most, and the $200 credit covers that in the first
month. Check **Cost Management → Cost analysis** after a few days to confirm.

**After the free year** (approximate, pay-as-you-go, East US):

| Item | Monthly |
|---|---|
| VM B2ats v2 (2 vCPU, 1 GiB) | ~$7 |
| 64 GB Premium SSD (P6) | ~$10 (choose 32 GB, a P4, for ~$5) |
| Static public IPv4 address | ~$3.65 |
| Blob Storage backups and Key Vault | under $1 |
| Data transfer | the first 100 GB/month out is free |
| **Total** | **≈ $16–21/month** |

1 GiB of memory is enough for a small community. If the site gets busy, resize the VM to
**B2als v2** (4 GiB, about $30/month more) under **Virtual machine → Size**. Check current prices
with the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).

> Your free account must be upgraded to **pay-as-you-go** within 30 days (or when the credit runs
> out) to keep the server running and keep the 12 months of free services. Upgrading doesn't remove
> the free allowances.

---

## Option A: Deploy to Azure button (recommended)

1. Click **Deploy to Azure** at the top of this page and sign in.
2. **Basics:**
   - **Resource group:** **Create new** → `aurex`.
   - **Region:** near your users (see above).
   - **Admin Email:** your admin email (required).
   - **Admin Password Or Key:** a strong password (12+ characters with upper and lower case letters, a digit and a symbol). You only need it for emergency sign-in through the Serial console. Keep it in a password manager.
   - **Domain Name:** leave empty for the free `cloudapp.azure.com` address, or enter your domain, e.g. `app.aurexpay.com`.
   - **Vm Size:** `Standard_B2ats_v2` (free for 12 months). `Standard_B2pts_v2` (Arm) and `Standard_B1s` are also free sizes.
   - Leave **Ssh Source Cidr** empty (SSH stays closed) and **Payment Rails** as `sandbox` (test money) until your provider keys are ready.
3. Click **Review + create**, then **Create**.
4. Wait for **Your deployment is complete** (about 3–5 minutes). The server then builds and starts
   Aurex, which takes **another 10–20 minutes** on the free 1 GiB sizes.
5. Open **Outputs** (left menu of the deployment):
   - **appUrl:** your Aurex address. Open it once the build is done.
   - **publicIp:** the fixed IP. If you used your own domain, create an **A record** for the domain pointing to this IP at your DNS provider now. HTTPS starts working a minute or so after the record is live.
   - **adminSetupCode:** where the admin setup code is.
   - **setupProgress:** how to watch the build.
6. **Become the admin:**
   1. Open appUrl → **Get started** → sign up with the admin email.
   2. Turn on two-factor authentication (**Settings → Two-factor authentication**).
   3. Get the code: open the resource group → the **Key vault** (`aurex-…`) → **Objects → Secrets → ADMIN-SETUP-CODE** → current version → **Show Secret Value**.
   4. Enter it under **Settings → Admin access**.

**Watching the setup.** Open the resource group → **aurex-vm** → **Operations → Run command →
RunShellScript**, run this, and click **Run**:

```bash
tail -n 40 /var/log/aurex-install.log
```

It ends with "Aurex is running" when done. A few minutes of "Waiting for access to Key Vault" at the
start is normal: Azure takes a little while to apply the server's new permissions.

## Option B: Azure CLI or Cloud Shell

Open **Cloud Shell** (the `>_` icon at the top of the portal) or use the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) on your computer. Create the
resource group:

```bash
az group create --name aurex --location southafricanorth
```

Deploy (it asks for the admin password):

```bash
az deployment group create --resource-group aurex --template-uri https://raw.githubusercontent.com/pizzatechies/P2P/refs/heads/claude/gifted-ritchie-8xzdk9/deploy/azure/azuredeploy.json --parameters adminEmail=you@example.com
```

Add `domainName=app.yourdomain.com` or `vmSize=Standard_B2pts_v2` to `--parameters` to change those. To
deploy from a local copy instead, use `--template-file deploy/azure/main.bicep`. Show the outputs again
later:

```bash
az deployment group show --resource-group aurex --name azuredeploy --query properties.outputs
```

## Option C: a VM you create yourself

Create an **Ubuntu Server 24.04 LTS** VM (any size with 1 GiB or more), allow inbound **HTTP (80)** and
**HTTPS (443)**, then open **Run command → RunShellScript** on it and run (with your own email):

```bash
git clone --depth 1 --branch claude/gifted-ritchie-8xzdk9 https://github.com/pizzatechies/P2P.git /opt/aurex/src && cd /opt/aurex/src && ADMIN_EMAIL=you@example.com DOMAIN=your-label.your-region.cloudapp.azure.com ./deploy/server/install.sh
```

Set `DOMAIN` to the VM's DNS name (**Public IP address → Configuration → DNS name label**) or your
own domain. Without `DOMAIN` it uses a free `<ip>.sslip.io` address. For backups, also pass
`AZURE_STORAGE_ACCOUNT=<account>` and `AZURE_STORAGE_KEY=<access key>` (the container defaults to
`backups`; create it first). The template in Option A does all of this for you, including Key Vault.

---

## After it's running

All settings live in **`/opt/aurex/src/deploy/server/.env`** on the server (readable only by root).
To change settings, sign in with the **Serial console**:

1. Open **aurex-vm → Help → Serial console**.
2. Press Enter and sign in as `aurexadmin` with the password you chose.
3. Edit the file:

   ```bash
   sudo nano /opt/aurex/src/deploy/server/.env
   ```

4. Apply the change:

   ```bash
   cd /opt/aurex/src && sudo ./deploy/server/install.sh
   ```

**Run command** works for anything that doesn't involve typing secrets (updates, logs, restarts).
Avoid pasting API keys into Run command, because the script text is kept in the VM's command history.

### Use your own domain later

Point the domain's **A record** at the public IP (or a **CNAME** at the `cloudapp.azure.com`
address), then run this with Run command:

```bash
cd /opt/aurex/src && DOMAIN=app.yourdomain.com ./deploy/server/install.sh
```

Caddy gets the new certificate automatically.

### Turn on email, providers and webhooks

These steps are the same on every host. See the AWS guide:
[email](../aws/README.md#turn-on-email-verification-codes-and-security-alerts),
[payment, AI and trading providers](../aws/README.md#turn-on-real-payment-ai-and-trading-providers)
(with the webhook URLs to register) and
[pointing the public website at the app](../aws/README.md#point-the-public-website-at-the-app).
Edit `.env` through the Serial console as shown above. Providers that need the server's IP
whitelisted (Skrill payouts, M-Pesa and MoMo production) get the **publicIp** output.

### Update to the latest version

With Run command:

```bash
cd /opt/aurex/src && git pull && ./deploy/server/install.sh
```

Your data, secrets and settings are kept. The app restarts after the new build, which means a short
pause of a few seconds.

### Backups and restoring

- **Continuous:** Litestream copies every change to the storage account (container `backups`, folder `aurex/`) within about 10 seconds, and keeps 30 days of point-in-time history. Deleted backup files can be recovered for 14 days (soft delete).
- **Private by design:** the storage account accepts requests only from the server's network, over HTTPS. To browse or download backups from the portal, add your IP under **Storage account → Networking → Firewall** first, and remove it afterwards.
- **New or replaced server:** delete the VM and its disk, then deploy the template again into the same resource group with the same settings. The new server reads `MASTER-KEY` from Key Vault and **restores the latest backup automatically** before starting, so accounts and stored keys come back as they were.
- **Point-in-time restore** (for example to undo a mistake), with Run command:

  ```bash
  cd /opt/aurex/src/deploy/server && docker compose --env-file .env stop app litestream && docker compose --env-file .env --profile backup run --rm --no-deps litestream restore -timestamp 2026-11-16T09:00:00Z -o /data/restored.db /data/aurex.db
  ```

  Then swap in the restored copy and start everything again:

  ```bash
  docker run --rm -v aurex_aurex-data:/data busybox sh -c 'mv /data/aurex.db /data/aurex.db.before-restore && rm -f /data/aurex.db-wal /data/aurex.db-shm && mv /data/restored.db /data/aurex.db' && cd /opt/aurex/src && ./deploy/server/install.sh
  ```

- **Keep `MASTER-KEY` safe.** It's in Key Vault and in `.env`. Without it, stored API keys and 2FA secrets can't be decrypted.
- **Rotating the storage key:** regenerate it under **Storage account → Security + networking → Access keys**, update the Key Vault secret `STORAGE-KEY` with the new key (or redeploy the template), then re-run the installer.

### Logs and health

With Run command. The app's recent log:

```bash
cd /opt/aurex/src/deploy/server && docker compose --env-file .env logs --tail 100 app
```

All containers:

```bash
cd /opt/aurex/src/deploy/server && docker compose --env-file .env ps
```

HTTPS certificates:

```bash
cd /opt/aurex/src/deploy/server && docker compose --env-file .env logs --tail 50 caddy
```

Backups:

```bash
cd /opt/aurex/src/deploy/server && docker compose --env-file .env logs --tail 50 litestream
```

Ubuntu installs security updates automatically. The containers start again by themselves after a
reboot. Azure moves the VM to healthy hardware if a host fails.

### What's locked down

- Only ports 80 and 443 are open; SSH stays closed unless you allow one IP range.
- **Trusted Launch** (Secure Boot and a virtual TPM) on the x64 sizes.
- The server reaches Key Vault with its **managed identity**; no cloud passwords are stored on it. Only the backup container gets the storage key; the app never sees it.
- Key Vault uses role-based access: the server can manage its own secrets, and you can read them.
- Storage: no public access, HTTPS and TLS 1.2 only, firewall limited to the server's subnet, soft delete on.
- Plus everything Aurex does itself (see the main README's Security section).

### Security checklist

- [ ] Multi-factor authentication on your Azure sign-in
- [ ] Budget alert set
- [ ] SSH closed (**Ssh Source Cidr** left empty)
- [ ] Two-factor authentication on the Aurex admin account; setup code entered, then kept private
- [ ] `PAYMENT_RAILS` without `sandbox` before handling real money (and the licensing in the main README's "Going to production")
- [ ] Email set up (Resend) so verification is enforced
- [ ] **Microsoft Defender for Cloud** recommendations reviewed (the free tier is on by default)
- [ ] A test restore done once, so you know backups work

### Removing everything

Delete the **resource group**. This deletes the server **and the backups**, so download a copy of
the `backups` container first if you might need the data.

Key Vault keeps deleted vaults for 7 days. To reuse the same resource group name within that time,
purge the old vault first (**Key vaults → Manage deleted vaults**, or
`az keyvault purge --name aurex-xxxx`).

## Troubleshooting

| Problem | What to check |
|---|---|
| Deployment fails: size not available or quota | Pick another region, or another free size (`Standard_B2pts_v2`, `Standard_B1s`). New accounts have small vCPU quotas per region. |
| Deployment fails: vault name already exists | A vault from an earlier deployment in a resource group with the same name is still soft-deleted. Purge it (see above) or use a new resource group name. |
| Address doesn't load | Wait 20 minutes after the deployment completes, then check `/var/log/aurex-install.log` with Run command. |
| "Not secure" or no HTTPS | Your domain's A record must point to the public IP. See the caddy logs. If Let's Encrypt is busy for `cloudapp.azure.com` names, Caddy automatically uses ZeroSSL instead; your own domain avoids this. |
| Log says "couldn't read MASTER-KEY from Key Vault" | The server's access hadn't applied after 10 minutes. Check **Key vault → Access control (IAM)** lists `aurex-vm` as *Key Vault Secrets Officer*, then re-run the installer with Run command. |
| Can't see the secrets in Key Vault | You need *Key Vault Secrets User* on the vault. The template gives it to whoever deployed; anyone else can be added under **Access control (IAM)**. |
| Backups not appearing | Check the litestream logs. The storage firewall must list the `aurex-vnet/default` subnet, and `STORAGE-KEY` must match the account's key1. |
| Build ran out of memory | The installer adds 2 GB of swap. If it still fails, resize to `Standard_B2als_v2` (4 GiB) and re-run the installer. |
| Cookies not sticking / can't sign in | Always use the `https://` address in `APP_URL`; production cookies require HTTPS. |
