import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { SiteApp } from "./site/SiteApp";

/** Renders one website page to HTML at build time (see scripts/finalize-site.mjs). */
export function render(url: string, basename: string) {
  return renderToString(
    <StaticRouter location={url} basename={basename || "/"}>
      <SiteApp />
    </StaticRouter>,
  );
}
