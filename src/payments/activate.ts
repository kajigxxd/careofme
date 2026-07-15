import { store } from "../db/store";
import { getInvoice, isCryptoPayConfigured } from "./cryptopay";
import {
  PLAN_DURATION_DAYS,
  parseInvoicePayload,
  type PaidPlan,
} from "./plans";

/** Activate plan from a paid Crypto Pay invoice (idempotent). */
export function applyPaidInvoice(opts: {
  invoiceId: number;
  payload?: string;
  amount?: string;
  asset?: string;
}): { ok: boolean; userId?: number; plan?: PaidPlan; days?: number; already?: boolean } {
  const parsed = parseInvoicePayload(opts.payload);
  if (!parsed) {
    console.warn("applyPaidInvoice: bad payload", opts.payload);
    return { ok: false };
  }

  if (!store.getUser(parsed.userId)) {
    store.getOrCreateUser({
      userId: parsed.userId,
      chatId: parsed.userId,
    });
  }

  const days = parsed.days || PLAN_DURATION_DAYS;

  if (store.hasPaidInvoice(parsed.userId, opts.invoiceId)) {
    const u = store.getUser(parsed.userId)!;
    if (!store.isPremium(u) || u.plan !== parsed.plan) {
      store.activatePlan(parsed.userId, parsed.plan, days, {
        invoiceId: opts.invoiceId,
        amount: opts.amount,
        asset: opts.asset,
      });
    }
    return {
      ok: true,
      userId: parsed.userId,
      plan: parsed.plan,
      days,
      already: true,
    };
  }

  store.activatePlan(parsed.userId, parsed.plan, days, {
    invoiceId: opts.invoiceId,
    amount: opts.amount,
    asset: opts.asset,
  });
  return {
    ok: true,
    userId: parsed.userId,
    plan: parsed.plan,
    days,
  };
}

/** Check specific invoice or all pending for user. */
export async function checkPendingPayments(
  userId: number,
  invoiceId?: number
): Promise<boolean> {
  if (!isCryptoPayConfigured()) {
    const u = store.getUser(userId);
    return u ? store.isPremium(u) : false;
  }

  const ids: number[] = [];
  if (invoiceId && Number.isFinite(invoiceId) && invoiceId > 0) {
    ids.push(invoiceId);
  }
  const user = store.getUser(userId);
  for (const p of user?.pendingInvoices || []) {
    if (!ids.includes(p.invoiceId)) ids.push(p.invoiceId);
  }

  for (const id of ids) {
    try {
      if (store.hasPaidInvoice(userId, id)) {
        const pend = user?.pendingInvoices?.find((x) => x.invoiceId === id);
        const plan = pend?.plan;
        const days = pend?.days || PLAN_DURATION_DAYS;
        if (plan) {
          store.activatePlan(userId, plan, days, {
            invoiceId: id,
          });
        }
        return store.isPremium(store.getUser(userId)!);
      }

      const inv = await getInvoice(id);
      if (!inv) continue;
      if (inv.status !== "paid") continue;

      const result = applyPaidInvoice({
        invoiceId: id,
        payload: inv.payload,
        amount: inv.paid_amount || inv.amount,
        asset: inv.paid_asset || inv.fiat,
      });
      if (!result.ok) {
        const pend = store
          .getUser(userId)
          ?.pendingInvoices?.find((x) => x.invoiceId === id);
        if (pend) {
          store.activatePlan(
            userId,
            pend.plan,
            pend.days || PLAN_DURATION_DAYS,
            {
              invoiceId: id,
              amount: inv.amount,
              asset: inv.paid_asset || inv.fiat,
            }
          );
          return true;
        }
      } else if (result.userId === userId || !result.userId) {
        return store.isPremium(store.getUser(userId)!);
      }
    } catch (e) {
      console.warn("check invoice", id, e);
    }
  }

  const u = store.getUser(userId);
  return u ? store.isPremium(u) : false;
}
