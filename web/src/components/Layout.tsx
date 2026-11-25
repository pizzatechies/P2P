import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { initials } from "../format";
import { useInstall, useOnline } from "../pwa";
import { useAuth, useTheme, type Theme } from "../state";
import { Icon } from "./icons";
import { Logo } from "./Logo";

interface NavItem {
  to: string;
  label: string;
  icon: (typeof Icon)[keyof typeof Icon];
  end?: boolean;
  /** Stays in the bar on phones; the rest are under the menu button. */
  top?: boolean;
}

const NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: Icon.Home, end: true, top: true },
  { to: "/app/wallet", label: "Wallet", icon: Icon.Wallet, top: true },
  { to: "/app/connections", label: "Connections", icon: Icon.Link },
  { to: "/app/payments", label: "Payments", icon: Icon.Send, top: true },
  { to: "/app/card", label: "Card", icon: Icon.Card, top: true },
  { to: "/app/ai", label: "AI Hub", icon: Icon.Sparkle },
  { to: "/app/trading", label: "Trading", icon: Icon.Chart, top: true },
  { to: "/app/learn", label: "Learn", icon: Icon.Learn },
  { to: "/app/settings", label: "Settings", icon: Icon.Settings },
  { to: "/app/help", label: "Help", icon: Icon.Mail },
];

const linkClass = (extra: string) => ({ isActive }: { isActive: boolean }) => `${extra}${isActive ? " active" : ""}`;

export function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next: Theme = theme === "light" ? "dark" : "light";
  const ThemeIcon = theme === "light" ? Icon.Moon : Icon.Sun;
  return (
    <button className="btn ghost icon-btn" onClick={() => setTheme(next)} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}>
      <ThemeIcon />
    </button>
  );
}

export function Layout() {
  const { user, logout, meta } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const install = useInstall();
  const online = useOnline();
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  // The phone menu closes when a page is picked, on Escape, and if the window grows past phone size.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const wide = window.matchMedia("(min-width: 861px)");
    const onWide = () => wide.matches && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [menuOpen]);

  if (!user) return null;
  const extra: NavItem[] = [
    ...(meta?.pro ? [{ to: "/app/pro", label: "Aurex Pro", icon: Icon.Sparkle }] : []),
    ...(user.role === "admin" ? [{ to: "/app/admin", label: "Admin", icon: Icon.Admin }] : []),
  ];
  const signOut = async () => {
    await logout();
    navigate("/");
  };
  const nextTheme: Theme = theme === "light" ? "dark" : "light";
  const ThemeIcon = theme === "light" ? Icon.Moon : Icon.Sun;
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/app" className="brand" aria-label="Aurex home">
          <Logo size={30} />
          <span>Aurex</span>
        </NavLink>
        <nav style={{ display: "contents" }} aria-label="Main">
          {[...NAV, ...extra].map(({ to, label, icon: I, end, top }) => (
            <NavLink key={to} to={to} end={end} className={linkClass(`nav-link${top ? "" : " in-menu"}`)} title={label}>
              <I />
              <span className="label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <button
          className={`btn ghost icon-btn nav-menu-btn${menuOpen ? " open" : ""}`}
          aria-label={menuOpen ? "Close menu" : "More"}
          aria-expanded={menuOpen}
          aria-controls="app-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <Icon.X /> : (
            <span className="burger" aria-hidden="true"><i /><i /><i /></span>
          )}
        </button>
        <div className="sidebar-foot">
          <NavLink to="/app/account" className="user-chip" title="Your account" style={{ color: "inherit", textDecoration: "none" }}>
            <span className="avatar">{initials(user.displayName)}</span>
            <div className="who grow">
              <div style={{ fontWeight: 600, fontSize: 14 }}>{user.displayName}</div>
              <div className="faint xs">@{user.handle} · Account</div>
            </div>
          </NavLink>
          <div className="row" style={{ gap: 4 }}>
            {install.kind === "prompt" && (
              <button className="btn ghost icon-btn" title="Install Aurex as an app" aria-label="Install Aurex as an app" onClick={install.install}>
                <Icon.ArrowDown />
              </button>
            )}
            <ThemeButton />
            <button className="btn ghost icon-btn" title="Sign out" aria-label="Sign out" onClick={signOut}>
              <Icon.Logout />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="app-menu" className="app-menu" aria-label="More">
            <NavLink to="/app/account" className={linkClass("app-menu-item user")}>
              <span className="avatar">{initials(user.displayName)}</span>
              <span className="grow">
                <span className="menu-name">{user.displayName}</span>
                <span className="faint xs">@{user.handle} · Account</span>
              </span>
            </NavLink>
            <div className="app-menu-grid">
              {[...NAV.filter((n) => !n.top), ...extra].map(({ to, label, icon: I }) => (
                <NavLink key={to} to={to} className={linkClass("app-menu-item")}>
                  <I />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
            <div className="app-menu-foot">
              {install.kind === "prompt" && (
                <button className="app-menu-item" onClick={install.install}>
                  <Icon.ArrowDown />
                  <span>Install app</span>
                </button>
              )}
              <button className="app-menu-item" onClick={() => setTheme(nextTheme)}>
                <ThemeIcon />
                <span>{nextTheme === "dark" ? "Dark theme" : "Light theme"}</span>
              </button>
              <button className="app-menu-item" onClick={signOut}>
                <Icon.Logout />
                <span>Sign out</span>
              </button>
            </div>
          </nav>
        )}
      </aside>
      {menuOpen && <div className="app-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <main className="main">
        {!online && (
          <div className="banner" role="status">
            You're offline. Balances and prices may be out of date, and payments will work again when you reconnect.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
