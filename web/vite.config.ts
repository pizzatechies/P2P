import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
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
