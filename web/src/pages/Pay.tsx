import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Logo } from "../components/Logo";
import { SendDialog } from "../components/money";
import { payLink, ShareButtons } from "../components/share";
import { initials, money } from "../format";
import { useAuth } from "../state";
import type { Profile } from "../types";

/** Public page behind a shareable pay link: /pay/@handle?amount=10&currency=USD&note=Dinner */
export function PayPage() {
  const { handle: raw = "" } = useParams();
  const handle = raw.replace(/^@/, "");
  const [params] = useSearchParams();
  const location = useLocation();
  const { user, loading } = useAuth();
  const [payee, setPayee] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);

  const amount = params.get("amount") ?? "";
  const currency = (params.get("currency") ?? "USD").toUpperCase();
  const note = params.get("note") ?? "";
  const next = encodeURIComponent(location.pathname + location.search);

  useEffect(() => {
    document.title = `Pay @${handle} · Aurex`;
    api
      .get<{ user: Profile }>(`/api/public/users/${encodeURIComponent(handle)}`)
      .then((r) => setPayee(r.user))
      .catch(() => setMissing(true));
  }, [handle]);

  const isMe = user && payee && user.id === payee.id;

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <Link to="/" className="brand" style={{ justifyContent: "center", padding: "0 0 18px" }}>
          <Logo size={30} />
          <span>Aurex</span>
        </Link>
        <div className="card pay-card">
          {missing ? (
            <>
              <h1 style={{ fontSize: 22 }}>This pay link isn't valid</h1>
              <p className="muted small">Ask the person who sent it for a new link.</p>
              <Link className="btn block" to="/">Go to Aurex</Link>
            </>
          ) : !payee || loading ? (
            <div className="skeleton" style={{ height: 160 }} />
          ) : (
            <>
              <span className="avatar pay-avatar">{initials(payee.displayName)}</span>
              <div className="muted small">{isMe ? "This is your pay link" : "You're paying"}</div>
              <h1 style={{ fontSize: 24 }}>{payee.displayName}</h1>
              <div className="faint">@{payee.handle}</div>
              {amount && <div className="pay-amount num">{money(amount, currency)}</div>}
              {note && <div className="pill brand" style={{ margin: "4px auto 0" }}>{note}</div>}

              {paid ? (
                <div className="stack" style={{ marginTop: 18 }}>
                  <div className="pill good" style={{ margin: "0 auto" }}>✓ Payment sent</div>
                  <Link className="btn block" to="/app">Go to your dashboard</Link>
                </div>
              ) : isMe ? (
                <div className="stack" style={{ marginTop: 18 }}>
                  <p className="small muted">Share it and anyone can pay you{amount ? ` ${money(amount, currency)}` : ""}.</p>
                  <ShareButtons text={amount ? `Please pay me ${money(amount, currency)}${note ? ` for ${note}` : ""} on Aurex:` : "Pay me on Aurex:"} url={payLink(payee.handle, { amount, currency, note })} />
                </div>
              ) : user ? (
                <button className="btn block lg" style={{ marginTop: 18 }} onClick={() => setPaying(true)}>
                  {amount ? `Pay ${money(amount, currency)}` : "Choose amount and pay"}
                </button>
              ) : (
                <div className="stack" style={{ marginTop: 18 }}>
                  <Link className="btn block lg" to={`/register?next=${next}`}>Create a free account to pay</Link>
                  <Link className="btn block secondary" to={`/login?next=${next}`}>I already have an account</Link>
                  <p className="faint xs">Takes about a minute. You'll come straight back to this payment.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {paying && payee && (
        <SendDialog
          initialTo={`@${payee.handle}`}
          initialAmount={amount}
          initialCurrency={currency}
          initialMemo={note}
          onClose={() => setPaying(false)}
          onDone={() => setPaid(true)}
        />
      )}
    </div>
  );
}
