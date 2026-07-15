import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { createApiRouter } from "./api";

export function createHttpServer(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: true,
      allowedHeaders: ["Content-Type", "X-Telegram-Init-Data"],
    })
  );
  // Keep raw body for Crypto Pay signature verification
  app.use(
    express.json({
      limit: "512kb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    })
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "careofme",
      ts: new Date().toISOString(),
      hasBotToken: Boolean(process.env.BOT_TOKEN),
      hasWebappUrl: Boolean(
        process.env.WEBAPP_URL ||
          process.env.RENDER_EXTERNAL_URL ||
          process.env.RAILWAY_PUBLIC_DOMAIN ||
          process.env.FLY_APP_NAME
      ),
      hasXai: Boolean(process.env.XAI_API_KEY),
      hasCryptoPay: Boolean(process.env.CRYPTO_PAY_TOKEN),
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  // Keep-alive for free tiers that sleep
  app.get("/ping", (_req, res) => {
    res.type("text").send("pong");
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
    console.warn("⚠ webapp/index.html not found at", webRoot);
  } else {
    console.log("📂 Mini App static:", webRoot);
  }

  // No long browser/WebView cache — Telegram Desktop on macOS keeps stale app.js for hours
  app.use(
    express.static(webRoot, {
      extensions: ["html"],
      maxAge: 0,
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (/\.(js|css|html)$/i.test(filePath)) {
          res.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, proxy-revalidate"
          );
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=300");
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

  return app;
}

export function listenHttp(app: Express, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`🌐 HTTP :${port}`);
      resolve();
    });
    server.on("error", reject);
  });
}
