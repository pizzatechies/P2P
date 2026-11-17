import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, ToastProvider } from "../state";
import { AboutPage } from "./About";
import { DemoPage } from "./Demo";
import { FeaturesPage } from "./Features";
import { HomePage } from "./Home";
import { PricingPage } from "./Pricing";
import { SecurityPage } from "./Security";
import { SiteLayout } from "./SiteLayout";

/** The static website's pages. Rendered in the browser and, at build time, to HTML for each route. */
export function SiteApp() {
  return (
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
  );
}
