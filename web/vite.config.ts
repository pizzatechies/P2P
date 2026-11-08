import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  // `vite build --mode site` builds the static marketing website (GitHub Pages) into dist-site/.
  if (mode === "site") {
    return {
      plugins: [react()],
      base: process.env.SITE_BASE ?? "/",
      define: { "import.meta.env.VITE_STATIC_SITE": JSON.stringify("1") },
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
