import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AdminPage } from "./pages/Admin";
import { AIHubPage } from "./pages/AIHub";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { DashboardPage } from "./pages/Dashboard";
import { LandingPage } from "./pages/Landing";
import { PaymentsPage } from "./pages/Payments";
import { SettingsPage } from "./pages/Settings";
import { TradingPage } from "./pages/Trading";
import { WalletPage } from "./pages/Wallet";
import { applyTheme, AuthProvider, ToastProvider, useAuth } from "./state";
import "./styles.css";

try {
  const saved = localStorage.getItem("aurex-theme");
  applyTheme(saved === "dark" ? "dark" : "light");
} catch {
  /* storage unavailable */
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-wrap"><span className="spinner" aria-label="Loading" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-wrap"><span className="spinner" aria-label="Loading" /></div>;
  if (user) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
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
