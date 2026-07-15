import { Router, type Request, type Response, type NextFunction } from "express";
import { store, type FocusArea, type MoodScore } from "../db/store";
import { validateInitData } from "./auth";
import {
  PRACTICES,
  getPractice,
  recommendPractice,
} from "../data/practices";
import {
  FOCUS_LABELS,
  PLANS,
  pickJournalPrompt,
  STRESS_SOURCES,
  DISCLAIMER,
} from "../data/prompts";
import { coachReply, weeklyInsight, isAiConfigured } from "../ai/client";
import {
  createPlanInvoice,
  getInvoice,
  isCryptoPayConfigured,
} from "../payments/cryptopay";
import { PLAN_DURATION_DAYS, type PaidPlan } from "../payments/plans";
import { checkPendingPayments } from "../payments/activate";

function getToken() {
  return process.env.BOT_TOKEN || "";
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const initData =
    (req.header("x-telegram-init-data") as string) ||
    (req.body?.initData as string) ||
    (req.query.initData as string) ||
    "";

  // Browser preview without Telegram
  if (!initData && process.env.WEBAPP_DEV_SKIP_AUTH === "1") {
    const user = store.getOrCreateUser({
      userId: 1,
      chatId: 1,
      firstName: "Гость",
    });
    (req as any).tgUser = { id: 1, first_name: "Гость" };
    (req as any).profile = user;
    return next();
  }

  const validated = validateInitData(initData, getToken());
  if (!validated) {
    return res.status(401).json({ error: "invalid_init_data" });
  }

  const profile = store.getOrCreateUser({
    userId: validated.user.id,
    chatId: validated.user.id,
    username: validated.user.username,
    firstName: validated.user.first_name,
  });

  (req as any).tgUser = validated.user;
  (req as any).profile = profile;
  next();
}

function asScore(n: unknown): MoodScore | null {
  const v = Number(n);
  if (v >= 1 && v <= 5) return v as MoodScore;
  return null;
}

