import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SiteApp } from "./site/SiteApp";
import { applyTheme } from "./state";
import "./styles.css";

// Static marketing website (GitHub Pages). Same pages as the app's public site, no API.
// Each page's HTML is also pre-rendered at build time (site-prerender.tsx), so it shows even where
// JavaScript is off or limited; when the script runs, it takes over from that HTML.
try {
  applyTheme(localStorage.getItem("aurex-theme") === "dark" ? "dark" : "light");
} catch {
  applyTheme("light");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <SiteApp />
    </BrowserRouter>
  </StrictMode>,
);
