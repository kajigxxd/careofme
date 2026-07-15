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
  THERAPY_MODULES,
  THERAPY_DISCLAIMER,
  getTherapy,
  therapyIds,
} from "../data/therapy";
import {
  ACHIEVEMENTS,
  evaluateNewAchievements,
  getAchievement,
  computePracticeStats,
} from "../data/achievements";
import {
  FOCUS_LABELS,
  PLANS,
  pickJournalPrompt,
  STRESS_SOURCES,
  DISCLAIMER,
} from "../data/prompts";
import {
  coachReply,
  weeklyInsight,
  isAiConfigured,
  checkinInsight,
  isBadResult,
  fullFeelingsAnalysis,
  autoSupportOnBadResult,
  scanUserForCrisis,
  crisisAutoHelp,
  reflectSelectedFeelings,
  type CrisisHelp,
} from "../ai/client";
import type { UserProfile } from "../db/store";
import {
  createPlanInvoice,
  invoicePayUrl,
  isCryptoPayConfigured,
} from "../payments/cryptopay";
import {
  planPriceUsdt,
  planPriceRub,
  planCatalog,
  periodDays,
  isPlanPeriod,
  rubPerUsdt,
  TRIAL_DAYS,
  DEFAULT_PLAN_PERIOD,
  PLAN_PERIODS,
  type PaidPlan,
  type PlanPeriod,
} from "../payments/plans";
import { checkPendingPayments } from "../payments/activate";
import { userRateLimit } from "./rateLimit";

function getToken() {
  return process.env.BOT_TOKEN || "";
}

/** Expensive AI endpoints — per Telegram user */
const aiUserLimit = userRateLimit({
  windowMs: 60_000,
  max: 12,
  message: "Слишком много AI-запросов. Подожди минуту.",
});
const payUserLimit = userRateLimit({
  windowMs: 60_000,
  max: 8,
  message: "Слишком много запросов на оплату.",
});

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

/**
 * If notes/history show suicidal or self-harm signals — attach full auto-help
 * for ALL users (not only Plus). Does not consume coach quota.
 */
