import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { Empty, ErrorText, Field, Modal } from "../components/ui";
import { holding, money, timeAgo, usd } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import type { ConnectionsOverview, ConnectorInfo, LinkedConnection } from "../types";

const CATEGORIES: { id: "all" | ConnectorInfo["category"]; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bank", label: "Banks & cards" },
  { id: "brokerage", label: "Brokerages" },
  { id: "payments", label: "Payments & mobile money" },
  { id: "crypto", label: "Crypto" },
];

const KIND_LABEL: Record<string, string> = {
  bank: "Current", savings: "Savings", card: "Card", credit: "Credit", loan: "Loan", investment: "Investments", wallet: "Wallet", crypto: "Crypto", other: "Account",
};

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", CA: "Canada", GB: "United Kingdom", IE: "Ireland", FR: "France", ES: "Spain", NL: "Netherlands", DE: "Germany",
  IT: "Italy", PL: "Poland", DK: "Denmark", NO: "Norway", SE: "Sweden", EE: "Estonia", LT: "Lithuania", LV: "Latvia", PT: "Portugal",
  BE: "Belgium", AT: "Austria", AU: "Australia", NG: "Nigeria", GH: "Ghana", KE: "Kenya", ZA: "South Africa", UG: "Uganda", TZ: "Tanzania",
  ZM: "Zambia", RW: "Rwanda", CM: "Cameroon", CI: "Côte d'Ivoire", SN: "Senegal", BJ: "Benin", CG: "Congo", SZ: "Eswatini",
  GN: "Guinea", LR: "Liberia",
};

