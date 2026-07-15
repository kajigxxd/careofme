import type { Request, Response, NextFunction } from "express";

/** Basic security headers (no extra dependency) */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  // Mini App is embedded; keep CSP light so Telegram WebView + fonts work
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://telegram.org https://*.telegram.org",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https:",
      "frame-ancestors https://web.telegram.org https://*.telegram.org 'self'",
      "base-uri 'self'",
      "form-action 'self' https:",
    ].join("; ")
  );
  next();
}

/** Bound request time so slow clients can't hold workers forever */
export function requestTimeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(ms, () => {
      if (!res.headersSent) {
        res.status(408).json({
          error: "timeout",
          message: "Запрос слишком долгий",
        });
      }
      try {
        req.socket.destroy();
      } catch {
        /* ignore */
      }
    });
    next();
  };
}

/** Reject oversized bodies early (defense in depth with express.json limit) */
export function rejectHugePayload(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const cl = req.headers["content-length"];
    if (cl && Number(cl) > maxBytes) {
      return res.status(413).json({ error: "payload_too_large" });
    }
    next();
  };
}
