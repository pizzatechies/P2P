import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AccountPage } from "./pages/Account";
import { AdminPage } from "./pages/Admin";
import { AdminUserPage } from "./pages/AdminUser";
import { StatementPage } from "./pages/Statement";
import { TradingRecordsPage } from "./pages/TradingRecords";
import { ProPage } from "./pages/Pro";
import { AdminLedgerPage } from "./pages/AdminLedger";
import { AIHubPage } from "./pages/AIHub";
import { ConnectionsPage, ConnectSandboxPage } from "./pages/Connections";
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from "./pages/Auth";
import { DashboardPage } from "./pages/Dashboard";
import { PayPage } from "./pages/Pay";
import { PaymentsPage } from "./pages/Payments";
import { SettingsPage } from "./pages/Settings";
import { TradingPage } from "./pages/Trading";
import { WalletPage } from "./pages/Wallet";
import { AboutPage } from "./site/About";
import { DemoPage } from "./site/Demo";
import { FeaturesPage } from "./site/Features";
import { HomePage } from "./site/Home";
import { PricingPage } from "./site/Pricing";
import { SecurityPage } from "./site/Security";
import { FeesPage, LegalPage } from "./site/Legal";
import { SiteLayout } from "./site/SiteLayout";
import { setupPwa } from "./pwa";
import { applyTheme, AuthProvider, ToastProvider, useAuth } from "./state";
import { ReauthProvider } from "./components/reauth";
import { LearnPage } from "./pages/Learn";
import { UpgradePage } from "./pages/Upgrade";
import "./styles.css";

try {
  const saved = localStorage.getItem("aurex-theme");
  applyTheme(saved === "dark" ? "dark" : "light");
} catch {
  /* storage unavailable */
}

setupPwa();

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-wrap"><span className="spinner" aria-label="Loading" /></div>;
  if (!user && !navigator.onLine) {
    // Offline we can't confirm the session, so don't bounce the user to the login page.
    return (
      <div className="auth-wrap">
        <div className="card auth-card" style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 22 }}>You're offline</h1>
          <p className="muted small" style={{ margin: "8px 0 16px" }}>Aurex needs a connection to show your balances and keep your money safe.</p>
          <button className="btn block" onClick={() => window.location.reload()}>Try again</button>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  // Use the router's location, not window.location: right after sign-in the address bar may already
  // show the destination while this component renders one last time.
  const location = useLocation();
  if (loading) return <div className="auth-wrap"><span className="spinner" aria-label="Loading" /></div>;
  if (user) {
    const next = new URLSearchParams(location.search).get("next");
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={next && next.startsWith("/") && !next.startsWith("//") ? next : (from ?? "/app")} replace />;
  }
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <ReauthProvider>
          <Routes>
            <Route element={<SiteLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/features" element={<FeaturesPage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/terms" element={<LegalPage doc="terms" />} />
              <Route path="/privacy" element={<LegalPage doc="privacy" />} />
              <Route path="/complaints" element={<LegalPage doc="complaints" />} />
              <Route path="/risk" element={<LegalPage doc="risk" />} />
              <Route path="/fees" element={<FeesPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/demo" element={<DemoPage />} />
            </Route>
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
            <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/pay/:handle" element={<PayPage />} />
            <Route path="/connect/sandbox" element={<RequireAuth><ConnectSandboxPage /></RequireAuth>} />
            <Route path="/app" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<DashboardPage />} />
              <Route path="wallet" element={<WalletPage />} />
              <Route path="connections" element={<ConnectionsPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="ai" element={<AIHubPage />} />
              <Route path="trading" element={<TradingPage />} />
              <Route path="learn" element={<LearnPage />} />
              <Route path="upgrade" element={<UpgradePage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<AdminPage />} />
              <Route path="admin/users/:id" element={<AdminUserPage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="statement" element={<StatementPage />} />
              <Route path="trading/records" element={<TradingRecordsPage />} />
              <Route path="pro" element={<ProPage />} />
              <Route path="admin/ledger" element={<AdminLedgerPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ReauthProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
