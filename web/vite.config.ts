import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The iOS and Android apps bundle their pages, so the server's headers don't apply to them: the
 * security policy goes in a <meta> tag instead, allowing exactly the Aurex server the app talks to.
 */
function appHtml(apiOrigin: string): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://web-models.smileidentity.com https://js.stripe.com",
    "script-src-attr 'none'",
    `connect-src 'self' ${apiOrigin} https://web-models.smileidentity.com https://cdn.jsdelivr.net https://unpkg.com https://api.stripe.com data:`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src https://challenges.cloudflare.com https://js.stripe.com",
    "worker-src 'self' blob:",
  ].join("; ");
  return {
    name: "aurex-app-html",
    transformIndexHtml: (html) =>
      html
        // Draw under the notch and home indicator; the app pads for them (see html.native in styles.css).
        .replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"')
        .replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
        // No web manifest or service worker inside the app.
        .replace(/\s*<link rel="manifest"[^>]*>/, ""),
  };
}

export default defineConfig(({ mode }) => {
  // `vite build --mode app` builds the pages bundled into the iOS and Android apps (dist-app/).
  if (mode === "app") {
    const apiOrigin = new URL(process.env.AUREX_API_ORIGIN ?? "https://aurex.dpdns.org").origin;
    return {
      plugins: [react(), appHtml(apiOrigin)],
      base: "/",
      define: { "import.meta.env.VITE_API_ORIGIN": JSON.stringify(apiOrigin) },
      build: { outDir: "dist-app", emptyOutDir: true, sourcemap: false },
    };
  }
  // `vite build --mode site` builds the static marketing website (GitHub Pages) into dist-site/.
  if (mode === "site") {
    const shared = {
      plugins: [react()],
      base: process.env.SITE_BASE ?? "/",
      define: { "import.meta.env.VITE_STATIC_SITE": JSON.stringify("1") },
    };
    // SITE_PRERENDER=1: a Node build of the same pages, used once to write each page's HTML.
    if (process.env.SITE_PRERENDER === "1") {
      return {
        ...shared,
        build: {
          outDir: "dist-site-prerender",
          emptyOutDir: true,
          ssr: resolve(import.meta.dirname, "src/site-prerender.tsx"),
          rollupOptions: { output: { entryFileNames: "[name].mjs" } },
        },
      };
    }
    return {
      ...shared,
      build: { outDir: "dist-site", emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, "site.html") } },
    };
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: "http://localhost:4000", changeOrigin: false },
      },
    },
    build: { outDir: "dist", sourcemap: true },
  };
});
