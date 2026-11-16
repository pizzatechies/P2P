import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AboutPage } from "./site/About";
import { DemoPage } from "./site/Demo";
import { FeaturesPage } from "./site/Features";
import { HomePage } from "./site/Home";
import { PricingPage } from "./site/Pricing";
import { SecurityPage } from "./site/Security";
import { SiteLayout } from "./site/SiteLayout";
import { applyTheme, AuthProvider, ToastProvider } from "./state";
import "./styles.css";

// Static marketing website (GitHub Pages). Same pages as the app's public site, no API.
try {
  applyTheme(localStorage.getItem("aurex-theme") === "dark" ? "dark" : "light");
} catch {
  applyTheme("light");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
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
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
