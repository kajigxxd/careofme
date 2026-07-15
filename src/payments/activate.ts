import { store } from "../db/store";
import { getInvoice, isCryptoPayConfigured } from "./cryptopay";
import {
  PLAN_DURATION_DAYS,
  parseInvoicePayload,
  type PaidPlan,
} from "./plans";

export async function checkPendingPayments(userId: number): Promise<boolean> {
  const user = store.getUser(userId);
  if (!user?.pendingInvoices?.length || !isCryptoPayConfigured()) {
    const u = store.getUser(userId);
    return u ? store.isPremium(u) : false;
  }

  for (const pend of [...user.pendingInvoices]) {
    try {
      if (store.hasPaidInvoice(userId, pend.invoiceId)) {
        store.activatePlan(userId, pend.plan, PLAN_DURATION_DAYS, {
          invoiceId: pend.invoiceId,
        });
        return true;
      }
      const inv = await getInvoice(pend.invoiceId);
      if (inv?.status === "paid") {
        store.activatePlan(userId, pend.plan, PLAN_DURATION_DAYS, {
          invoiceId: pend.invoiceId,
          amount: inv.amount,
          asset: inv.fiat || (inv as { paid_asset?: string }).paid_asset,
        });
        return true;
      }
    } catch (e) {
      console.warn("check invoice", pend.invoiceId, e);
    }
  }
  return store.isPremium(store.getUser(userId)!);
}

export function applyPaidInvoice(opts: {
  invoiceId: number;
  payload?: string;
  amount?: string;
  asset?: string;
}): { ok: boolean; userId?: number; plan?: PaidPlan } {
  const parsed = parseInvoicePayload(opts.payload);
  if (!parsed) return { ok: false };
  if (store.hasPaidInvoice(parsed.userId, opts.invoiceId)) {
    return { ok: true, userId: parsed.userId, plan: parsed.plan };
  }
  if (!store.getUser(parsed.userId)) {
    store.getOrCreateUser({
      userId: parsed.userId,
      chatId: parsed.userId,
    });
  }
  store.activatePlan(parsed.userId, parsed.plan, PLAN_DURATION_DAYS, {
    invoiceId: opts.invoiceId,
    amount: opts.amount,
    asset: opts.asset,
  });
  return { ok: true, userId: parsed.userId, plan: parsed.plan };
}
