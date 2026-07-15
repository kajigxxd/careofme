export type PaidPlan = "care" | "plus";

/** Subscription length options */
export type PlanPeriod = "7d" | "30d" | "90d" | "180d";

export const PLAN_PERIODS: Record<
  PlanPeriod,
  { days: number; label: string; labelShort: string }
> = {
  "7d": { days: 7, label: "7 дней", labelShort: "7д" },
  "30d": { days: 30, label: "30 дней", labelShort: "30д" },
  "90d": { days: 90, label: "3 месяца", labelShort: "3м" },
  "180d": { days: 180, label: "6 месяцев", labelShort: "6м" },
};

export const ALL_PLAN_PERIODS: PlanPeriod[] = ["7d", "30d", "90d", "180d"];

/**
 * Prices in RUB by plan and period.
 * 6 months: not specified by product owner — set with bulk discount vs 2× quarterly.
 */
export const PLAN_PRICES_RUB: Record<PaidPlan, Record<PlanPeriod, number>> = {
  care: {
    "7d": 89,
    "30d": 199,
    "90d": 499,
    "180d": 899,
  },
  plus: {
    "7d": 119,
    "30d": 349,
    "90d": 849,
    "180d": 1549,
  },
};

/** @deprecated use planPriceRub(plan, period) — kept as 30d default for display */
export const PLAN_MONTHLY_RUB: Record<PaidPlan, number> = {
  care: PLAN_PRICES_RUB.care["30d"],
  plus: PLAN_PRICES_RUB.plus["30d"],
};

/**
 * Fixed RUB per 1 USDT for crypto invoices.
 * Override with env CRYPTO_RUB_PER_USDT if needed.
 */
export function rubPerUsdt(): number {
  const n = Number(process.env.CRYPTO_RUB_PER_USDT || 81);
  return Number.isFinite(n) && n > 0 ? n : 81;
}

export function isPlanPeriod(v: unknown): v is PlanPeriod {
  return (
    v === "7d" || v === "30d" || v === "90d" || v === "180d"
  );
}

export function planPriceRub(plan: PaidPlan, period: PlanPeriod = "30d"): number {
  return PLAN_PRICES_RUB[plan][period];
}

export function periodDays(period: PlanPeriod): number {
  return PLAN_PERIODS[period].days;
}

/** USDT amount for plan+period at fixed rate (rounded up to 2 decimals, min 0.01) */
export function planPriceUsdt(
  plan: PaidPlan,
  period: PlanPeriod = "30d"
): string {
  const rub = planPriceRub(plan, period);
  const rate = rubPerUsdt();
  const usdt = rub / rate;
  const cents = Math.ceil(usdt * 100 - 1e-9) / 100;
  return Math.max(0.01, cents).toFixed(2);
}

export function planPriceLabel(
  plan: PaidPlan,
  period: PlanPeriod = "30d"
): string {
  const rub = planPriceRub(plan, period);
  const usdt = planPriceUsdt(plan, period);
  const label = PLAN_PERIODS[period].label;
  return `${rub} ₽ / ${label} ≈ ${usdt} USDT (курс ${rubPerUsdt()} ₽)`;
}

/** Default paid period when omitted */
export const PLAN_DURATION_DAYS = 30;
export const DEFAULT_PLAN_PERIOD: PlanPeriod = "30d";

/** Free trial length for care / plus (once per plan type) */
export const TRIAL_DAYS = 3;

export const PLAN_TITLES: Record<PaidPlan, string> = {
  care: "Забота",
  plus: "Плюс",
};

/** Catalog for Mini App /me */
export function planCatalog() {
  return (["care", "plus"] as PaidPlan[]).map((plan) => ({
    id: plan,
    title: PLAN_TITLES[plan],
    periods: ALL_PLAN_PERIODS.map((period) => ({
      id: period,
      days: PLAN_PERIODS[period].days,
      label: PLAN_PERIODS[period].label,
      priceRub: planPriceRub(plan, period),
      priceUsdt: planPriceUsdt(plan, period),
      priceLabel: `${planPriceRub(plan, period)} ₽`,
    })),
  }));
}

/** Primary settlement asset at fixed rate */
export const CRYPTO_INVOICE_ASSET = "USDT";

export function buildInvoicePayload(
  userId: number,
  plan: PaidPlan,
  period: PlanPeriod = "30d"
): string {
  const days = periodDays(period);
  return JSON.stringify({
    u: userId,
    p: plan,
    d: days,
    per: period,
    t: Date.now(),
    app: "careofme",
    rub: planPriceRub(plan, period),
    rate: rubPerUsdt(),
    usdt: planPriceUsdt(plan, period),
  });
}

export function parseInvoicePayload(
  payload?: string | null
): { userId: number; plan: PaidPlan; days: number; period: PlanPeriod } | null {
  if (!payload) return null;
  try {
    const data = JSON.parse(payload) as {
      u?: number;
      p?: string;
      d?: number;
      per?: string;
    };
    if (!data.u || (data.p !== "care" && data.p !== "plus")) return null;
    let period: PlanPeriod = "30d";
    if (isPlanPeriod(data.per)) period = data.per;
    else if (typeof data.d === "number") {
      if (data.d <= 10) period = "7d";
      else if (data.d <= 45) period = "30d";
      else if (data.d <= 120) period = "90d";
      else period = "180d";
    }
    const days =
      typeof data.d === "number" && data.d > 0
        ? data.d
        : periodDays(period);
    return {
      userId: Number(data.u),
      plan: data.p,
      days,
      period,
    };
  } catch {
    const [u, p, d] = payload.split(":");
    if (!u || (p !== "care" && p !== "plus")) return null;
    const days = d ? Number(d) : 30;
    return {
      userId: Number(u),
      plan: p,
      days: Number.isFinite(days) && days > 0 ? days : 30,
      period: "30d",
    };
  }
}
