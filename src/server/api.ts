import { Router, type Request, type Response, type NextFunction } from "express";
import {
  store,
  ALL_FOCUS_AREAS,
  type FocusArea,
  type MoodScore,
} from "../db/store";
import { validateInitDataDetailed } from "./auth";
import { createSession, getSession } from "./sessions";
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
  invoicePayUrl,
  isCryptoPayConfigured,
} from "../payments/cryptopay";
import {
  planPriceUsdt,
  rubPerUsdt,
  type PaidPlan,
} from "../payments/plans";
import { checkPendingPayments } from "../payments/activate";

function getToken() {
  return process.env.BOT_TOKEN || "";
}

function extractBearer(req: Request): string {
  const auth = req.header("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (typeof req.header("x-session-token") === "string") {
    return (req.header("x-session-token") as string).trim();
  }
  if (typeof req.body?.sessionToken === "string") {
    return req.body.sessionToken.trim();
  }
  if (typeof req.query?.sessionToken === "string") {
    return String(req.query.sessionToken).trim();
  }
  return "";
}

function extractInitData(req: Request): string {
  // Prefer body (most reliable on mobile WebViews — not mangled by proxies)
  if (typeof req.body?.initData === "string" && req.body.initData.trim()) {
    return req.body.initData.trim();
  }
  if (typeof req.query?.initData === "string" && req.query.initData) {
    return String(req.query.initData);
  }

  const header =
    (req.header("x-telegram-init-data") as string) ||
    (req.header("X-Telegram-Init-Data") as string) ||
    "";
  if (header.trim()) return header.trim();

  const auth = req.header("authorization") || "";
  if (auth.toLowerCase().startsWith("tma ")) {
    return auth.slice(4).trim();
  }
  return "";
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // 1) Short session token (preferred after /api/auth)
  const bearer = extractBearer(req);
  if (bearer) {
    const session = getSession(bearer);
    if (session) {
      const profile = store.getUser(session.userId);
      if (profile) {
        (req as any).tgUser = {
          id: profile.userId,
          first_name: profile.firstName,
          username: profile.username,
        };
        (req as any).profile = profile;
        return next();
      }
    }
  }

  const initData = extractInitData(req);

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

  if (!initData) {
    return res.status(401).json({
      error: "missing_init_data",
      message:
        "Открой приложение из бота @careofme_bot (кнопка меню или /app). Не открывай ссылку в браузере.",
    });
  }

  const validated = validateInitDataDetailed(initData, getToken());
  if (!validated.ok) {
    console.warn(
      `auth: initData rejected reason=${validated.reason} path=${req.path} len=${initData.length}`
    );
    const message =
      validated.reason === "expired"
        ? "Сессия устарела — закрой приложение и открой снова из @careofme_bot"
        : validated.reason === "bad_hash"
          ? "Не удалось проверить вход. Открой именно из @careofme_bot (не из другого бота и не по ссылке в Safari)."
          : "Открой приложение из бота @careofme_bot";
    return res.status(401).json({
      error: "invalid_init_data",
      reason: validated.reason,
      message,
    });
  }

  const v = validated.data;
  const profile = store.getOrCreateUser({
    userId: v.user.id,
    chatId: v.user.id,
    username: v.user.username,
    firstName: v.user.first_name,
  });

  (req as any).tgUser = v.user;
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

  /**
   * Exchange Telegram initData (body only — reliable on mobile) for a short session token.
   * Must stay BEFORE authMiddleware.
   */
  router.post("/auth", (req, res) => {
    const initData =
      typeof req.body?.initData === "string" ? req.body.initData.trim() : "";

    if (!initData && process.env.WEBAPP_DEV_SKIP_AUTH === "1") {
      const user = store.getOrCreateUser({
        userId: 1,
        chatId: 1,
        firstName: "Гость",
      });
      const { token, exp } = createSession(user.userId);
      return res.json({
        ok: true,
        token,
        exp,
        user: { id: user.userId, firstName: user.firstName },
      });
    }

    if (!initData) {
      return res.status(401).json({
        error: "missing_init_data",
        message:
          "Нет данных Telegram. Открой Mini App из @careofme_bot → /app или кнопку меню.",
        hasTelegramScript: true,
      });
    }

    const validated = validateInitDataDetailed(initData, getToken());
    if (!validated.ok) {
      console.warn(`auth/login failed reason=${validated.reason} len=${initData.length}`);
      return res.status(401).json({
        error: "invalid_init_data",
        reason: validated.reason,
        message:
          validated.reason === "bad_hash"
            ? "Подпись не совпала. Нужен именно @careofme_bot (проверь, что не старый бот)."
            : "Не удалось войти. Закрой приложение и открой из @careofme_bot.",
      });
    }

    const v = validated.data;
    const profile = store.getOrCreateUser({
      userId: v.user.id,
      chatId: v.user.id,
      username: v.user.username,
      firstName: v.user.first_name,
    });
    const { token, exp } = createSession(profile.userId);
    console.log(`auth: session ok user=${profile.userId}`);
    res.json({
      ok: true,
      token,
      exp,
      user: {
        id: profile.userId,
        firstName: profile.firstName,
        username: profile.username,
      },
    });
  });

  // Lightweight probe (no secrets) — helps debug tester issues
  router.get("/auth/ping", (_req, res) => {
    res.json({
      ok: true,
      botConfigured: Boolean(getToken()),
      ts: new Date().toISOString(),
    });
  });

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
    const allowed = new Set<FocusArea>(ALL_FOCUS_AREAS);
    const focusAreas = areas.filter((a) => allowed.has(a));
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

  router.get("/journal", (req, res) => {
    const profile = (req as any).profile;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const entries = store.listJournal(profile.userId, limit);
    res.json({ entries, count: entries.length });
  });

  router.get("/journal/:id", (req, res) => {
    const profile = (req as any).profile;
    const entry = store.getJournalEntry(profile.userId, req.params.id);
    if (!entry) return res.status(404).json({ error: "not_found" });
    res.json({ entry });
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
    try {
      const entry = store.addJournal(profile.userId, prompt, text);
      console.log(
        `journal: saved user=${profile.userId} id=${entry.id} len=${text.length}`
      );
      res.json({ ok: true, entry });
    } catch (err) {
      console.error("journal: save failed", err);
      res.status(500).json({ error: "save_failed", message: "Не удалось сохранить" });
    }
  });

  router.patch("/journal/:id", (req, res) => {
    const profile = (req as any).profile;
    const text =
      typeof req.body?.text === "string" ? req.body.text.slice(0, 4000) : undefined;
    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.slice(0, 300)
        : undefined;
    if (text !== undefined && !text.trim()) {
      return res.status(400).json({ error: "text_required" });
    }
    try {
      const entry = store.updateJournal(profile.userId, req.params.id, {
        text,
        prompt,
      });
      res.json({ ok: true, entry });
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  });

  router.delete("/journal/:id", (req, res) => {
    const profile = (req as any).profile;
    try {
      const ok = store.deleteJournal(profile.userId, req.params.id);
      if (!ok) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: "not_found" });
    }
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

    // Already on this paid plan — don't create another invoice
    if (
      (plan === "care" || plan === "plus") &&
      store.isPremium(profile) &&
      profile.plan === plan
    ) {
      return res.json({
        ok: true,
        payment: "already_active",
        plan: profile.plan,
        premium: true,
        premiumUntil: profile.premiumUntil,
      });
    }

    if (plan === "free") {
      // Do not silently wipe paid subscription via free switch from Mini App
      // unless user is not premium
      if (store.isPremium(profile)) {
        return res.status(400).json({
          error: "already_premium",
          message: "У тебя уже есть активная подписка",
          plan: profile.plan,
          premiumUntil: profile.premiumUntil,
        });
      }
      store.updateUser(profile.userId, {
        plan: "free",
        premiumUntil: undefined,
      });
      return res.json({
        ok: true,
        plan: "free",
        premium: false,
        premiumUntil: undefined,
      });
    }

    if (!isCryptoPayConfigured()) {
      return res.status(503).json({
        error: "payments_not_configured",
        message: "CRYPTO_PAY_TOKEN не задан",
      });
    }

    try {
      const inv = await createPlanInvoice({
        userId: profile.userId,
        plan: plan as PaidPlan,
        botUsername: process.env.BOT_USERNAME || "careofme_bot",
      });
      store.trackInvoice(profile.userId, inv.invoice_id, plan as PaidPlan);
      const payUrl = invoicePayUrl(inv);
      if (!payUrl) {
        return res.status(502).json({ error: "invoice_no_url" });
      }
      return res.json({
        ok: true,
        payment: "crypto",
        invoiceId: inv.invoice_id,
        payUrl,
        miniAppPayUrl: inv.mini_app_invoice_url,
        amountRub: PLANS[plan].priceRub,
        amountUsdt: planPriceUsdt(plan as PaidPlan),
        rubPerUsdt: rubPerUsdt(),
        asset: "USDT",
        plan,
      });
    } catch (e) {
      console.error("createPlanInvoice", e);
      return res.status(502).json({
        error: "invoice_failed",
        message: e instanceof Error ? e.message : "invoice_failed",
      });
    }
  });

  router.post("/plan/check", async (req, res) => {
    const profile = (req as any).profile;
    const invoiceId = Number(req.body?.invoiceId) || undefined;
    try {
      await checkPendingPayments(profile.userId, invoiceId);
    } catch (e) {
      console.warn("plan/check", e);
    }
    const updated = store.getUser(profile.userId)!;
    res.json({
      ok: true,
      premium: store.isPremium(updated),
      plan: updated.plan || "free",
      premiumUntil: updated.premiumUntil,
    });
  });

  return router;
}
