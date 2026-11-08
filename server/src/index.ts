import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createApp(config);

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[p2p-hub] API listening on http://${config.HOST === "0.0.0.0" ? "localhost" : config.HOST}:${config.PORT} (${config.NODE_ENV})`);
  console.log(`[p2p-hub] payment rails: ${config.rails.join(", ") || "none"} | live trading: ${config.ALLOW_LIVE_TRADING ? "ENABLED" : "disabled"}`);
  if (!config.MASTER_KEY) console.warn("[p2p-hub] MASTER_KEY not set - using an insecure development key.");
});

function shutdown(signal: string) {
  console.log(`[p2p-hub] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
