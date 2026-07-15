/**
 * Runtime configuration — local + Render / Railway / Fly / any PaaS.
 */

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Public HTTPS origin of the Mini App (no trailing slash). */
export function resolveWebAppUrl(): string | undefined {
  const explicit = process.env.WEBAPP_URL?.trim();
  if (explicit) return stripSlash(explicit);

  if (process.env.RENDER_EXTERNAL_URL) {
    return stripSlash(process.env.RENDER_EXTERNAL_URL);
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return stripSlash(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }

  // Railway sometimes sets this
  if (process.env.RAILWAY_STATIC_URL) {
    return stripSlash(process.env.RAILWAY_STATIC_URL);
  }

  if (process.env.FLY_APP_NAME) {
    return stripSlash(`https://${process.env.FLY_APP_NAME}.fly.dev`);
  }

  if (process.env.KOYEB_PUBLIC_DOMAIN) {
    const d = process.env.KOYEB_PUBLIC_DOMAIN;
    return stripSlash(d.startsWith("http") ? d : `https://${d}`);
  }

  if (process.env.PUBLIC_URL) {
    return stripSlash(process.env.PUBLIC_URL);
  }

  return undefined;
}

export function resolvePort(): number {
  const n = Number(process.env.PORT || 8787);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

export function resolveDataPath(): string {
  if (process.env.DATA_PATH) return process.env.DATA_PATH;
  if (
    process.env.RENDER ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.FLY_APP_NAME ||
    process.env.NODE_ENV === "production"
  ) {
    return "/tmp/careofme-store.json";
  }
  return "./data/store.json";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Use Telegram webhook in production when we have a public HTTPS URL. */
export function shouldUseWebhook(): boolean {
  if (process.env.USE_WEBHOOK === "0") return false;
  if (process.env.USE_WEBHOOK === "1") return true;
  return isProduction() && Boolean(resolveWebAppUrl());
}

export function webhookSecretPath(): string {
  const token = process.env.BOT_TOKEN || "x";
  // Stable path segment derived from token (not the full secret)
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  }
  return `wh_${Math.abs(h).toString(36)}`;
}
