/**
 * Lightweight in-memory rate limiter (single instance).
 * Good enough for Railway 1-replica; not a CDN WAF replacement.
 */
import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Periodic cleanup to avoid unbounded growth under attack
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  // hard cap
  if (buckets.size > 50_000) {
    const keys = [...buckets.keys()].slice(0, 25_000);
    for (const k of keys) buckets.delete(k);
  }
}, 60_000).unref?.();

export function clientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) {
    return xf.split(",")[0]!.trim().slice(0, 64);
  }
  if (Array.isArray(xf) && xf[0]) return String(xf[0]).slice(0, 64);
  return (req.ip || req.socket.remoteAddress || "unknown").slice(0, 64);
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  /** Extra key suffix (route group) */
  key?: string | ((req: Request) => string);
  message?: string;
  /** Skip limit for these paths */
  skip?: (req: Request) => boolean;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.skip?.(req)) return next();

    const now = Date.now();
    const suffix =
      typeof opts.key === "function"
        ? opts.key(req)
        : opts.key || req.path.slice(0, 80);
    const key = `${clientIp(req)}|${suffix}`;

    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader(
      "X-RateLimit-Reset",
      String(Math.ceil(b.resetAt / 1000))
    );

    if (b.count > opts.max) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((b.resetAt - now) / 1000)))
      );
      return res.status(429).json({
        error: "rate_limited",
        message:
          opts.message ||
          "Слишком много запросов. Подожди немного и попробуй снова.",
      });
    }
    next();
  };
}

/** Per-authenticated-user throttle for expensive AI routes */
export function userRateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const profile = (req as Request & { profile?: { userId?: number } })
      .profile;
    const uid = profile?.userId;
    if (!uid) return next();

    const now = Date.now();
    const key = `u:${uid}|${req.path.slice(0, 60)}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    if (b.count > opts.max) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((b.resetAt - now) / 1000)))
      );
      return res.status(429).json({
        error: "rate_limited",
        message:
          opts.message ||
          "Слишком частые запросы. Подожди немного.",
      });
    }
    next();
  };
}
