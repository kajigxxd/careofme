/**
 * YooKassa (ЮKassa / ЮMoney) — payments in RUB
 * Docs: https://yookassa.ru/developers/api
 *
 * Env:
 *   YOOKASSA_SHOP_ID
 *   YOOKASSA_SECRET_KEY
 * Optional aliases: YOOMONEY_SHOP_ID / YOOMONEY_SECRET_KEY
 */
import crypto from "crypto";
import {
  PLAN_PERIODS,
  PLAN_TITLES,
  planPriceRub,
  type PaidPlan,
  type PlanPeriod,
  DEFAULT_PLAN_PERIOD,
  isPlanPeriod,
  periodDays,
} from "./plans";
import { resolveWebAppUrl } from "../config";

const API = "https://api.yookassa.ru/v3";

export type YooPaymentStatus =
  | "pending"
  | "waiting_for_capture"
  | "succeeded"
  | "canceled";

export interface YooPayment {
  id: string;
  status: YooPaymentStatus;
  paid?: boolean;
  amount: { value: string; currency: string };
  description?: string;
  metadata?: Record<string, string>;
  confirmation?: {
    type: string;
    confirmation_url?: string;
  };
  created_at?: string;
}

function shopId(): string {
  return (
    process.env.YOOKASSA_SHOP_ID?.trim() ||
    process.env.YOOMONEY_SHOP_ID?.trim() ||
    ""
  );
}

function secretKey(): string {
  return (
    process.env.YOOKASSA_SECRET_KEY?.trim() ||
    process.env.YOOMONEY_SECRET_KEY?.trim() ||
    ""
  );
}

export function isYooKassaConfigured(): boolean {
  return Boolean(shopId() && secretKey());
}

function authHeader(): string {
  const token = Buffer.from(`${shopId()}:${secretKey()}`).toString("base64");
  return `Basic ${token}`;
}

async function yooFetch<T>(
  path: string,
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    idempotenceKey?: string;
  } = {}
): Promise<T> {
  if (!isYooKassaConfigured()) {
    throw new Error("YooKassa not configured (YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY)");
  }
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    "Content-Type": "application/json",
  };
  if (opts.idempotenceKey) {
    headers["Idempotence-Key"] = opts.idempotenceKey;
  }
  const res = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json()) as T & {
    type?: string;
    description?: string;
    code?: string;
  };
  if (!res.ok) {
    throw new Error(
      (data as { description?: string }).description ||
        `YooKassa ${path} failed: ${res.status}`
    );
  }
  return data;
}

export async function createYooPayment(opts: {
  userId: number;
  plan: PaidPlan;
  period?: PlanPeriod;
  returnUrl?: string;
}): Promise<{ payment: YooPayment; payUrl: string; amountRub: number; days: number }> {
  const period: PlanPeriod = isPlanPeriod(opts.period)
    ? opts.period
    : DEFAULT_PLAN_PERIOD;
  const rub = planPriceRub(opts.plan, period);
  const days = periodDays(period);
  const title = PLAN_TITLES[opts.plan];
  const periodLabel = PLAN_PERIODS[period].label;

  const base =
    opts.returnUrl ||
    resolveWebAppUrl() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://t.me/careofme_bot");

  // After pay user returns to Mini App / site
  const returnUrl = base.includes("?")
    ? `${base}&paid=1&plan=${opts.plan}`
    : `${base.replace(/\/$/, "")}/?paid=1&plan=${opts.plan}`;

  const idempotenceKey = crypto.randomUUID();
  const payment = await yooFetch<YooPayment>("/payments", {
    method: "POST",
    idempotenceKey,
    body: {
      amount: {
        value: rub.toFixed(2),
        currency: "RUB",
      },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: returnUrl,
      },
      description: `careofme «${title}» · ${periodLabel} · ${rub} ₽`,
      metadata: {
        userId: String(opts.userId),
        plan: opts.plan,
        period,
        days: String(days),
        app: "careofme",
      },
      // Prefer Russian methods: bank card, YooMoney wallet, SberPay etc.
      // Empty = all methods enabled in shop settings
    },
  });

  const payUrl = payment.confirmation?.confirmation_url;
  if (!payUrl) {
    throw new Error("YooKassa payment has no confirmation_url");
  }

  console.log(
    `YooKassa payment ${payment.id}: ${opts.plan}/${period} ${rub} RUB user=${opts.userId}`
  );

  return { payment, payUrl, amountRub: rub, days };
}

export async function getYooPayment(paymentId: string): Promise<YooPayment | null> {
  try {
    return await yooFetch<YooPayment>(`/payments/${encodeURIComponent(paymentId)}`);
  } catch (e) {
    console.warn("getYooPayment", paymentId, e);
    return null;
  }
}

/** Parse notification body from YooKassa webhook */
export function parseYooNotification(body: unknown): {
  event: string;
  payment: YooPayment | null;
} {
  const b = body as {
    event?: string;
    object?: YooPayment;
  };
  return {
    event: b.event || "",
    payment: b.object || null,
  };
}
