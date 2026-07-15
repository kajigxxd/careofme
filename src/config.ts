/**
 * Runtime configuration — works locally and on Render / Railway / Fly / any PaaS.
 */

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Public HTTPS origin of the Mini App (no trailing slash). */
export function resolveWebAppUrl(): string | undefined {
  const explicit = process.env.WEBAPP_URL?.trim();
  if (explicit) return stripSlash(explicit);

  // Render
  if (process.env.RENDER_EXTERNAL_URL) {
    return stripSlash(process.env.RENDER_EXTERNAL_URL);
  }

  // Railway
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return stripSlash(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }

  // Fly.io
  if (process.env.FLY_APP_NAME) {
    return stripSlash(`https://${process.env.FLY_APP_NAME}.fly.dev`);
  }

  // Generic
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
  // Ephemeral but writable on most PaaS free tiers
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME) {
    return "/tmp/berezhno-store.json";
  }
  return "./data/store.json";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
