import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { createApiRouter } from "./api";
import { rateLimit } from "./rateLimit";
import {
  securityHeaders,
  requestTimeout,
  rejectHugePayload,
} from "./security";

export function createHttpServer(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestTimeout(60_000));
  app.use(securityHeaders);
  app.use(rejectHugePayload(600 * 1024));

  // Global IP rate limit — blunt DDoS / scrape protection
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 180,
      key: "global",
      message: "Слишком много запросов с этого IP. Подожди минуту.",
      skip: (req) =>
        req.path === "/ping" ||
        req.path.startsWith("/telegram/webhook/") ||
        req.path.startsWith("/payments/cryptopay/"),
    })
  );

  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      max: 90,
      key: "api",
      message: "Слишком много API-запросов. Подожди немного.",
    })
  );

  app.use(
    "/api/auth",
    rateLimit({
      windowMs: 60_000,
      max: 20,
      key: "auth",
      message: "Слишком много попыток входа. Подожди минуту.",
    })
  );
  app.use(
    "/api/plan",
    rateLimit({
      windowMs: 60_000,
      max: 15,
      key: (req) => `plan:${req.method}`,
      message: "Слишком много запросов к оплате.",
    })
  );
  app.use(
    "/api/coach",
    rateLimit({
      windowMs: 60_000,
      max: 30,
      key: "coach-ip",
      message: "Слишком частые сообщения коучу.",
    })
  );

  app.use(
    cors({
      origin: true,
      allowedHeaders: [
        "Content-Type",
        "X-Telegram-Init-Data",
        "Authorization",
        "X-Session-Token",
      ],
      maxAge: 600,
    })
  );

  app.use(
    express.json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    })
  );

  // Minimal health — no env fingerprints
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "careofme",
      ts: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  app.get("/ping", (_req, res) => {
    res.type("text").send("pong");
  });

  // Drop common scanner noise quickly
  app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (
      p.includes("wp-admin") ||
      p.includes("wp-login") ||
      p.includes(".env") ||
      p.includes("phpmyadmin") ||
      p.endsWith(".php") ||
      p.includes("xmlrpc")
    ) {
      return res.status(404).end();
    }
    next();
  });

  app.use("/api", createApiRouter());

  const candidates = [
    path.join(process.cwd(), "webapp"),
    path.join(__dirname, "..", "..", "webapp"),
    path.join(__dirname, "..", "webapp"),
  ];
  const webRoot =
    candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ||
    candidates[0]!;

  if (!fs.existsSync(path.join(webRoot, "index.html"))) {
    console.warn("webapp/index.html not found at", webRoot);
  } else {
    console.log("Mini App static:", webRoot);
  }

  app.use(
    express.static(webRoot, {
      extensions: ["html"],
      maxAge: 0,
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (/\.(js|css|html)$/i.test(filePath)) {
          res.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, proxy-revalidate"
          );
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=600");
        }
      },
    })
  );

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (
      req.path.startsWith("/api") ||
      req.path === "/health" ||
      req.path === "/ping" ||
      req.path.startsWith("/telegram/") ||
      req.path.startsWith("/payments/")
    ) {
      return next();
    }
    const index = path.join(webRoot, "index.html");
    if (!fs.existsSync(index)) {
      return res
        .status(500)
        .type("text")
        .send("Mini App files missing. Ensure webapp/ is deployed.");
    }
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(index);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error("http error", err?.message || err);
      if (res.headersSent) return;
      res.status(500).json({ error: "server_error" });
    }
  );

  return app;
}

export function listenHttp(app: Express, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(` HTTP :${port}`);
      resolve();
    });
    server.maxHeadersCount = 50;
    server.headersTimeout = 30_000;
    server.requestTimeout = 60_000;
    server.keepAliveTimeout = 10_000;
    server.on("error", reject);
  });
}
