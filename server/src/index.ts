import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startReconciler } from "./services/payments.js";
import { startAutopilotScheduler } from "./services/trading/autopilot.js";

const config = loadConfig();
const { app, ctx } = createApp(config);
const stopAutopilot = startAutopilotScheduler(ctx);
const stopReconciler = startReconciler(ctx);

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[aurex] API listening on http://${config.HOST === "0.0.0.0" ? "localhost" : config.HOST}:${config.PORT} (${config.NODE_ENV})`);
  console.log(`[aurex] payment rails: ${config.rails.join(", ") || "none"} | live trading: ${config.ALLOW_LIVE_TRADING ? "ENABLED" : "disabled"} | autopilot: ${config.AUTOPILOT_ENABLED ? (config.ALLOW_LIVE_AUTOPILOT ? "on (live allowed)" : "on (paper only)") : "off"}`);
  if (!config.MASTER_KEY) console.warn("[aurex] MASTER_KEY not set - using an insecure development key.");
  if (config.isProd && !config.TRUST_PROXY) console.warn("[aurex] TRUST_PROXY is off: behind a proxy, rate limits and lockout alerts will see the proxy's IP.");
});

function shutdown(signal: string) {
  console.log(`[aurex] ${signal} received, shutting down`);
  stopAutopilot();
  stopReconciler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
