import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon } from "../components/icons";
import { ThemeButton } from "../components/Layout";
import { Logo } from "../components/Logo";
import { useAuth } from "../state";
import { AppLink } from "./common";

const LINKS = [
  { to: "/features", label: "Features" },
  { to: "/pricing", label: "Pricing" },
  { to: "/security", label: "Security" },
  { to: "/about", label: "About" },
];

export function SiteLayout() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();

  useEffect(() => {
    setOpen(false);
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
    else window.scrollTo({ top: 0 });
  }, [pathname, hash]);

  return (
    <div className="site">
      <header className="site-header">
        <div className="site-container site-header-inner">
          <Link to="/" className="brand" style={{ padding: 0 }} aria-label="Aurex home">
            <Logo size={32} />
            <span>Aurex</span>
          </Link>
          <nav className="site-nav" aria-label="Site">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "active" : "")}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="row site-actions">
            <ThemeButton />
            {user ? (
              <AppLink className="btn" to="/app">Open app</AppLink>
            ) : (
              <>
                <AppLink className="btn ghost hide-sm" to="/login">Sign in</AppLink>
                <AppLink className="btn" to="/register" fallback={<span className="pill brand">Launching soon</span>}>Get started</AppLink>
              </>
            )}
            <button className="btn ghost icon-btn menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? <Icon.X /> : <span className="burger" aria-hidden="true"><i /><i /><i /></span>}
            </button>
          </div>
        </div>
        {open && (
          <nav className="mobile-menu" aria-label="Site">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to}>{l.label}</NavLink>
            ))}
            {!user && <AppLink to="/login">Sign in</AppLink>}
          </nav>
        )}
      </header>

      <main>
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="site-container">
          <div className="footer-grid">
            <div className="footer-brand">
              <Link to="/" className="brand" style={{ padding: 0 }}>
                <Logo size={30} />
                <span>Aurex</span>
              </Link>
              <p className="muted small">Money, AI and markets in one place. Send and request money worldwide, use every major AI model, and trade with an AI analyst that waits for your go-ahead.</p>
            </div>
            <div>
              <h4>Product</h4>
              <Link to="/features#payments">Payments</Link>
              <Link to="/features#ai">AI Hub</Link>
              <Link to="/features#trading">AI trading</Link>
              <Link to="/pricing">Pricing</Link>
            </div>
            <div>
              <h4>Trust</h4>
              <Link to="/security">Security</Link>
              <Link to="/security#disclosures">Risk disclosures</Link>
              <Link to="/about">About Aurex</Link>
            </div>
            <div>
              <h4>Account</h4>
              {user ? <AppLink to="/app">Dashboard</AppLink> : <AppLink to="/register" fallback={<span className="faint small">Launching soon</span>}>Create account</AppLink>}
              {!user && <AppLink to="/login">Sign in</AppLink>}
              <AppLink to={user ? "/app/settings" : "/login"}>Settings</AppLink>
            </div>
          </div>
          <div className="footer-legal">
            <p>
              Aurex currently runs in sandbox mode: deposits and withdrawals use test money until a licensed payment partner is connected.
              AI-generated trading signals are educational decision aids, not financial advice. Investing involves risk, including loss of principal.
            </p>
            <p>© {new Date().getFullYear()} Aurex</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