export function createApiRouter(): Router {
  const router = Router();
  router.use(authMiddleware);

  router.get("/me", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const quota = store.canUseCoach(profile);
    const stats = store.weekStats(profile);
    res.json({
      user: {
        id: profile.userId,
        firstName: profile.firstName,
        username: profile.username,
      },
      onboardingDone: profile.onboardingDone,
      focusAreas: profile.focusAreas,
      plan: profile.plan || "free",
      premium,
      premiumUntil: profile.premiumUntil,
      streak: profile.streak,
      stats,
      coachQuota: quota,
      disclaimer: DISCLAIMER,
      focusLabels: FOCUS_LABELS,
      plans: PLANS,
      stressSources: STRESS_SOURCES,
      aiConfigured: isAiConfigured(),
      cryptoPayConfigured: isCryptoPayConfigured(),
    });
  });

  router.post("/onboarding", (req, res) => {
    const profile = (req as any).profile;
    const areas = (req.body?.focusAreas || []) as FocusArea[];
    const allowed: FocusArea[] = ["burnout", "anxiety", "insomnia", "general"];
    const focusAreas = areas.filter((a) => allowed.includes(a));
    const updated = store.updateUser(profile.userId, {
      focusAreas: focusAreas.length ? focusAreas : ["general"],
      onboardingDone: true,
    });
    res.json({ ok: true, focusAreas: updated.focusAreas });
  });

  router.post("/checkin", (req, res) => {
    const profile = (req as any).profile;
    const mood = asScore(req.body?.mood);
    const energy = asScore(req.body?.energy);
    const stress = asScore(req.body?.stress);
    const sleep = req.body?.sleep != null ? asScore(req.body.sleep) : undefined;
    const note =
      typeof req.body?.note === "string"
        ? req.body.note.slice(0, 500)
        : undefined;

    if (!mood || !energy || !stress) {
      return res.status(400).json({ error: "mood_energy_stress_required" });
    }

    const updated = store.addCheckin(profile.userId, {
      mood,
      energy,
      stress,
      sleep: sleep || undefined,
      note,
    });

    res.json({
      ok: true,
      streak: updated.streak,
      checkin: updated.checkins[0],
      stats: store.weekStats(updated),
    });
  });

  router.get("/practices", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    res.json({
      practices: PRACTICES.map((p) => ({
        id: p.id,
        title: p.title,
        emoji: p.emoji,
        kind: p.kind,
        durationMin: p.durationMin,
        focus: p.focus,
        free: p.free,
        locked: !p.free && !premium,
        intro: p.intro,
      })),
      premium,
    });
  });

  router.get("/practices/:id", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const p = getPractice(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    if (!p.free && !premium) {
      return res.status(403).json({ error: "premium_required", practice: { id: p.id, title: p.title } });
    }
    res.json({ practice: p });
  });

  router.get("/practices-recommend", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const last = profile.checkins[0];
    const p = recommendPractice(
      profile.focusAreas,
      last?.mood,
      last?.stress,
      !premium
    );
    res.json({ practice: p });
  });

  router.post("/practices/:id/done", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const p = getPractice(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    if (!p.free && !premium) {
      return res.status(403).json({ error: "premium_required" });
    }
    store.addPractice(profile.userId, p.id, p.title, p.durationMin * 60);
    res.json({ ok: true });
  });

  router.post("/stress", (req, res) => {
    const profile = (req as any).profile;
    const level = asScore(req.body?.level);
    if (!level) return res.status(400).json({ error: "level_required" });
    const source =
      typeof req.body?.source === "string"
        ? req.body.source.slice(0, 80)
        : undefined;
    const note =
      typeof req.body?.note === "string"
        ? req.body.note.slice(0, 500)
        : undefined;
    store.addStress(profile.userId, level, source, note);
    res.json({ ok: true, stats: store.weekStats(store.getUser(profile.userId)!) });
  });

  router.get("/journal/prompt", (_req, res) => {
    res.json({ prompt: pickJournalPrompt() });
  });

  router.post("/journal", (req, res) => {
    const profile = (req as any).profile;
    const text =
      typeof req.body?.text === "string" ? req.body.text.slice(0, 4000) : "";
    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.slice(0, 300)
        : "Свободная запись";
    if (!text.trim()) return res.status(400).json({ error: "text_required" });
    store.addJournal(profile.userId, prompt, text);
    res.json({ ok: true });
  });

  router.post("/coach", async (req, res) => {
    const profile = (req as any).profile;
    const text =
      typeof req.body?.text === "string" ? req.body.text.slice(0, 2000) : "";
    if (!text.trim()) return res.status(400).json({ error: "text_required" });

    const quota = store.canUseCoach(profile);
    if (!quota.ok) {
      return res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        remaining: 0,
      });
    }

    store.pushCoachMessage(profile.userId, "user", text);
    store.consumeCoach(profile.userId);
    const fresh = store.getUser(profile.userId)!;
    const { text: reply, usedFallback } = await coachReply(fresh, text);
    store.pushCoachMessage(profile.userId, "assistant", reply);
    const after = store.getUser(profile.userId)!;

    res.json({
      reply,
      usedFallback,
      remaining: store.canUseCoach(after).remaining,
      limit: store.canUseCoach(after).limit,
    });
  });

  router.get("/stats", (req, res) => {
    const profile = (req as any).profile;
    res.json({
      stats: store.weekStats(profile),
      recentCheckins: profile.checkins.slice(0, 14),
      recentStress: profile.stress.slice(0, 14),
    });
  });

  router.get("/insight", async (req, res) => {
    const profile = (req as any).profile;
    if (!store.isPremium(profile) || profile.plan !== "plus") {
      return res.status(403).json({ error: "plus_required" });
    }
    const text = await weeklyInsight(profile);
    res.json({ text });
  });

  router.post("/plan", async (req, res) => {
    const profile = (req as any).profile;
    const plan = req.body?.plan as "free" | "care" | "plus";
    if (!["free", "care", "plus"].includes(plan)) {
      return res.status(400).json({ error: "invalid_plan" });
    }
    if (plan === "free") {
      store.updateUser(profile.userId, {
        plan: "free",
        premiumUntil: undefined,
      });
      const updated = store.getUser(profile.userId)!;
      return res.json({
        ok: true,
        plan: updated.plan,
        premium: false,
        premiumUntil: undefined,
      });
    }

    // Paid plans: create Crypto Pay invoice (preferred)
    if (isCryptoPayConfigured()) {
      try {
        const inv = await createPlanInvoice({
          userId: profile.userId,
          plan: plan as PaidPlan,
          botUsername: "careofme_bot",
        });
        store.trackInvoice(profile.userId, inv.invoice_id, plan as PaidPlan);
        return res.json({
          ok: true,
          payment: "crypto",
          invoiceId: inv.invoice_id,
          payUrl:
            inv.mini_app_invoice_url ||
            inv.bot_invoice_url ||
            inv.pay_url,
          amountRub: PLANS[plan].priceRub,
          plan,
        });
      } catch (e) {
        console.error(e);
        return res.status(502).json({ error: "invoice_failed" });
      }
    }

    // Demo only when allowed
    if (process.env.ALLOW_DEMO_PAY === "1") {
      const updated = store.activatePlan(
        profile.userId,
        plan as PaidPlan,
        PLAN_DURATION_DAYS
      );
      return res.json({
        ok: true,
        payment: "demo",
        plan: updated.plan,
        premium: store.isPremium(updated),
        premiumUntil: updated.premiumUntil,
      });
    }

    return res.status(503).json({
      error: "payments_not_configured",
      message: "Задайте CRYPTO_PAY_TOKEN (@CryptoBot → Crypto Pay)",
    });
  });

  router.post("/plan/check", async (req, res) => {
    const profile = (req as any).profile;
    const invoiceId = Number(req.body?.invoiceId);
    if (invoiceId) {
      try {
        const inv = await getInvoice(invoiceId);
        if (inv?.status === "paid") {
          const { parseInvoicePayload } = await import("../payments/plans");
          const parsed = parseInvoicePayload(inv.payload);
          if (parsed && parsed.userId === profile.userId) {
            store.activatePlan(profile.userId, parsed.plan, PLAN_DURATION_DAYS, {
              invoiceId,
              amount: inv.amount,
            });
          }
        }
      } catch (e) {
        console.warn(e);
      }
    } else {
      await checkPendingPayments(profile.userId);
    }
    const updated = store.getUser(profile.userId)!;
    res.json({
      ok: true,
      premium: store.isPremium(updated),
      plan: updated.plan,
      premiumUntil: updated.premiumUntil,
    });
  });

  return router;
}
