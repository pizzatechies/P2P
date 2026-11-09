import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AdminPage } from "./pages/Admin";
import { AIHubPage } from "./pages/AIHub";
import { LoginPage, RegisterPage } from "./pages/Auth";
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
import { SiteLayout } from "./site/SiteLayout";
import { setupPwa } from "./pwa";
import { applyTheme, AuthProvider, ToastProvider, useAuth } from "./state";
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
          <Routes>
            <Route element={<SiteLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/features" element={<FeaturesPage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/demo" element={<DemoPage />} />
            </Route>
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
            <Route path="/pay/:handle" element={<PayPage />} />
            <Route path="/app" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<DashboardPage />} />
              <Route path="wallet" element={<WalletPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="ai" element={<AIHubPage />} />
              <Route path="trading" element={<TradingPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<AdminPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
