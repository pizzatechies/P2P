/** True in the static marketing-site build (GitHub Pages), where there is no API server. */
export const STATIC_SITE = import.meta.env.VITE_STATIC_SITE === "1";
/** Where the live app is hosted, for links from the static site (e.g. https://aurex.up.railway.app). */
export const APP_URL = ((import.meta.env.VITE_APP_URL as string | undefined) ?? "").replace(/\/+$/, "");
