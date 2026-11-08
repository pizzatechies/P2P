import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { initials } from "../format";
import { useAuth, useTheme, type Theme } from "../state";
import { Icon } from "./icons";

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
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = theme === "light" ? Icon.Sun : theme === "dark" ? Icon.Moon : Icon.Monitor;
  return (
    <button
      className="btn ghost icon-btn"
      onClick={() => setTheme(next[theme])}
      title={`Theme: ${theme} (click to change)`}
      aria-label={`Theme: ${theme}. Change theme`}
    >
      <ThemeIcon />
    </button>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/app" className="brand" aria-label="P2P Hub home">
          <span className="brand-mark">
            <Icon.Swap size={17} />
          </span>
          <span>P2P Hub</span>
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
        <Outlet />
      </main>
    </div>
  );
}
