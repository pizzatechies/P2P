// Turns the Vite output in dist-site/ into a GitHub Pages-ready site:
//  - site.html -> index.html
//  - each page pre-rendered to HTML (from the dist-site-prerender/ build), so the content shows even
//    where JavaScript is off, limited (Opera Mini, data savers) or too old; the script then takes over
//  - a copy per route (features/index.html, ...) with its own <title>, so deep links and refreshes work
//  - 404.html for unknown paths, and .nojekyll so Pages serves files as-is
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const web = join(import.meta.dirname, "..");
const dist = join(web, "dist-site");
const prerenderDir = join(web, "dist-site-prerender");
const { render } = await import(pathToFileURL(join(prerenderDir, "site-prerender.mjs")).href);
const base = (process.env.SITE_BASE ?? "/").replace(/\/+$/, "");

renameSync(join(dist, "site.html"), join(dist, "index.html"));
const shell = readFileSync(join(dist, "index.html"), "utf8");
const ROOT = '<div id="root"></div>';
if (!shell.includes(ROOT)) throw new Error("site.html must contain an empty <div id=\"root\"></div>");
const page = (route, title) => {
  // A replacer function, so "$" in the page text (prices) is inserted as-is, not as a replace pattern.
  const html = shell.replace(ROOT, () => `<div id="root">${render(`${base}/${route}`, base)}</div>`);
  return title ? html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`) : html;
};
writeFileSync(join(dist, "index.html"), page(""));

const routes = {
  features: "Features · Aurex",
  pricing: "Pricing · Aurex",
  security: "Security · Aurex",
  about: "About · Aurex",
  demo: "Demo · Aurex",
};
for (const [route, title] of Object.entries(routes)) {
  mkdirSync(join(dist, route), { recursive: true });
  writeFileSync(join(dist, route, "index.html"), page(route, title));
}
copyFileSync(join(dist, "index.html"), join(dist, "404.html"));
writeFileSync(join(dist, ".nojekyll"), "");
rmSync(prerenderDir, { recursive: true, force: true });
console.log(`Static site ready in ${dist} (${Object.keys(routes).length + 1} pages)`);
