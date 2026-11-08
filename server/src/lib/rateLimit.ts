import type { NextFunction, Request, Response } from "express";
import { tooMany } from "./errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small fixed-window, in-memory rate limiter. Good for a single instance; put a shared store
 * (e.g. Redis) behind the same interface before running multiple replicas.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string; name: string }) {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, opts.windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${opts.key ? opts.key(req) : req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - bucket.count)));
    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(tooMany());
    }
    next();
  };
}