async function attachCrisisIfNeeded(
  user: UserProfile,
  extras: { source: string; text?: string | null }[],
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    const scan = scanUserForCrisis(user, extras);
    if (!scan.detected) return payload;

    const context =
      extras
        .map((e) => e.text)
        .filter(Boolean)
        .join("\n")
        .slice(0, 500) || undefined;

    const help: CrisisHelp = await crisisAutoHelp(user, scan, context);
    console.warn(
      `crisis: user=${user.userId} level=${scan.level} sources=${scan.sources.join(",")}`
    );

    store.pushCoachMessage(
      user.userId,
      "assistant",
      ` Кризисная поддержка\n\n${help.text}`
    );

    payload.crisis = true;
    payload.crisisLevel = scan.level;
    payload.needsSupport = true;
    payload.autoHelp = help;
    // Prefer crisis text as primary insight when present
    if (!payload.insight) payload.insight = help.text;
    return payload;
  } catch (e) {
    console.error("attachCrisisIfNeeded", e);
    return payload;
  }
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
    const trialEligible = store.trialEligible(profile);
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
      isTrial: Boolean(premium && profile.isTrial),
      trialDays: TRIAL_DAYS,
      trialEligible,
      trialUsed: {
        care: Boolean(profile.trialUsed?.care),
        plus: Boolean(profile.trialUsed?.plus),
      },
      streak: profile.streak,
      stats,
      coachQuota: quota,
      disclaimer: DISCLAIMER,
      focusLabels: FOCUS_LABELS,
      plans: PLANS,
      planCatalog: planCatalog(),
      planPeriods: Object.entries(PLAN_PERIODS).map(([id, meta]) => ({
        id,
        ...meta,
      })),
      stressSources: STRESS_SOURCES,
      aiConfigured: isAiConfigured(),
      cryptoPayConfigured: isCryptoPayConfigured(),
    });
  });

  router.post("/onboarding", aiUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    const areas = (req.body?.focusAreas || []) as FocusArea[];
    const allowed = new Set<FocusArea>(ALL_FOCUS_AREAS);
    const focusAreas = areas.filter((a) => allowed.has(a));
    const previous = [...(profile.focusAreas || [])];
    const analyze = req.body?.analyze !== false; // default: analyze selection

    const updated = store.updateUser(profile.userId, {
      focusAreas: focusAreas.length ? focusAreas : ["general"],
      onboardingDone: true,
    });

    const payload: Record<string, unknown> = {
      ok: true,
      focusAreas: updated.focusAreas,
    };

    // Crisis if somehow encoded in free text (not typical for chips) — skip
    if (analyze) {
      try {
        const reflection = await reflectSelectedFeelings(
          updated,
          updated.focusAreas,
          previous
        );
        payload.reflection = reflection;
        payload.autoHelp = {
          text: reflection.text,
          practiceId: reflection.practiceId,
          practiceTitle: reflection.practiceTitle,
          usedFallback: reflection.usedFallback,
          trigger: "feelings",
        };
        payload.needsSupport = true;
        store.pushCoachMessage(
          updated.userId,
          "assistant",
          ` Разбор чувств\n\n${reflection.text}`
        );

        // Also scan reflection request context? chips only — optional crisis from history
        const crisisScan = scanUserForCrisis(updated, []);
        if (crisisScan.detected) {
          const help = await crisisAutoHelp(updated, crisisScan);
          payload.crisis = true;
          payload.crisisLevel = crisisScan.level;
          payload.autoHelp = help;
          store.pushCoachMessage(
            updated.userId,
            "assistant",
            ` Кризисная поддержка\n\n${help.text}`
          );
        }
      } catch (e) {
        console.error("onboarding reflect", e);
      }
    }

    res.json(payload);
  });

  router.post("/checkin", async (req, res) => {
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

    let payload: Record<string, unknown> = {
      ok: true,
      streak: updated.streak,
      checkin: updated.checkins[0],
      stats: store.weekStats(updated),
      needsSupport: false,
      crisis: false,
    };

    // Crisis first — for everyone, from note + history
    payload = await attachCrisisIfNeeded(
      updated,
      [{ source: "checkin_note", text: note }],
      payload
    );

    const premium = store.isPremium(updated);
    const isPlus = premium && updated.plan === "plus";

    // Low scores → individualized support for FREE and paid (not only Plus)
    if (!payload.crisis && isBadResult({ mood, energy, stress })) {
      payload.needsSupport = true;
      try {
        const help = await autoSupportOnBadResult(
          updated,
          "checkin",
          { mood, energy, stress, note },
          { freeOnly: !premium }
        );
        payload.autoHelp = help;
        store.pushCoachMessage(
          updated.userId,
          "assistant",
          ` Поддержка при низких показателях\n\n${help.text}`
        );
      } catch (e) {
        console.error("checkin autoHelp", e);
      }
    }

    // Plus: short AI insight even when scores are not "bad"
    if (isPlus && !payload.crisis && !payload.autoHelp) {
      try {
        const insight = await checkinInsight(updated);
        if (insight) payload.insight = insight;
      } catch (e) {
        console.error("checkin insight", e);
      }
    } else if (isPlus && !payload.crisis && payload.autoHelp) {
      // Optional short label for UI
      payload.insight =
        typeof payload.insight === "string"
          ? payload.insight
          : "Показатели низкие — ниже мягкие варианты опоры специально для тебя.";
    }

    res.json(payload);
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
    const user = store.getUser(profile.userId)!;
    const newly = evaluateNewAchievements(
      user.practices,
      store.getAchievementIds(profile.userId),
      therapyIds()
    );
    const unlockedIds = store.unlockAchievements(profile.userId, newly);
    const unlocked = unlockedIds
      .map((id) => getAchievement(id))
      .filter(Boolean);
    res.json({
      ok: true,
      newAchievements: unlocked,
      practiceCount: user.practices.length,
    });
  });

  router.get("/therapy", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    res.json({
      disclaimer: THERAPY_DISCLAIMER,
      modules: THERAPY_MODULES.map((t) => ({
        id: t.id,
        title: t.title,
        emoji: t.emoji,
        durationMin: t.durationMin,
        focus: t.focus,
        free: t.free,
        locked: !t.free && !premium,
        intro: t.intro,
      })),
      premium,
    });
  });

  router.get("/therapy/:id", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const t = getTherapy(req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    if (!t.free && !premium) {
      return res.status(403).json({
        error: "premium_required",
        module: { id: t.id, title: t.title },
      });
    }
    res.json({ module: t });
  });

  router.post("/therapy/:id/done", (req, res) => {
    const profile = (req as any).profile;
    const premium = store.isPremium(profile);
    const t = getTherapy(req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    if (!t.free && !premium) {
      return res.status(403).json({ error: "premium_required" });
    }
    // Log as practice so achievements and stats count
    store.addPractice(
      profile.userId,
      t.id,
      `${t.title}`,
      t.durationMin * 60
    );
    const user = store.getUser(profile.userId)!;
    const newly = evaluateNewAchievements(
      user.practices,
      store.getAchievementIds(profile.userId),
      therapyIds()
    );
    const unlockedIds = store.unlockAchievements(profile.userId, newly);
    const unlocked = unlockedIds
      .map((id) => getAchievement(id))
      .filter(Boolean);
    res.json({
      ok: true,
      newAchievements: unlocked,
      practiceCount: user.practices.length,
    });
  });

  router.get("/achievements", (req, res) => {
    const profile = (req as any).profile;
    const user = store.getUser(profile.userId)!;
    const owned = user.achievements || [];
    const ownedSet = new Set(owned.map((a) => a.id));
    const stats = computePracticeStats(user.practices, new Set(therapyIds()));
    res.json({
      stats: {
        totalPractices: stats.total,
        uniquePractices: stats.unique,
        dayStreak: stats.dayStreak,
        daysActive: stats.daysActive,
        therapyCount: stats.therapyCount,
        unlockedCount: owned.length,
        totalAchievements: ACHIEVEMENTS.length,
      },
      achievements: ACHIEVEMENTS.map((a) => {
        const hit = owned.find((x) => x.id === a.id);
        return {
          ...a,
          unlocked: ownedSet.has(a.id),
          unlockedAt: hit?.at || null,
        };
      }),
    });
  });

  router.post("/stress", async (req, res) => {
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
    const fresh = store.getUser(profile.userId)!;
    let payload: Record<string, unknown> = {
      ok: true,
      stats: store.weekStats(fresh),
      needsSupport: false,
      crisis: false,
    };

    payload = await attachCrisisIfNeeded(
      fresh,
      [{ source: "stress_note", text: note }],
      payload
    );

    const premium = store.isPremium(fresh);
    // High stress → support for free + paid
    if (!payload.crisis && isBadResult({ stress: level })) {
      payload.needsSupport = true;
      try {
        const help = await autoSupportOnBadResult(
          fresh,
          "stress",
          { stress: level, note, source },
          { freeOnly: !premium }
        );
        payload.autoHelp = help;
        store.pushCoachMessage(
          fresh.userId,
          "assistant",
          ` Поддержка при высоком стрессе\n\n${help.text}`
        );
      } catch (e) {
        console.error("stress autoHelp", e);
      }
    }

    res.json(payload);
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

  router.post("/journal", async (req, res) => {
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
      const fresh = store.getUser(profile.userId)!;
      let payload: Record<string, unknown> = {
        ok: true,
        entry,
        crisis: false,
        needsSupport: false,
      };
      payload = await attachCrisisIfNeeded(
        fresh,
        [{ source: "journal", text }],
        payload
      );
      res.json(payload);
    } catch (err) {
      console.error("journal: save failed", err);
      res.status(500).json({ error: "save_failed", message: "Не удалось сохранить" });
    }
  });

  router.patch("/journal/:id", async (req, res) => {
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
      const fresh = store.getUser(profile.userId)!;
      let payload: Record<string, unknown> = {
        ok: true,
        entry,
        crisis: false,
        needsSupport: false,
      };
      if (text) {
        payload = await attachCrisisIfNeeded(
          fresh,
          [{ source: "journal_edit", text }],
          payload
        );
      }
      res.json(payload);
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

  router.post("/coach", aiUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    const text =
      typeof req.body?.text === "string" ? req.body.text.slice(0, 2000) : "";
    if (!text.trim()) return res.status(400).json({ error: "text_required" });

    // Crisis messages never blocked by daily quota
    const preCrisis = scanUserForCrisis(profile, [
      { source: "coach_now", text },
    ]);
    const isCrisis = preCrisis.detected;

    const quota = store.canUseCoach(profile);
    if (!quota.ok && !isCrisis) {
      return res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        remaining: 0,
      });
    }

    store.pushCoachMessage(profile.userId, "user", text);
    if (!isCrisis) store.consumeCoach(profile.userId);
    const fresh = store.getUser(profile.userId)!;
    const { text: reply, usedFallback, suggestedPracticeId } =
      await coachReply(fresh, text);
    store.pushCoachMessage(profile.userId, "assistant", reply);
    const after = store.getUser(profile.userId)!;

    res.json({
      reply,
      usedFallback,
      crisis: isCrisis,
      crisisLevel: isCrisis ? preCrisis.level : "none",
      suggestedPracticeId,
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

  router.get("/insight", aiUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    if (!store.isPremium(profile) || profile.plan !== "plus") {
      return res.status(403).json({ error: "plus_required" });
    }
    const text = await weeklyInsight(profile);
    res.json({ text });
  });

  /** Plus: full feelings analysis across focus + checkins + stress + journal */
  router.get("/analysis/feelings", aiUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    if (!store.isPremium(profile) || profile.plan !== "plus") {
      return res.status(403).json({
        error: "plus_required",
        message: "Полный анализ чувств доступен в тарифе Плюс",
      });
    }
    try {
      const analysis = await fullFeelingsAnalysis(profile);
      res.json({ ok: true, ...analysis });
    } catch (e) {
      console.error("analysis/feelings", e);
      res.status(500).json({ error: "analysis_failed" });
    }
  });

  router.post("/analysis/feelings", aiUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    if (!store.isPremium(profile) || profile.plan !== "plus") {
      return res.status(403).json({
        error: "plus_required",
        message: "Полный анализ чувств доступен в тарифе Плюс",
      });
    }
    try {
      const analysis = await fullFeelingsAnalysis(
        store.getUser(profile.userId)!
      );
      res.json({ ok: true, ...analysis });
    } catch (e) {
      console.error("analysis/feelings", e);
      res.status(500).json({ error: "analysis_failed" });
    }
  });

  /** Start free 3-day trial for care or plus (once per plan type) */
  router.post("/plan/trial", payUserLimit, (req, res) => {
    const profile = (req as any).profile;
    const plan = req.body?.plan as "care" | "plus";
    if (plan !== "care" && plan !== "plus") {
      return res.status(400).json({ error: "invalid_plan" });
    }
    try {
      const updated = store.startTrial(profile.userId, plan);
      console.log(
        `trial: user=${profile.userId} plan=${plan} until=${updated.premiumUntil}`
      );
      res.json({
        ok: true,
        payment: "trial",
        plan: updated.plan,
        premium: true,
        isTrial: true,
        premiumUntil: updated.premiumUntil,
        trialDays: TRIAL_DAYS,
        message: `Пробный период «${PLANS[plan].title}» на ${TRIAL_DAYS} дня активирован`,
      });
    } catch (e) {
      const err = e as Error & { reason?: string; message?: string };
      const reason = err.reason || "trial_failed";
      const status =
        reason === "already_premium" || reason === "trial_used" ? 400 : 500;
      res.status(status).json({
        error: reason,
        message: err.message || "Не удалось активировать пробный период",
      });
    }
  });

  router.post("/plan", payUserLimit, async (req, res) => {
    const profile = (req as any).profile;
    const plan = req.body?.plan as "free" | "care" | "plus";
    if (!["free", "care", "plus"].includes(plan)) {
      return res.status(400).json({ error: "invalid_plan" });
    }

    // Period: 7d | 30d | 90d | 180d (default 30d for paid)
    const periodRaw = req.body?.period;
    const period: PlanPeriod = isPlanPeriod(periodRaw)
      ? periodRaw
      : DEFAULT_PLAN_PERIOD;
    const days = periodDays(period);

    if (plan === "free") {
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
        isTrial: false,
      });
      return res.json({
        ok: true,
        plan: "free",
        premium: false,
        premiumUntil: undefined,
        isTrial: false,
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
        period,
        botUsername: process.env.BOT_USERNAME || "careofme_bot",
      });
      store.trackInvoice(
        profile.userId,
        inv.invoice_id,
        plan as PaidPlan,
        days
      );
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
        amountRub: planPriceRub(plan as PaidPlan, period),
        amountUsdt: planPriceUsdt(plan as PaidPlan, period),
        rubPerUsdt: rubPerUsdt(),
        asset: "USDT",
        plan,
        period,
        days,
        periodLabel: PLAN_PERIODS[period].label,
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

  /** Admin usage metrics — only for ADMIN_TELEGRAM_IDS */
  router.get("/admin/usage", (req, res) => {
    const profile = (req as any).profile;
    const admins = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_USER_IDS || "")
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!admins.length || !admins.includes(profile.userId)) {
      return res.status(403).json({ error: "admin_only" });
    }
    res.json({ ok: true, stats: store.appUsageStats() });
  });

  return router;
}
