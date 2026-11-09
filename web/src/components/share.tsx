import { useState } from "react";
import { money } from "../format";
import { useAuth, useToast } from "../state";
import { CurrencySelect } from "./ui";

export function payLink(handle: string, opts: { amount?: string; currency?: string; note?: string } = {}) {
  const url = new URL(`/pay/@${handle}`, window.location.origin);
  if (opts.amount && Number(opts.amount) > 0) {
    url.searchParams.set("amount", opts.amount);
    url.searchParams.set("currency", opts.currency ?? "USD");
  }
  if (opts.note) url.searchParams.set("note", opts.note.slice(0, 140));
  return url.toString();
}

/** Copy / native share / WhatsApp buttons for a piece of text with a link in it. */
export function ShareButtons({ text, url, title = "Aurex" }: { text: string; url: string; title?: string }) {
  const toast = useToast();
  const full = `${text} ${url}`;
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn secondary sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast("Link copied");
          } catch {
            toast("Couldn't copy. Select the link and copy it manually.", "error");
          }
        }}
      >
        Copy link
      </button>
      {typeof navigator.share === "function" && (
        <button type="button" className="btn secondary sm" onClick={() => navigator.share({ title, text, url }).catch(() => undefined)}>
          Share…
        </button>
      )}
      <a className="btn sm wa" href={`https://wa.me/?text=${encodeURIComponent(full)}`} target="_blank" rel="noopener noreferrer">
        WhatsApp
      </a>
    </div>
  );
}

/** "Your pay link": lets anyone, even without an account, pay you from a link. */
export function PayLinkCard() {
  const { user } = useAuth();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [note, setNote] = useState("");
  if (!user) return null;
  const url = payLink(user.handle, { amount, currency, note });
  const text = amount
    ? `Please pay me ${money(amount, currency)}${note ? ` for ${note}` : ""} on Aurex:`
    : `Pay me on Aurex:`;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Your pay link</h2>
          <p className="muted small" style={{ marginTop: 4 }}>Anyone can pay you from this link, even if they're not on Aurex yet. They'll sign up in a minute and land right on your payment.</p>
        </div>
      </div>
      <div className="grid grid-3" style={{ marginBottom: 12 }}>
        <label className="field">
          Amount (optional)
          <div className="input-group">
            <input className="input num" inputMode="decimal" placeholder="Any amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>
        </label>
        <label className="field span-2">
          What's it for? (optional)
          <input className="input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Rent, tickets, dinner…" />
        </label>
      </div>
      <div className="pay-link mono small">{url}</div>
      <div className="row wrap between" style={{ marginTop: 10 }}>
        <ShareButtons text={text} url={url} title="Pay me on Aurex" />
        <ShareButtons text="Join me on Aurex: send money, use every AI and trade with an AI analyst." url={new URL("/register", window.location.origin).toString()} title="Join Aurex" />
      </div>
    </div>
  );
}
