import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll } from "vitest";

/**
 * A local stand-in for a provider's API. It answers with the shapes from the provider's public docs
 * and records what Aurex sent, so both directions of an integration are exercised.
 */
export interface Recorded {
  method: string;
  path: string;
  /** Path without the query string. */
  route: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: any;
}
export type Handler = (req: Recorded) => { status?: number; body?: unknown; text?: string } | undefined;

const servers: Server[] = [];

export async function stub(handler: Handler) {
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://stub");
      let body: unknown;
      if (raw) {
        body = (req.headers["content-type"] ?? "").includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      }
      const rec: Recorded = { method: req.method!, path: req.url!, route: url.pathname, query: url.searchParams, headers: req.headers, body };
      calls.push(rec);
      const out = handler(rec);
      if (!out) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: `stub: no route ${req.method} ${req.url}` }));
        return;
      }
      if (out.text !== undefined) {
        res.writeHead(out.status ?? 200, { "Content-Type": "text/plain" }).end(out.text);
        return;
      }
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" }).end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
