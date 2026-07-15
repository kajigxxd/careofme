import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { createApiRouter } from "./api";

export function createHttpServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: true,
      allowedHeaders: ["Content-Type", "X-Telegram-Init-Data"],
    })
  );
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "berezhno",
      ts: new Date().toISOString(),
      hasBotToken: Boolean(process.env.BOT_TOKEN),
      hasWebappUrl: Boolean(
        process.env.WEBAPP_URL ||
          process.env.RENDER_EXTERNAL_URL ||
          process.env.RAILWAY_PUBLIC_DOMAIN
      ),
    });
  });

  app.use("/api", createApiRouter());

  // Resolve webapp both from cwd (dev) and next to dist (production)
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

  app.use(
    express.static(webRoot, {
      extensions: ["html"],
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    })
  );

  // SPA fallback (Express 5 compatible — no bare «*»)
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    const index = path.join(webRoot, "index.html");
    if (!fs.existsSync(index)) {
      return res
        .status(500)
        .type("text")
        .send("Mini App files missing. Ensure webapp/ is deployed.");
    }
    res.sendFile(index);
  });

  return app;
}

export function startHttpServer(port: number) {
  const app = createHttpServer();
  return new Promise<{ port: number }>((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`🌐 HTTP :${port}`);
      resolve({ port });
    });
    server.on("error", reject);
  });
}
