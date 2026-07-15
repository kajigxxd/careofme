/**
 * Telegram Crypto Pay API (@CryptoBot)
 * https://help.send.tg/en/articles/10279948-crypto-pay-api
 */
import crypto from "crypto";
import {
  CRYPTO_INVOICE_ASSET,
  PLAN_PRICES_RUB,
  PLAN_TITLES,
  buildInvoicePayload,
  planPriceLabel,
  planPriceUsdt,
  rubPerUsdt,
  type PaidPlan,
} from "./plans";

const MAINNET = "https://pay.crypt.bot/api";
const TESTNET = "https://testnet-pay.crypt.bot/api";

export interface CryptoInvoice {
  invoice_id: number;
  hash: string;
  status: string;
  amount: string;
  bot_invoice_url?: string;
  mini_app_invoice_url?: string;
  web_app_invoice_url?: string;
  pay_url?: string;
  payload?: string;
  description?: string;
  fiat?: string;
  paid_asset?: string;
  paid_amount?: string;
}

function baseUrl(): string {
  return process.env.CRYPTO_PAY_TESTNET === "1" ? TESTNET : MAINNET;
}

export function isCryptoPayConfigured(): boolean {
  return Boolean(process.env.CRYPTO_PAY_TOKEN?.trim());
}

async function apiCall<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const token = process.env.CRYPTO_PAY_TOKEN?.trim();
  if (!token) throw new Error("CRYPTO_PAY_TOKEN not set");

  const res = await fetch(`${baseUrl()}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Crypto-Pay-API-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as {
    ok: boolean;
    result?: T;
    error?: string;
  };
  if (!data.ok || data.result === undefined) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : JSON.stringify(data.error || `CryptoPay ${method} failed`)
    );
  }
  return data.result;
}

export async function cryptoPayGetMe(): Promise<unknown> {
  return apiCall("getMe");
}

export function invoicePayUrl(inv: CryptoInvoice): string {
  return (
    inv.bot_invoice_url ||
    inv.pay_url ||
    inv.mini_app_invoice_url ||
    inv.web_app_invoice_url ||
    (inv.hash ? `https://t.me/CryptoBot?start=${inv.hash}` : "")
  );
}

export async function createPlanInvoice(opts: {
  userId: number;
  plan: PaidPlan;
  botUsername?: string;
}): Promise<CryptoInvoice> {
  const rub = PLAN_PRICES_RUB[opts.plan];
  const usdt = planPriceUsdt(opts.plan);
  const title = PLAN_TITLES[opts.plan];
  const botUser =
    opts.botUsername || process.env.BOT_USERNAME || "careofme_bot";
  const rate = rubPerUsdt();

  // Fixed RUB→USDT rate: invoice in USDT (ASCII description avoids rare API quirks)
  const invoice = await apiCall<CryptoInvoice>("createInvoice", {
    currency_type: "crypto",
    asset: CRYPTO_INVOICE_ASSET,
    amount: usdt,
    description: `careofme ${title} ${rub} RUB = ${usdt} USDT (rate ${rate}) 30d`,
    hidden_message: `Paid. Plan ${title} active in @${botUser}.`,
    payload: buildInvoicePayload(opts.userId, opts.plan),
    paid_btn_name: "openBot",
    paid_btn_url: `https://t.me/${botUser}`,
    allow_comments: false,
    allow_anonymous: false,
    expires_in: 3600,
  });

  console.log(
    `Invoice ${opts.plan}: ${planPriceLabel(opts.plan)} → ${usdt} ${CRYPTO_INVOICE_ASSET}`
  );
  return invoice;
}

export async function getInvoice(
  invoiceId: number
): Promise<CryptoInvoice | null> {
  try {
    const list = await apiCall<CryptoInvoice[]>("getInvoices", {
      invoice_ids: String(invoiceId),
      count: 1,
    });
    if (Array.isArray(list) && list.length) return list[0]!;
    return null;
  } catch (e) {
    console.warn("getInvoice failed", invoiceId, e);
    return null;
  }
}

/**
 * Verify Crypto Pay webhook signature.
 * secret = SHA256(app_token), hmac = HMAC-SHA256(secret, rawBody) hex
 */
export function verifyCryptoPaySignature(
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  const token = process.env.CRYPTO_PAY_TOKEN?.trim();
  if (!token || !signatureHeader) return false;
  const secret = crypto.createHash("sha256").update(token).digest();
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(hmac, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return hmac === signatureHeader.trim();
  return crypto.timingSafeEqual(a, b);
}

export type CryptoPayUpdate = {
  update_id: number;
  update_type: string;
  request_date: string;
  payload: CryptoInvoice;
};
