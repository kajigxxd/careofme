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

export type InitDataFailReason =
  | "empty"
  | "no_token"
  | "no_hash"
  | "bad_hash"
  | "expired"
  | "no_user"
  | "parse_error";

export type ValidateInitResult =
  | { ok: true; data: ValidatedInitData }
  | { ok: false; reason: InitDataFailReason };

/**
 * Validates Telegram Mini App initData (HMAC-SHA-256).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitDataDetailed(
  initData: string,
  botToken: string,
  // Mini App can stay open a long time on phones — 7 days is still safe
  maxAgeSec = 7 * 24 * 60 * 60
): ValidateInitResult {
  if (!initData) return { ok: false, reason: "empty" };
  if (!botToken) return { ok: false, reason: "no_token" };

  try {
    // Some clients / proxies decode once; accept both raw and encoded forms
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, reason: "no_hash" };

    // All fields except hash, sorted alphabetically (Telegram WebApp rules)
    const entries: [string, string][] = [];
    params.forEach((value, key) => {
      if (key === "hash") return;
      entries.push([key, value]);
    });
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    // timing-safe compare (hex strings)
    let hashOk = false;
    try {
      const hashBuf = Buffer.from(hash, "utf8");
      const calcBuf = Buffer.from(calculated, "utf8");
      hashOk =
        hashBuf.length === calcBuf.length &&
        crypto.timingSafeEqual(hashBuf, calcBuf);
    } catch {
      hashOk = false;
    }

    if (!hashOk) {
      // Dev fallback: allow unsigned only if explicitly enabled
      if (process.env.WEBAPP_DEV_SKIP_AUTH === "1") {
        const loose = parseLoose(params);
        if (loose) return { ok: true, data: loose };
      }
      return { ok: false, reason: "bad_hash" };
    }

    const authDate = Number(params.get("auth_date") || 0);
    if (maxAgeSec > 0 && authDate) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > maxAgeSec) return { ok: false, reason: "expired" };
    }

    const userRaw = params.get("user");
    if (!userRaw) return { ok: false, reason: "no_user" };
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (!user?.id) return { ok: false, reason: "no_user" };

    const raw: Record<string, string> = {};
    params.forEach((v, k) => {
      raw[k] = v;
    });

    return {
      ok: true,
      data: {
        user,
        authDate,
        queryId: params.get("query_id") || undefined,
        raw,
      },
    };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 7 * 24 * 60 * 60
): ValidatedInitData | null {
  const r = validateInitDataDetailed(initData, botToken, maxAgeSec);
  return r.ok ? r.data : null;
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
