import crypto from "crypto";

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramWebAppUser;
  authDate: number;
  queryId?: string;
  raw: Record<string, string>;
}

/**
 * Validates Telegram Mini App initData (HMAC-SHA-256).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(
  initData: string,
  botToken: string,
  // Mini App can stay open a long time on phones — 7 days is still safe
  maxAgeSec = 7 * 24 * 60 * 60
): ValidatedInitData | null {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    const entries: [string, string][] = [];
    params.forEach((value, key) => {
      if (key !== "hash") entries.push([key, value]);
    });
    entries.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculated !== hash) {
      // Dev fallback: allow unsigned only if explicitly enabled
      if (process.env.WEBAPP_DEV_SKIP_AUTH === "1") {
        return parseLoose(params);
      }
      return null;
    }

    const authDate = Number(params.get("auth_date") || 0);
    if (maxAgeSec > 0 && authDate) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > maxAgeSec) return null;
    }

    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (!user?.id) return null;

    const raw: Record<string, string> = {};
    params.forEach((v, k) => {
      raw[k] = v;
    });

    return {
      user,
      authDate,
      queryId: params.get("query_id") || undefined,
      raw,
    };
  } catch {
    return null;
  }
}

function parseLoose(params: URLSearchParams): ValidatedInitData | null {
  try {
    const userRaw = params.get("user");
    if (!userRaw) {
      // browser preview without Telegram
      return {
        user: { id: 1, first_name: "Гость" },
        authDate: Math.floor(Date.now() / 1000),
        raw: {},
      };
    }
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    return {
      user,
      authDate: Number(params.get("auth_date") || 0),
      raw: {},
    };
  } catch {
    return null;
  }
}
