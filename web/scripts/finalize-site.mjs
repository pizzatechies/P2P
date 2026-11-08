// Turns the Vite output in dist-site/ into a GitHub Pages-ready site:
//  - site.html -> index.html
//  - a copy per route (features/index.html, ...) with its own <title>, so deep links and refreshes work
//  - 404.html for unknown paths, and .nojekyll so Pages serves files as-is
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "dist-site");
renameSync(join(dist, "site.html"), join(dist, "index.html"));
const shell = readFileSync(join(dist, "index.html"), "utf8");

const routes = {
  features: "Features · Aurex",
  pricing: "Pricing · Aurex",
  security: "Security · Aurex",
  about: "About · Aurex",
};
for (const [route, title] of Object.entries(routes)) {
  mkdirSync(join(dist, route), { recursive: true });
  writeFileSync(join(dist, route, "index.html"), shell.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`));
}
copyFileSync(join(dist, "index.html"), join(dist, "404.html"));
writeFileSync(join(dist, ".nojekyll"), "");
console.log(`Static site ready in ${dist} (${Object.keys(routes).length + 1} pages)`);
