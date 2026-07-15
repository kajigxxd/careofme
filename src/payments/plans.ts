export type PaidPlan = "care" | "plus";

export const PLAN_PRICES_RUB: Record<PaidPlan, number> = {
  care: 199,
  plus: 349,
};

/**
 * Fixed RUB per 1 USDT for crypto invoices.
 * Override with env CRYPTO_RUB_PER_USDT if needed.
 */
export function rubPerUsdt(): number {
  const n = Number(process.env.CRYPTO_RUB_PER_USDT || 81);
  return Number.isFinite(n) && n > 0 ? n : 81;
}

/** USDT amount for plan at fixed rate (rounded up to 2 decimals, min 0.01) */
export function planPriceUsdt(plan: PaidPlan): string {
  const rub = PLAN_PRICES_RUB[plan];
  const rate = rubPerUsdt();
  const usdt = rub / rate;
  // round UP to 2 decimals so we never undercharge vs 199/349 ₽ at 81
  const cents = Math.ceil(usdt * 100 - 1e-9) / 100;
  return Math.max(0.01, cents).toFixed(2);
}

export function planPriceLabel(plan: PaidPlan): string {
  const rub = PLAN_PRICES_RUB[plan];
  const usdt = planPriceUsdt(plan);
  return `${rub} ₽ ≈ ${usdt} USDT (курс ${rubPerUsdt()} ₽)`;
}

export const PLAN_DURATION_DAYS = 30;

export const PLAN_TITLES: Record<PaidPlan, string> = {
  care: "Забота",
  plus: "Плюс",
};

/** Primary settlement asset at fixed rate */
export const CRYPTO_INVOICE_ASSET = "USDT";

export function buildInvoicePayload(
  userId: number,
  plan: PaidPlan
): string {
  return JSON.stringify({
    u: userId,
    p: plan,
    t: Date.now(),
    app: "careofme",
    rub: PLAN_PRICES_RUB[plan],
    rate: rubPerUsdt(),
    usdt: planPriceUsdt(plan),
  });
}

export function parseInvoicePayload(
  payload?: string | null
): { userId: number; plan: PaidPlan } | null {
  if (!payload) return null;
  try {
    const data = JSON.parse(payload) as { u?: number; p?: string };
    if (!data.u || (data.p !== "care" && data.p !== "plus")) return null;
    return { userId: Number(data.u), plan: data.p };
  } catch {
    const [u, p] = payload.split(":");
    if (!u || (p !== "care" && p !== "plus")) return null;
    return { userId: Number(u), plan: p };
  }
}
