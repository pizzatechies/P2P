import type { Response } from "express";

/** Opens a Server-Sent Events response. Returns a writer and an AbortSignal that fires if the client goes away. */
export function openSse(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx)
  res.flushHeaders();

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  return {
    signal: controller.signal,
    send(event: string, data: unknown) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
