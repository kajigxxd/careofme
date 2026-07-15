/**
 * Telegram Crypto Pay API (@CryptoBot)
 * https://help.send.tg/en/articles/10279948-crypto-pay-api
 */
import crypto from "crypto";
import {
  CRYPTO_ACCEPTED_ASSETS,
  PLAN_PRICES_RUB,
  PLAN_TITLES,
  buildInvoicePayload,
  type PaidPlan,
} from "./plans";
import { resolveWebAppUrl } from "../config";

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
    throw new Error(data.error || `CryptoPay ${method} failed`);
  }
  return data.result;
}

export async function cryptoPayGetMe(): Promise<unknown> {
  return apiCall("getMe");
}

export async function createPlanInvoice(opts: {
  userId: number;
  plan: PaidPlan;
  botUsername?: string;
}): Promise<CryptoInvoice> {
  const amount = PLAN_PRICES_RUB[opts.plan];
  const title = PLAN_TITLES[opts.plan];
  const webapp = resolveWebAppUrl() || "https://t.me";
  const botUser = opts.botUsername || process.env.BOT_USERNAME || "careofme_bot";

  const invoice = await apiCall<CryptoInvoice>("createInvoice", {
    currency_type: "fiat",
    fiat: "RUB",
    amount: String(amount),
    accepted_assets: CRYPTO_ACCEPTED_ASSETS,
    swap_to: "USDT",
    description: `careofme · тариф «${title}» · ${amount} ₽ / 30 дней`,
    hidden_message: `Оплата прошла! Тариф «${title}» активирован в @${botUser}. Открой /start.`,
    payload: buildInvoicePayload(opts.userId, opts.plan),
    paid_btn_name: "openBot",
    paid_btn_url: `https://t.me/${botUser}`,
    allow_comments: false,
    allow_anonymous: false,
    expires_in: 3600,
  });

  // Prefer mini app URL when inside Telegram
  if (!invoice.bot_invoice_url && invoice.pay_url) {
    invoice.bot_invoice_url = invoice.pay_url;
  }
  if (!invoice.mini_app_invoice_url) {
    invoice.mini_app_invoice_url = invoice.bot_invoice_url;
  }

  void webapp; // reserved for paid_btn if needed
  return invoice;
}

export async function getInvoice(invoiceId: number): Promise<CryptoInvoice | null> {
  const list = await apiCall<CryptoInvoice[]>("getInvoices", {
    invoice_ids: String(invoiceId),
  });
  return list[0] || null;
}

/**
 * Verify Crypto Pay webhook signature.
 * secret = SHA256(app_token), hmac = HMAC-SHA256(secret, rawBody)
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
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, "utf8"),
      Buffer.from(signatureHeader, "utf8")
    );
  } catch {
    return hmac === signatureHeader;
  }
}

export type CryptoPayUpdate = {
  update_id: number;
  update_type: string;
  request_date: string;
  payload: CryptoInvoice;
};
