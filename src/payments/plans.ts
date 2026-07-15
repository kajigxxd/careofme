export type PaidPlan = "care" | "plus";

export const PLAN_PRICES_RUB: Record<PaidPlan, number> = {
  care: 199,
  plus: 349,
};

export const PLAN_DURATION_DAYS = 30;

export const PLAN_TITLES: Record<PaidPlan, string> = {
  care: "Забота",
  plus: "Плюс",
};

/** Assets accepted for fiat invoices (Crypto Pay). */
export const CRYPTO_ACCEPTED_ASSETS = "USDT,TON,BTC,ETH,LTC,TRX,USDC";

export function buildInvoicePayload(
  userId: number,
  plan: PaidPlan
): string {
  return JSON.stringify({
    u: userId,
    p: plan,
    t: Date.now(),
    app: "careofme",
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
    // legacy: userId:plan
    const [u, p] = payload.split(":");
    if (!u || (p !== "care" && p !== "plus")) return null;
    return { userId: Number(u), plan: p };
  }
}