/** Link accounts held elsewhere (banks, brokerages, wallets) and see them all in one place. */
export function ConnectionsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const overview = useLoad(() => api.get<ConnectionsOverview>("/api/connections"));
  const providers = useLoad(() => api.get<{ providers: ConnectorInfo[] }>("/api/connections/providers").then((r) => r.providers));
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [country, setCountry] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingWallet, setAddingWallet] = useState(false);
  const handled = useRef(false);

  // Coming back from a provider's consent screen: finish the link with whatever it appended.
  useEffect(() => {
    const link = params.get("link");
    const provider = params.get("callback");
    if (!link || !provider || handled.current) return;
    handled.current = true;
    const extra: Record<string, string> = {};
    params.forEach((v, k) => {
      if (k !== "link" && k !== "callback") extra[k] = v;
    });
    setBusy("callback");
    api
      .post<{ status: string }>(`/api/connections/links/${link}/complete`, { params: extra })
      .then((r) => {
        toast(r.status === "active" ? "Connected. Your accounts are syncing." : "Almost there: waiting for the provider to confirm.");
        overview.reload();
      })
      .catch((e) => toast((e as Error).message, "error"))
      .finally(() => {
        setBusy(null);
        setParams({}, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(p: ConnectorInfo) {
    if (p.id === "web3") {
      setAddingWallet(true);
      return;
    }
    setBusy(p.id);
    setError(null);
    try {
      const r = await api.post<{ redirectUrl: string }>(`/api/connections/${p.id}/start`);
      window.location.href = r.redirectUrl;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function sync(c: LinkedConnection) {
    setBusy(`sync-${c.id}`);
    try {
      overview.setData(await api.post<ConnectionsOverview>(`/api/connections/${c.id}/sync`));
      toast(`${c.institution ?? c.providerName} updated`);
    } catch (e) {
      toast((e as Error).message, "error");
      overview.reload();
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: LinkedConnection) {
    if (!confirm(`Disconnect ${c.institution ?? c.providerName}? Aurex will stop reading these accounts and forget the access it was given.`)) return;
    setBusy(`del-${c.id}`);
    try {
      overview.setData(await api.del<ConnectionsOverview>(`/api/connections/${c.id}`));
      toast("Disconnected");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function recheck(linkId: string) {
    setBusy(`pending-${linkId}`);
    try {
      const r = await api.post<{ status: string }>(`/api/connections/links/${linkId}/complete`, { params: {} });
      toast(r.status === "active" ? "Connected" : "Still waiting for the provider to confirm");
      overview.reload();
    } catch (e) {
      toast((e as Error).message, "error");
      overview.reload();
    } finally {
      setBusy(null);
    }
  }

  const countries = useMemo(() => {
    const set = new Set<string>();
    (providers.data ?? []).forEach((p) => p.countries.forEach((c) => set.add(c)));
    return [...set].sort((a, b) => (COUNTRY_NAMES[a] ?? a).localeCompare(COUNTRY_NAMES[b] ?? b));
  }, [providers.data]);

  const visible = (providers.data ?? []).filter((p) => {
    if (category !== "all" && p.category !== category) return false;
    if (country && p.countries.length > 0 && !p.countries.includes(country)) return false;
    const q = query.trim().toLowerCase();
    if (q && !`${p.name} ${p.coverage} ${p.description} ${p.regions.join(" ")}`.toLowerCase().includes(q)) return false;
    return true;
  });
  // Ready-to-use first, then not yet set up, then planned.
  const rank = (p: ConnectorInfo) => (p.kind === "planned" ? 2 : p.configured ? 0 : 1);
  visible.sort((a, b) => rank(a) - rank(b));

  const ov = overview.data;
  const accountCount = ov?.connections.reduce((n, c) => n + c.accounts.length, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p className="muted">Link your banks, brokerages and wallets to see everything in one place. Aurex reads balances only; your passwords stay with your bank.</p>
        </div>
      </div>

      {busy === "callback" && <div className="banner info"><span className="spinner" /> Finishing your connection…</div>}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card span-2">
          <div className="stat-label">Net worth across linked accounts</div>
          <div className="stat-value" style={{ fontSize: 32 }}>{ov ? money(ov.netWorth, ov.baseCurrency) : "—"}</div>
          <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
            {(ov?.totals ?? []).map((t) => (
              <span key={t.currency} className="pill num">{holding(t.total, t.currency)}</span>
            ))}
          </div>
          <div className="stat-sub">
            {accountCount} account{accountCount === 1 ? "" : "s"} at {ov?.connections.length ?? 0} institution{ov?.connections.length === 1 ? "" : "s"} · converted to {ov?.baseCurrency} at mid-market rates
            {ov?.unconvertedAccounts ? ` · ${ov.unconvertedAccounts} account(s) without a price not included` : ""}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Your Aurex wallet is separate</div>
          <p className="small muted" style={{ marginTop: 6 }}>
            Linked accounts are read-only snapshots. To move money in or out of Aurex, use <a href="/app/wallet">Wallet</a>: card, bank and mobile money where enabled.
          </p>
        </div>
      </div>

      {(ov?.pending ?? []).map((p) => (
        <div key={p.id} className="banner" style={{ alignItems: "center" }}>
          <span className="grow">Waiting for <strong>{p.provider}</strong> to confirm a connection you started {timeAgo(p.createdAt)}.</span>
          <button className="btn sm secondary" disabled={!!busy} onClick={() => recheck(p.id)}>Check again</button>
        </div>
      ))}

      <div className="stack" style={{ marginBottom: 24 }}>
        {ov && ov.connections.length === 0 && (
          <div className="card"><Empty>No accounts linked yet. Pick a provider below to connect your first bank, brokerage or wallet.</Empty></div>
        )}
        {(ov?.connections ?? []).map((c) => (
          <div className="card" key={c.id}>
            <div className="card-head" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <h2 className="row wrap" style={{ gap: 8 }}>
                  {c.institution ?? c.providerName}
                  {c.institution && c.institution !== c.providerName && <span className="pill">{c.providerName}</span>}
                  {c.status === "error" && <span className="pill bad">Needs attention</span>}
                </h2>
                <div className="faint xs" style={{ marginTop: 4 }}>
                  {c.wallet && <><span className="mono">{c.wallet.address}</span> · {c.wallet.network} · watch-only · </>}
                  {c.country ? `${COUNTRY_NAMES[c.country] ?? c.country} · ` : ""}
                  {c.lastSyncedAt ? `updated ${timeAgo(c.lastSyncedAt)}` : "not synced yet"}
                </div>
                {c.error && <div className="error-text small" style={{ marginTop: 4 }}>{c.error}</div>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn secondary sm" disabled={!!busy} onClick={() => sync(c)}>{busy === `sync-${c.id}` ? "Updating…" : "Refresh"}</button>
                <button className="btn ghost sm" disabled={!!busy} onClick={() => remove(c)}>{c.wallet ? "Stop watching" : "Disconnect"}</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Account</th><th>Type</th><th className="r">Balance</th><th className="r hide-sm">Available</th></tr></thead>
                <tbody>
                  {c.accounts.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 560 }}>{a.name}{a.mask && <span className="faint small"> ••{a.mask}</span>}</td>
                      <td className="muted small">{KIND_LABEL[a.kind] ?? a.kind}</td>
                      <td className={`r num ${a.balance !== null && a.balance < 0 ? "bad" : ""}`}>
                        {a.balance === null || !a.currency ? "—" : holding(a.balance, a.currency)}
                        {a.valueUsd !== null && a.kind === "crypto" && <div className="faint xs">≈ {usd(a.valueUsd)}</div>}
                      </td>
                      <td className="r num muted hide-sm">{a.available === null || !a.currency ? "—" : holding(a.available, a.currency)}</td>
                    </tr>
                  ))}
                  {c.accounts.length === 0 && <tr><td colSpan={4} className="faint small">No accounts returned yet. Try Refresh in a minute.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head" style={{ alignItems: "flex-start" }}>
          <div>
            <h2>Add a connection</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Aurex connects through licensed aggregators, each covering a region, so one hub can reach institutions around the world.
            </p>
          </div>
        </div>
        <div className="row wrap" style={{ marginBottom: 14, gap: 8 }}>
          <div className="seg" role="tablist" aria-label="Category">
            {CATEGORIES.map((c) => (
              <button key={c.id} className={category === c.id ? "on" : ""} onClick={() => setCategory(c.id)} role="tab" aria-selected={category === c.id}>{c.label}</button>
            ))}
          </div>
          <select className="input" style={{ width: "auto", height: 36 }} value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
            <option value="">All countries</option>
            {countries.map((c) => <option key={c} value={c}>{COUNTRY_NAMES[c] ?? c}</option>)}
          </select>
          <input className="input" style={{ width: 220, height: 36 }} placeholder="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search providers" />
        </div>
        <ErrorText error={error} />
        <div className="provider-cards">
          {visible.map((p) => (
            <div key={p.id} className={`provider-card ${p.kind === "planned" ? "planned" : ""}`}>
              <div className="row between" style={{ alignItems: "flex-start" }}>
                <div>
                  <h3>{p.name}{p.beta && <span className="pill warn" style={{ marginLeft: 6 }}>beta</span>}</h3>
                  <div className="faint xs">{p.regions.join(" · ")}</div>
                </div>
                {p.kind === "planned" ? (
                  <span className="pill">Planned</span>
                ) : p.kind === "rail" ? (
                  p.configured ? <span className="pill good">In your Wallet</span> : <span className="pill">Not set up</span>
                ) : p.configured ? (
                  <button className="btn sm" disabled={!!busy} onClick={() => connect(p)}>{busy === p.id ? "Opening…" : p.id === "web3" ? "Add wallet" : "Connect"}</button>
                ) : (
                  <span className="pill">Not set up</span>
                )}
              </div>
              <p className="small" style={{ margin: "8px 0" }}>{p.coverage}</p>
              <p className="faint xs">{p.description}</p>
              <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
                {p.capabilities.map((c) => <span key={c} className="pill" style={{ height: 20, fontSize: 11 }}>{c}</span>)}
              </div>
              {!p.configured && p.kind !== "planned" && user?.role === "admin" && p.envKeys.length > 0 && (
                <div className="setup-hint xs">
                  To enable: set <code>{p.envKeys.join(", ")}</code>
                  {p.signupUrl && <> · <a href={p.signupUrl} target="_blank" rel="noopener noreferrer">get keys</a></>}
                </div>
              )}
            </div>
          ))}
          {providers.data && visible.length === 0 && <Empty>No providers match. Try another country or category.</Empty>}
        </div>
      </div>
      {addingWallet && (
        <AddWalletDialog
          onClose={() => setAddingWallet(false)}
          onAdded={(ov) => {
            overview.setData(ov);
            setAddingWallet(false);
            toast("Wallet added");
          }}
        />
      )}
    </>
  );
}

/** What a pasted value looks like. Secrets are caught here, so they never leave the browser. */
function classify(raw: string): { kind: "secret"; message: string } | { kind: "address"; network: string } | { kind: "unknown" } {
  const v = raw.trim();
  if (!v) return { kind: "unknown" };
  const words = v.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-zA-Z]{3,8}$/.test(w))) {
    return { kind: "secret", message: "This looks like a recovery phrase. Never share it with anyone, Aurex included: whoever has it owns your wallet. Clear this box and paste your public address instead." };
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v) || /^[xyzt]prv/.test(v) || /^\[\s*\d+(\s*,\s*\d+){20,}\s*\]$/.test(v) || /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v)) {
    return { kind: "secret", message: "This looks like a private key. Never share it with anyone. Clear this box and paste your public address instead." };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return { kind: "address", network: "Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain" };
  if (/^(bc1|BC1)[0-9A-Za-z]{8,87}$/.test(v) || /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(v)) return { kind: "address", network: "Bitcoin" };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return { kind: "address", network: "Solana" };
  return { kind: "unknown" };
}

function AddWalletDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (ov: ConnectionsOverview) => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = classify(address);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (seen.kind === "secret") return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.post<ConnectionsOverview>("/api/connections/web3", { address: address.trim(), label: label.trim() || undefined }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Watch a Web3 wallet" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>
          Paste the wallet's <strong>public address</strong>, the one you'd give someone to send you crypto. Aurex reads its balances from the
          public blockchain. It can't move anything, and it never asks for your recovery phrase or keys.
        </p>
        <Field label="Public address">
          <input
            className="input mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…, bc1… or a Solana address"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
        </Field>
        {seen.kind === "secret" && (
          <div className="banner" style={{ borderColor: "var(--bad)", margin: 0 }} role="alert">
            <Icon.Shield size={16} />
            <span className="grow small"><strong>Stop.</strong> {seen.message}</span>
            <button type="button" className="btn sm" onClick={() => setAddress("")}>Clear</button>
          </div>
        )}
        {seen.kind === "address" && <div className="faint xs">Looks like an address on {seen.network}.</div>}
        <Field label="Name (optional)">
          <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. MetaMask, Ledger savings" />
        </Field>
        <ErrorText error={error} />
        <button className="btn block" disabled={busy || seen.kind === "secret" || !address.trim()}>{busy ? "Reading balances…" : "Add wallet"}</button>
        <p className="faint xs" style={{ margin: 0 }}>
          Supported: Bitcoin, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana, with each network's coin and USDC/USDT.
          Wallet apps like MetaMask, Coinbase Wallet, Trust Wallet, Phantom and Ledger show your address under "Receive".
        </p>
      </form>
    </Modal>
  );
}

/** Demo institution consent screen: stands in for a real provider's hosted sign-in in sandbox mode. */
export function ConnectSandboxPage() {
  const [params] = useSearchParams();
  const banks = useLoad(() => api.get<{ banks: { id: string; name: string; country: string; currency: string; accounts: number }[] }>("/api/connections/sandbox/banks").then((r) => r.banks));
  const [choice, setChoice] = useState("zambia");
  const returnTo = params.get("return") ?? "";
  // Only ever send the user back into Aurex itself.
  const safe = returnTo.startsWith(window.location.origin + "/") ? returnTo : null;

  function finish(consent: "granted" | "denied") {
    if (!safe) return;
    const url = new URL(safe);
    url.searchParams.set("sandbox_consent", consent);
    if (consent === "granted") url.searchParams.set("sandbox_bank", choice);
    window.location.href = url.toString();
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <div className="card" style={{ padding: 24 }}>
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="pill warn">Demo</span>
            <span className="faint xs">Simulated provider sign-in</span>
          </div>
          <h1 style={{ fontSize: 21 }}>Share your accounts with Aurex</h1>
          <p className="muted small" style={{ margin: "6px 0 16px" }}>
            Pick a demo institution. A real provider would ask you to sign in to your bank here; Aurex never sees that password.
          </p>
          {!safe && <ErrorText error="This link is invalid. Start again from Connections." />}
          <div className="stack-sm" role="radiogroup" aria-label="Demo institution">
            {(banks.data ?? []).map((b) => (
              <label key={b.id} className={`bank-choice ${choice === b.id ? "on" : ""}`}>
                <input type="radio" name="bank" value={b.id} checked={choice === b.id} onChange={() => setChoice(b.id)} />
                <Icon.Bank size={18} />
                <span className="grow"><strong>{b.name}</strong><span className="faint xs"> · {b.country} · {b.accounts} account{b.accounts === 1 ? "" : "s"}</span></span>
              </label>
            ))}
          </div>
          <p className="faint xs" style={{ margin: "14px 0" }}>Aurex will see account names, balances and the last 4 digits. You can disconnect at any time.</p>
          <div className="row">
            <button className="btn grow" disabled={!safe} onClick={() => finish("granted")}>Allow access</button>
            <button className="btn ghost" disabled={!safe} onClick={() => finish("denied")}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
