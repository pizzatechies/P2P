import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { initials } from "../format";
import { useInstall, useOnline } from "../pwa";
import { useAuth, useTheme, type Theme } from "../state";
import { Icon } from "./icons";
import { Logo } from "./Logo";

const NAV = [
  { to: "/app", label: "Dashboard", icon: Icon.Home, end: true },
  { to: "/app/wallet", label: "Wallet", icon: Icon.Wallet },
  { to: "/app/payments", label: "Payments", icon: Icon.Send },
  { to: "/app/ai", label: "AI Hub", icon: Icon.Sparkle },
  { to: "/app/trading", label: "Trading", icon: Icon.Chart },
  { to: "/app/settings", label: "Settings", icon: Icon.Settings },
];

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
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const install = useInstall();
  const online = useOnline();
  if (!user) return null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/app" className="brand" aria-label="Aurex home">
          <Logo size={30} />
          <span>Aurex</span>
        </NavLink>
        <nav style={{ display: "contents" }} aria-label="Main">
          {NAV.map(({ to, label, icon: I, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} title={label}>
              <I />
              <span className="label">{label}</span>
            </NavLink>
          ))}
          {user.role === "admin" && (
            <NavLink to="/app/admin" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} title="Admin">
              <Icon.Admin />
              <span className="label">Admin</span>
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="avatar">{initials(user.displayName)}</span>
            <div className="who grow">
              <div style={{ fontWeight: 600, fontSize: 14 }}>{user.displayName}</div>
              <div className="faint xs">@{user.handle}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 4 }}>
            {install.kind === "prompt" && (
              <button className="btn ghost icon-btn" title="Install Aurex as an app" aria-label="Install Aurex as an app" onClick={install.install}>
                <Icon.ArrowDown />
              </button>
            )}
            <ThemeButton />
            <button
              className="btn ghost icon-btn"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await logout();
                navigate("/");
              }}
            >
              <Icon.Logout />
            </button>
          </div>
        </div>
      </aside>
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
