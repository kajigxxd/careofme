import { Bot, Context, InlineKeyboard } from "grammy";
import { store, type FocusArea, type MoodScore } from "../db/store";
import {
  DISCLAIMER,
  CRISIS_HINT,
  FOCUS_LABELS,
  MOOD_LABELS,
  STRESS_LABELS,
  STRESS_SOURCES,
  PLANS,
  pickJournalPrompt,
} from "../data/prompts";
import {
  getPractice,
  recommendPractice,
  PRACTICES,
} from "../data/practices";
import {
  coachReply,
  weeklyInsight,
  checkinInsight,
  isAiConfigured,
  isBadResult,
  autoSupportOnBadResult,
  fullFeelingsAnalysis,
  scanUserForCrisis,
  crisisAutoHelp,
  looksLikeCrisis,
} from "../ai/client";
import {
  mainMenuKeyboard,
  moodKeyboard,
  focusKeyboard,
  practicesKeyboard,
  practiceActionsKeyboard,
  stressSourceKeyboard,
  afterCheckinKeyboard,
  coachKeyboard,
  plansKeyboard,
  confirmPlanKeyboard,
  payUrlKeyboard,
  openAppKeyboard,
  webappUrl,
} from "../bot/keyboards";
import {
  createPlanInvoice,
  invoicePayUrl,
  isCryptoPayConfigured,
} from "../payments/cryptopay";
import { PLAN_DURATION_DAYS, type PaidPlan } from "../payments/plans";
import {
  applyPaidInvoice,
  checkPendingPayments,
} from "../payments/activate";

export { applyPaidInvoice, checkPendingPayments };
import { getSession, resetSession, setFlow } from "../bot/session";
import { bar, fmtAvg, pluralDays } from "../utils/format";

function ensureUser(ctx: Context) {
  const from = ctx.from;
  if (!from) throw new Error("No from");
  return store.getOrCreateUser({
    userId: from.id,
    chatId: ctx.chat?.id ?? from.id,
    username: from.username,
    firstName: from.first_name,
  });
}

function asScore(s: string): MoodScore | null {
  const n = Number(s);
  if (n >= 1 && n <= 5) return n as MoodScore;
  return null;
}

export function registerHandlers(bot: Bot) {
  bot.command("start", async (ctx) => {
    const user = ensureUser(ctx);
    resetSession(user.userId);

    if (!user.onboardingDone) {
      await ctx.reply(
        `Привет${user.firstName ? `, ${user.firstName}` : ""} 🌿\n\n` +
          `Я *Бережно* — твой карманный спутник для эмоциональной безопасности.\n\n` +
          `За 2–3 минуты в день:\n` +
          `• чек-ин настроения\n` +
          `• микро-практики (дыхание, CBT, сон)\n` +
          `• трекер стресса\n` +
          `• AI-коуч на русском — без токсичного позитива\n\n` +
          `${DISCLAIMER}\n\n` +
          `Что ты чувствуешь сейчас? Можно несколько вариантов — это не диагноз, а ориентир:`,
        {
          parse_mode: "Markdown",
          reply_markup: focusKeyboard(user.focusAreas),
        }
      );
      const s = getSession(user.userId);
      s.focusDraft = [...user.focusAreas];
      return;
    }

    const appKb = openAppKeyboard();
    await ctx.reply(
      `Снова здесь — и это уже забота о себе 🌿\n\n` +
        `Серия: *${pluralDays(user.streak)}* чек-инов подряд.\n` +
        (webappUrl()
          ? `Открой *приложение* кнопкой ниже или меню ☰ → «Открыть Бережно».\n`
          : "") +
        `Либо выбери действие в меню.`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
    if (appKb) {
      await ctx.reply("🌿 Mini App — чек-ин, практики, коуч в одном окне:", {
        reply_markup: appKb,
      });
    }
  });

  bot.command("help", async (ctx) => {
    await sendHelp(ctx);
  });

  bot.command("app", async (ctx) => {
    ensureUser(ctx);
    await openMiniApp(ctx);
  });

  bot.command("checkin", async (ctx) => {
    ensureUser(ctx);
    await startCheckin(ctx);
  });

  bot.command("coach", async (ctx) => {
    ensureUser(ctx);
    await openCoach(ctx);
  });

  bot.command("stats", async (ctx) => {
    ensureUser(ctx);
    await sendStats(ctx);
  });

  // Reply keyboard texts
  bot.hears("🌤 Чек-ин", async (ctx) => {
    ensureUser(ctx);
    await startCheckin(ctx);
  });
  bot.hears("🧘 Практики", async (ctx) => {
    ensureUser(ctx);
    await openPractices(ctx);
  });
  bot.hears("📝 Дневник", async (ctx) => {
    ensureUser(ctx);
    await startJournal(ctx);
  });
  bot.hears("📊 Стресс", async (ctx) => {
    ensureUser(ctx);
    await startStress(ctx);
  });
  bot.hears("💬 AI-коуч", async (ctx) => {
    ensureUser(ctx);
    await openCoach(ctx);
  });
  bot.hears("📈 Статистика", async (ctx) => {
    ensureUser(ctx);
    await sendStats(ctx);
  });
  bot.hears("💎 Подписка", async (ctx) => {
    ensureUser(ctx);
    await openPremium(ctx);
  });
  bot.hears("ℹ️ Помощь", async (ctx) => {
    await sendHelp(ctx);
  });

  // Callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const user = ensureUser(ctx);
    const session = getSession(user.userId);

    try {
      if (data.startsWith("focus_toggle:")) {
        const area = data.split(":")[1] as FocusArea;
        const draft = session.focusDraft ?? [...user.focusAreas];
        const idx = draft.indexOf(area);
        if (idx >= 0) {
          if (draft.length > 1) draft.splice(idx, 1);
        } else {
          draft.push(area);
        }
        session.focusDraft = draft;
        await ctx.editMessageReplyMarkup({
          reply_markup: focusKeyboard(draft),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (data === "focus_done") {
        const draft = session.focusDraft?.length
          ? session.focusDraft
          : (["general"] as FocusArea[]);
        store.updateUser(user.userId, {
          focusAreas: draft,
          onboardingDone: true,
        });
        await ctx.answerCallbackQuery({ text: "Сохранено" });
        await ctx.editMessageText(
          `Отлично. Фокус: ${draft.map((f) => FOCUS_LABELS[f]).join(", ")}.\n\n` +
            `Меню всегда под рукой. Начни с короткого чек-ина — 2 минуты.`
        );
        await ctx.reply("Вот главное меню 👇", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      if (data.startsWith("cin_mood:")) {
        const score = asScore(data.split(":")[1]!);
        if (!score) return ctx.answerCallbackQuery();
        session.pendingCheckin.mood = score;
        session.flow = "checkin_energy";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Настроение: *${score}/5* — ${MOOD_LABELS[score]}\n\n` +
            `Как *энергия* прямо сейчас?`,
          { parse_mode: "Markdown", reply_markup: moodKeyboard("cin_energy") }
        );
        return;
      }

      if (data.startsWith("cin_energy:")) {
        const score = asScore(data.split(":")[1]!);
        if (!score) return ctx.answerCallbackQuery();
        session.pendingCheckin.energy = score;
        session.flow = "checkin_stress";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Энергия: *${score}/5*\n\nУровень *стресса*?`,
          { parse_mode: "Markdown", reply_markup: moodKeyboard("cin_stress") }
        );
        return;
      }

      if (data.startsWith("cin_stress:")) {
        const score = asScore(data.split(":")[1]!);
        if (!score) return ctx.answerCallbackQuery();
        session.pendingCheckin.stress = score;
        session.flow = "checkin_sleep";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Стресс: *${score}/5* — ${STRESS_LABELS[score]}\n\n` +
            `Как *сон* прошлой ночью? (или «Пропустить»)`,
          {
            parse_mode: "Markdown",
            reply_markup: moodKeyboard("cin_sleep").text(
              "Пропустить",
              "cin_sleep:skip"
            ),
          }
        );
        return;
      }

      if (data.startsWith("cin_sleep:")) {
        const part = data.split(":")[1]!;
        if (part !== "skip") {
          const score = asScore(part);
          if (score) session.pendingCheckin.sleep = score;
        }
        session.flow = "checkin_note";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Почти готово.\n\nМожешь добавить *короткую заметку* одним сообщением ` +
            `(что повлияло на день) или нажми «Без заметки».`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .text("Без заметки", "cin_note:skip")
              .row()
              .text("Отмена чек-ина", "nav:home"),
          }
        );
        return;
      }

      if (data === "cin_note:skip") {
        await ctx.answerCallbackQuery();
        await finishCheckin(ctx, user.userId, undefined);
        return;
      }

      if (data.startsWith("stress_lv:")) {
        const score = asScore(data.split(":")[1]!);
        if (!score) return ctx.answerCallbackQuery();
        session.pendingStressLevel = score;
        session.flow = "stress_level";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Стресс *${score}/5* — ${STRESS_LABELS[score]}\n\nОткуда он сейчас?`,
          {
            parse_mode: "Markdown",
            reply_markup: stressSourceKeyboard(),
          }
        );
        return;
      }

      if (data.startsWith("stress_src:")) {
        const src = data.split(":")[1]!;
        session.pendingStressSource = src === "skip" ? undefined : src;
        session.flow = "stress_note";
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          `Можешь добавить заметку одним сообщением или пропустить.`,
          {
            reply_markup: new InlineKeyboard()
              .text("Без заметки", "stress_note:skip")
              .row()
              .text("« В меню", "nav:home"),
          }
        );
        return;
      }

      if (data === "stress_note:skip") {
        await ctx.answerCallbackQuery();
        await finishStress(ctx, user.userId, undefined);
        return;
      }

      if (data.startsWith("practice:")) {
        const id = data.split(":")[1]!;
        await ctx.answerCallbackQuery();
        if (id === "recommend") {
          await showRecommendedPractice(ctx, user.userId);
        } else {
          await showPractice(ctx, user.userId, id);
        }
        return;
      }

      if (data.startsWith("practice_done:")) {
        const id = data.split(":")[1]!;
        const p = getPractice(id);
        if (p) {
          store.addPractice(
            user.userId,
            p.id,
            p.title,
            p.durationMin * 60
          );
        }
        await ctx.answerCallbackQuery({ text: "Засчитано 🌿" });
        await ctx.reply(
          `Красиво. Практика «${p?.title ?? id}» отмечена.\n` +
            `Такие 3–5 минут копятся тише, чем кажется.`,
          { reply_markup: mainMenuKeyboard() }
        );
        resetSession(user.userId);
        return;
      }

      if (data.startsWith("coach_quick:")) {
        const kind = data.split(":")[1]!;
        await ctx.answerCallbackQuery();
        if (kind === "free") {
          setFlow(user.userId, "coach_chat");
          await ctx.reply(
            "Напиши, что сейчас с тобой — можно коротко, без «правильных» формулировок."
          );
          return;
        }
        const prompts: Record<string, string> = {
          burnout:
            "Чувствую выгорание: мало сил, всё через «надо». Помоги мягко на ближайший час.",
          anxiety:
            "Сейчас тревожно в теле и в голове. Помоги заземлиться и разобрать мысль.",
          sleep:
            "Проблемы со сном / не могу отключиться. Дай короткий вечерний план.",
          sad: "Сейчас грустно и тяжело внутри. Не нужно «взбодрить» — просто рядом и один маленький шаг.",
          lonely:
            "Чувствую одиночество, даже если вокруг люди. Помоги мягко побыть с этим.",
          overwhelm:
            "Голова перегружена, слишком много всего. Помоги разложить и снять давление.",
        };
        const msg = prompts[kind];
        if (msg) await handleCoachMessage(ctx, user.userId, msg);
        return;
      }

      if (data === "nav:home") {
        await ctx.answerCallbackQuery();
        resetSession(user.userId);
        try {
          await ctx.editMessageText("Хорошо. Я рядом, когда понадоблюсь 🌿");
        } catch {
          /* message not editable */
        }
        await ctx.reply("Меню:", { reply_markup: mainMenuKeyboard() });
        return;
      }

      if (data === "nav:practices") {
        await ctx.answerCallbackQuery();
        await openPractices(ctx);
        return;
      }

      if (data === "nav:coach") {
        await ctx.answerCallbackQuery();
        await openCoach(ctx);
        return;
      }

      if (data === "nav:premium") {
        await ctx.answerCallbackQuery();
        await openPremium(ctx);
        return;
      }

      if (data.startsWith("plan:trial:")) {
        const plan = data.split(":")[2] as "care" | "plus";
        await ctx.answerCallbackQuery();
        if (plan !== "care" && plan !== "plus") return;
        try {
          const u = store.startTrial(user.userId, plan);
          await ctx.reply(
            `🎁 *Пробный период активирован*\n\n` +
              `Тариф «${PLANS[plan].title}» на *3 дня* — бесплатно.\n` +
              `Действует до ${new Date(u.premiumUntil!).toLocaleDateString("ru-RU")}.\n\n` +
              `Можно пользоваться всеми возможностями тарифа. Потом — останешься на free или оформишь подписку.`,
            { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
          );
        } catch (e) {
          const err = e as Error & { message?: string };
          await ctx.reply(
            err.message || "Не удалось активировать пробный период.",
            { reply_markup: plansKeyboard() }
          );
        }
        return;
      }

      if (data.startsWith("plan:")) {
        const plan = data.split(":")[1] as "free" | "care" | "plus";
        await ctx.answerCallbackQuery();
        if (plan === "free") {
          store.updateUser(user.userId, {
            plan: "free",
            premiumUntil: undefined,
            isTrial: false,
          });
          await ctx.reply(
            "Остаёшься на бесплатном тарифе — и этого уже достаточно для ежедневной опоры.",
            { reply_markup: mainMenuKeyboard() }
          );
          return;
        }
        if (plan === "care" || plan === "plus") {
          await offerPlanPayment(ctx, user.userId, plan as PaidPlan);
        }
        return;
      }

      if (data.startsWith("pay_check:")) {
        const plan = data.split(":")[1] as PaidPlan;
        await ctx.answerCallbackQuery({ text: "Проверяю…" });
        const ok = await checkPendingPayments(user.userId);
        if (ok) {
          const u = store.getUser(user.userId)!;
          await ctx.reply(
            `✅ Оплата найдена. Тариф «${PLANS[u.plan || plan].title}» активен` +
              (u.premiumUntil
                ? ` до ${new Date(u.premiumUntil).toLocaleDateString("ru-RU")}`
                : "") +
              `.`,
            { reply_markup: mainMenuKeyboard() }
          );
        } else {
          await ctx.reply(
            "Пока не вижу оплату. Если только что заплатил(а) — подожди 10–30 сек и нажми «Я оплатил(а)» снова.\n" +
              "Или открой счёт в Crypto Bot ещё раз из «Подписка».",
            { reply_markup: plansKeyboard() }
          );
        }
        return;
      }

      if (data === "weekly_insight") {
        await ctx.answerCallbackQuery({ text: "Собираю…" });
        const u = store.getUser(user.userId)!;
        if (!store.isPremium(u) || u.plan !== "plus") {
          await ctx.reply(
            "Еженедельный AI-отчёт — в тарифе *Плюс* (349 ₽/мес).",
            {
              parse_mode: "Markdown",
              reply_markup: plansKeyboard(),
            }
          );
          return;
        }
        const text = await weeklyInsight(u);
        await ctx.reply(`📬 *Недельный отчёт*\n\n${text}`, {
          parse_mode: "Markdown",
        });
        return;
      }

      if (data === "feelings_analysis") {
        await ctx.answerCallbackQuery({ text: "Анализирую чувства…" });
        const u = store.getUser(user.userId)!;
        if (!store.isPremium(u) || u.plan !== "plus") {
          await ctx.reply(
            "Полный анализ чувств — в тарифе *Плюс* (349 ₽/мес).",
            {
              parse_mode: "Markdown",
              reply_markup: plansKeyboard(),
            }
          );
          return;
        }
        const analysis = await fullFeelingsAnalysis(u);
        const risk =
          analysis.summary.riskLevel === "hard"
            ? "тяжело"
            : analysis.summary.riskLevel === "watch"
              ? "внимание"
              : "опора";
        await ctx.reply(
          `🪞 *Полный анализ чувств*\n` +
            `_уровень: ${risk}_\n\n` +
            analysis.text.slice(0, 3500),
          { parse_mode: "Markdown" }
        );
        return;
      }

      await ctx.answerCallbackQuery();
    } catch (e) {
      console.error("callback error", e);
      await ctx.answerCallbackQuery({ text: "Ошибка, попробуй ещё раз" });
    }
  });

  // Free text depending on flow
  bot.on("message:text", async (ctx) => {
    const user = ensureUser(ctx);
    const session = getSession(user.userId);
    const text = ctx.message.text.trim();

    // Ignore if it's a menu button (already handled by hears)
    const menuButtons = [
      "🌤 Чек-ин",
      "🧘 Практики",
      "📝 Дневник",
      "📊 Стресс",
      "💬 AI-коуч",
      "📈 Статистика",
      "💎 Подписка",
      "ℹ️ Помощь",
    ];
    if (menuButtons.includes(text)) return;

    if (session.flow === "checkin_note") {
      await finishCheckin(ctx, user.userId, text.slice(0, 500));
      return;
    }

    if (session.flow === "stress_note") {
      await finishStress(ctx, user.userId, text.slice(0, 500));
      return;
    }

    if (session.flow === "journal_write") {
      const prompt = session.journalPrompt || "Свободная запись";
      const body = text.slice(0, 4000);
      store.addJournal(user.userId, prompt, body);
      resetSession(user.userId);
      const fresh = store.getUser(user.userId)!;
      if (await maybeSendCrisisHelp(ctx, fresh, body, "journal")) {
        return;
      }
      await ctx.reply(
        "Записал в дневник. Это остаётся у тебя в боте — никто «не оценивает».\n\n" +
          "Если всплыло что-то острое — можно сразу к AI-коучу или к дыханию.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    if (session.flow === "coach_chat") {
      await handleCoachMessage(ctx, user.userId, text);
      return;
    }

    // Free-text outside flows: still scan for crisis
    if (looksLikeCrisis(text) || scanUserForCrisis(user, [{ source: "chat", text }]).detected) {
      const fresh = store.getUser(user.userId)!;
      if (await maybeSendCrisisHelp(ctx, fresh, text, "chat")) {
        return;
      }
    }

    // Default: gentle nudge
    await ctx.reply(
      "Я лучше всего работаю через меню 👇\n" +
        "Или напиши /checkin · /coach · /stats · /help",
      { reply_markup: mainMenuKeyboard() }
    );
  });
}

/** Full crisis package in bot — for all users, no quota */
async function maybeSendCrisisHelp(
  ctx: Context,
  user: { userId: number; firstName?: string; focusAreas: FocusArea[] } | undefined | null,
  text: string,
  source: string
): Promise<boolean> {
  if (!user) return false;
  const full = store.getUser(user.userId);
  if (!full) return false;
  const scan = scanUserForCrisis(full, [{ source, text }]);
  if (!scan.detected && !looksLikeCrisis(text)) return false;
  try {
    await ctx.replyWithChatAction("typing");
    const help = await crisisAutoHelp(
      full,
      scan.detected
        ? scan
        : { detected: true, level: "crisis", matches: [], sources: [source] },
      text
    );
    store.pushCoachMessage(
      full.userId,
      "assistant",
      `⚠️ Кризисная поддержка\n\n${help.text}`
    );
    await ctx.reply(help.text, {
      reply_markup: afterCheckinKeyboard(),
    });
    return true;
  } catch (e) {
    console.error("maybeSendCrisisHelp", e);
    await ctx.reply(
      `${CRISIS_HINT}\n\n` +
        "Если совсем тяжело — позвони сейчас. Я рядом текстом, но живой контакт важнее.",
      { reply_markup: mainMenuKeyboard() }
    );
    return true;
  }
}

async function startCheckin(ctx: Context) {
  const user = ensureUser(ctx);
  const session = getSession(user.userId);
  session.pendingCheckin = {};
  session.flow = "checkin_mood";
  await ctx.reply(
    `🌤 *Чек-ин* · 2–3 минуты\n\n` +
      `Как *настроение* прямо сейчас?\n` +
      `_1 — очень тяжело · 5 — отлично_`,
    { parse_mode: "Markdown", reply_markup: moodKeyboard("cin_mood") }
  );
}

async function finishCheckin(
  ctx: Context,
  userId: number,
  note?: string
) {
  const session = getSession(userId);
  const p = session.pendingCheckin;
  if (!p.mood || !p.energy || !p.stress) {
    resetSession(userId);
    await ctx.reply("Чек-ин прерван. Можно начать снова: «🌤 Чек-ин».");
    return;
  }

  const user = store.addCheckin(userId, {
    mood: p.mood,
    energy: p.energy,
    stress: p.stress,
    sleep: p.sleep,
    note,
  });
  resetSession(userId);

  let tip =
    p.stress >= 4
      ? "Стресс высокий — хорошее время для 3 минут дыхания или заземления."
      : p.mood <= 2
        ? "Тяжело — и это уже замечено. Маленькая практика или пара строк в дневнике могут чуть удержать."
        : p.energy <= 2
          ? "Энергии мало. Сегодня нормально делать меньше, чем «надо»."
          : "Есть ресурс. Можно закрепить короткой практикой или просто выдохнуть.";

  // AI micro-insight for plus / when AI key present
  try {
    if (store.isPremium(user) || isAiConfigured()) {
      const insight = await checkinInsight(user);
      if (insight) tip = insight;
    }
  } catch {
    /* ignore */
  }

  await ctx.reply(
    `✅ Чек-ин сохранён\n\n` +
      `Настроение ${p.mood}/5 ${bar(p.mood)}\n` +
      `Энергия ${p.energy}/5 ${bar(p.energy)}\n` +
      `Стресс ${p.stress}/5 ${bar(p.stress)}\n` +
      (p.sleep ? `Сон ${p.sleep}/5 ${bar(p.sleep)}\n` : "") +
      (note ? `\n«${note.slice(0, 120)}»\n` : "") +
      `\n🔥 Серия: ${pluralDays(user.streak)}\n\n${tip}`,
    {
      reply_markup: afterCheckinKeyboard(),
    }
  );

  // Crisis from check-in note / history — everyone
  if (await maybeSendCrisisHelp(ctx, user, note || "", "checkin_note")) {
    return;
  }

  // Low scores → individualized support for free + paid (no coach quota)
  if (isBadResult({ mood: p.mood, energy: p.energy, stress: p.stress })) {
    try {
      const premium = store.isPremium(user);
      const help = await autoSupportOnBadResult(
        user,
        "checkin",
        {
          mood: p.mood,
          energy: p.energy,
          stress: p.stress,
          note,
        },
        { freeOnly: !premium }
      );
      store.pushCoachMessage(
        user.userId,
        "assistant",
        `🛟 Поддержка при низких показателях\n\n${help.text}`
      );
      await ctx.reply(
        `🛟 *Поддержка*\n\n${help.text}` +
          (help.practiceTitle ? `\n\nПрактика: ${help.practiceTitle}` : ""),
        {
          parse_mode: "Markdown",
          reply_markup: afterCheckinKeyboard(),
        }
      );
    } catch (e) {
      console.error("bot autoHelp", e);
    }
  }
}

async function openPractices(ctx: Context) {
  const user = ensureUser(ctx);
  const premium = store.isPremium(user);
  const focus = user.focusAreas.length ? user.focusAreas : (["general"] as FocusArea[]);
  const list = PRACTICES.filter(
    (p) => p.focus.some((f) => focus.includes(f)) || p.focus.includes("general")
  );
  // show focused first, then rest unique
  const ids = new Set(list.map((p) => p.id));
  const rest = PRACTICES.filter((p) => !ids.has(p.id));
  const merged = [...list, ...rest];

  await ctx.reply(
    `🧘 *Микро-практики*\n\n` +
      `Короткие упражнения на 2–6 минут: дыхание, CBT, тело, сон.\n` +
      (premium
        ? "Подписка активна — открыта вся библиотека."
        : "🔒 Часть практик — в подписке «Забота» от 199 ₽."),
    {
      parse_mode: "Markdown",
      reply_markup: practicesKeyboard(merged, premium),
    }
  );
}

async function showPractice(ctx: Context, userId: number, practiceId: string) {
  const user = store.getUser(userId)!;
  const p = getPractice(practiceId);
  if (!p) {
    await ctx.reply("Практика не найдена.");
    return;
  }
  if (!p.free && !store.isPremium(user)) {
    await ctx.reply(
      `🔒 «${p.title}» доступна в подписке.\n\n` +
        `Тарифы от *199 ₽/мес* — дешевле одной сессии у психолога, для ежедневной самопомощи.`,
      { parse_mode: "Markdown", reply_markup: plansKeyboard() }
    );
    return;
  }

  const steps = p.steps.map((s, i) => `*${i + 1}.* ${s}`).join("\n");
  await ctx.reply(
    `${p.emoji} *${p.title}* · ~${p.durationMin} мин\n\n` +
      `${p.intro}\n\n${steps}\n\n_${p.outro}_`,
    {
      parse_mode: "Markdown",
      reply_markup: practiceActionsKeyboard(p.id),
    }
  );
}

async function showRecommendedPractice(ctx: Context, userId: number) {
  const user = store.getUser(userId)!;
  const last = user.checkins[0];
  const p = recommendPractice(
    user.focusAreas,
    last?.mood,
    last?.stress,
    !store.isPremium(user)
  );
  await showPractice(ctx, userId, p.id);
}

async function startJournal(ctx: Context) {
  const user = ensureUser(ctx);
  const prompt = pickJournalPrompt();
  const session = getSession(user.userId);
  session.flow = "journal_write";
  session.journalPrompt = prompt;
  await ctx.reply(
    `📝 *Дневник*\n\n` +
      `Промпт на сейчас:\n_${prompt}_\n\n` +
      `Напиши ответ одним сообщением. Можно коротко — 2–5 предложений.`,
    { parse_mode: "Markdown" }
  );
}

async function startStress(ctx: Context) {
  const user = ensureUser(ctx);
  setFlow(user.userId, "stress_level");
  await ctx.reply(
    `📊 *Трекер стресса*\n\n` +
      `Оцени уровень прямо сейчас:\n` +
      `_1 — почти нет · 5 — на пределе_`,
    { parse_mode: "Markdown", reply_markup: moodKeyboard("stress_lv") }
  );
}

async function finishStress(
  ctx: Context,
  userId: number,
  note?: string
) {
  const session = getSession(userId);
  const level = session.pendingStressLevel;
  if (!level) {
    resetSession(userId);
    await ctx.reply("Запись стресса прервана.");
    return;
  }
  const srcId = session.pendingStressSource;
  const srcLabel = STRESS_SOURCES.find((s) => s.id === srcId)?.label;
  store.addStress(userId, level, srcLabel, note);
  resetSession(userId);
  const fresh = store.getUser(userId)!;

  const tip =
    level >= 4
      ? "Высокий стресс. 3 минуты квадратного дыхания или заземления 5–4–3–2–1 — хороший минимум."
      : level === 3
        ? "Средний уровень. Иногда помогает выписать 3 дела и выбрать одно «достаточно на сегодня»."
        : "Стресс умеренный. Можно просто отметить — уже полезно видеть динамику.";

  await ctx.reply(
    `Записал: стресс *${level}/5*${srcLabel ? ` · ${srcLabel}` : ""}\n\n${tip}`,
    {
      parse_mode: "Markdown",
      reply_markup: afterCheckinKeyboard(),
    }
  );

  if (note) {
    if (await maybeSendCrisisHelp(ctx, fresh, note, "stress_note")) {
      return;
    }
  }

  if (isBadResult({ stress: level })) {
    try {
      const premium = store.isPremium(fresh);
      const help = await autoSupportOnBadResult(
        fresh,
        "stress",
        { stress: level, note, source: srcLabel },
        { freeOnly: !premium }
      );
      store.pushCoachMessage(
        fresh.userId,
        "assistant",
        `🛟 Поддержка при высоком стрессе\n\n${help.text}`
      );
      await ctx.reply(
        `🛟 *Поддержка*\n\n${help.text}` +
          (help.practiceTitle ? `\n\nПрактика: ${help.practiceTitle}` : ""),
        {
          parse_mode: "Markdown",
          reply_markup: afterCheckinKeyboard(),
        }
      );
    } catch (e) {
      console.error("bot stress autoHelp", e);
    }
  }
}

async function openCoach(ctx: Context) {
  const user = ensureUser(ctx);
  const quota = store.canUseCoach(user);
  setFlow(user.userId, "coach_chat");
  await ctx.reply(
    `💬 *AI-коуч «Бережно»*\n\n` +
      `Тёплый разбор на русском: выгорание, тревога, сон, границы.\n` +
      `Не терапия — опора на 2–5 минут.\n\n` +
      `Сегодня: *${quota.remaining}* из ${quota.limit} сообщений.\n\n` +
      `${CRISIS_HINT}`,
    { parse_mode: "Markdown", reply_markup: coachKeyboard() }
  );
}

async function handleCoachMessage(
  ctx: Context,
  userId: number,
  text: string
) {
  let user = store.getUser(userId)!;
  const crisis = scanUserForCrisis(user, [{ source: "coach_now", text }]);
  const isCrisis = crisis.detected || looksLikeCrisis(text);

  const quota = store.canUseCoach(user);
  if (!quota.ok && !isCrisis) {
    await ctx.reply(
      `Лимит AI-коуча на сегодня исчерпан (${quota.limit}).\n\n` +
        `Завтра обновится — или открой подписку: 20–50 сообщений/день от 199 ₽.\n` +
        `А пока доступны чек-ин, дневник и практики.\n\n` +
        `${CRISIS_HINT}`,
      { reply_markup: plansKeyboard() }
    );
    return;
  }

  await ctx.replyWithChatAction("typing");
  store.pushCoachMessage(userId, "user", text);
  if (!isCrisis) store.consumeCoach(userId);
  user = store.getUser(userId)!;

  const { text: reply } = await coachReply(user, text);
  store.pushCoachMessage(userId, "assistant", reply);
  setFlow(userId, "coach_chat");

  const left = store.canUseCoach(store.getUser(userId)!).remaining;
  const footer = isCrisis
    ? "\n\n⚠️ Это сообщение не списало лимит — сейчас важнее поддержка."
    : `\n\nОсталось сообщений сегодня: ${left}`;
  await ctx.reply(`${reply}${footer}`, {
    reply_markup: coachKeyboard(),
  });
}

async function sendStats(ctx: Context) {
  const user = ensureUser(ctx);
  const s = store.weekStats(user);
  const premium = store.isPremium(user);

  await ctx.reply(
    `📈 *Твоя динамика (7 дней)*\n\n` +
      `🔥 Серия чек-инов: *${pluralDays(s.streak)}*\n` +
      `Чек-инов за неделю: ${s.checkinCount}\n` +
      `Практик: ${s.practiceCount}\n` +
      `Записей стресса: ${s.stressCount}\n\n` +
      `Настроение ср.: ${fmtAvg(s.avgMood)}/5 ${s.avgMood !== null ? bar(s.avgMood) : ""}\n` +
      `Энергия ср.: ${fmtAvg(s.avgEnergy)}/5 ${s.avgEnergy !== null ? bar(s.avgEnergy) : ""}\n` +
      `Стресс ср.: ${fmtAvg(s.avgStress)}/5 ${s.avgStress !== null ? bar(s.avgStress) : ""}\n\n` +
      `Фокус: ${user.focusAreas.map((f) => FOCUS_LABELS[f]).join(", ")}\n` +
      `Тариф: ${PLANS[user.plan || "free"].title}` +
      (premium && user.premiumUntil
        ? ` до ${new Date(user.premiumUntil).toLocaleDateString("ru-RU")}`
        : ""),
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🪞 Полный анализ чувств", "feelings_analysis")
        .row()
        .text("📬 Недельный AI-отчёт", "weekly_insight")
        .row()
        .text("« В меню", "nav:home"),
    }
  );
}

async function openPremium(ctx: Context) {
  const user = ensureUser(ctx);
  const lines = (Object.keys(PLANS) as (keyof typeof PLANS)[]).map((k) => {
    const p = PLANS[k];
    return (
      `${p.title} — ${p.price}\n` + p.perks.map((x) => `  • ${x}`).join("\n")
    );
  });

  const payHint = isCryptoPayConfigured()
    ? "Оплата: крипта через @CryptoBot (USDT, TON, BTC, ETH…), сумма в ₽."
    : "⚠️ Оплата временно недоступна — CRYPTO_PAY_TOKEN не настроен.";

  const status =
    store.isPremium(user) && user.premiumUntil
      ? `\n\nТвой тариф: ${PLANS[user.plan || "free"].title}${
          user.isTrial ? " (пробный)" : ""
        } до ${new Date(user.premiumUntil).toLocaleDateString("ru-RU")}`
      : "\n\nСейчас: бесплатный тариф. Можно взять 3 дня free на Заботу и/или Плюс.";

  await ctx.reply(
    `💎 Подписка careofme\n\n` +
      `Ежедневная опора: выгорание, тревога, сон — на русском.\n` +
      `Пробный период 3 дня · 199–349 ₽/мес · дешевле психолога.\n\n` +
      lines.join("\n\n") +
      `\n\n${payHint}${status}`,
    { reply_markup: plansKeyboard() }
  );
}

async function offerPlanPayment(
  ctx: Context,
  userId: number,
  plan: PaidPlan
) {
  const info = PLANS[plan];
  if (!isCryptoPayConfigured()) {
    await ctx.reply(
      `${info.title} — ${info.price}\n\n` +
        info.perks.map((p) => `• ${p}`).join("\n") +
        `\n\n⚠️ Оплата криптой не настроена на сервере.`,
      { reply_markup: plansKeyboard() }
    );
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
    const inv = await createPlanInvoice({
      userId,
      plan,
      botUsername: process.env.BOT_USERNAME || "careofme_bot",
    });
    store.trackInvoice(userId, inv.invoice_id, plan);
    const url = invoicePayUrl(inv);
    const { planPriceLabel } = await import("../payments/plans");
    await ctx.reply(
      `${info.title} — ${info.price} / 30 дней\n` +
        `${planPriceLabel(plan)}\n\n` +
        info.perks.map((p) => `• ${p}`).join("\n") +
        `\n\n💎 Оплата в Crypto Bot (USDT, фикс. курс ₽).\n` +
        `1) Нажми «Оплатить криптой»\n` +
        `2) Подтверди платёж\n` +
        `3) Вернись и нажми «Я оплатил(а)»\n\n` +
        `Счёт #${inv.invoice_id}`,
      {
        reply_markup: url
          ? payUrlKeyboard(url, plan)
          : confirmPlanKeyboard(plan),
      }
    );
  } catch (e) {
    console.error("create invoice", e);
    await ctx.reply(
      "Не удалось создать счёт Crypto Pay. Попробуй через 1 минуту.",
      { reply_markup: plansKeyboard() }
    );
  }
}



async function openMiniApp(ctx: Context) {
  const url = webappUrl();
  const appKb = openAppKeyboard();
  if (!url || !appKb) {
    await ctx.reply(
      "Mini App пока не подключён: задай *WEBAPP_URL* (HTTPS) в `.env` и перезапусти бота.\n\n" +
        "Пока пользуйся кнопками меню — чек-ин, практики, коуч работают в чате.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
    return;
  }
  await ctx.reply(
    "🌿 *Бережно* — приложение внутри Telegram\n\n" +
      "Чек-ин, практики, дневник, стресс, AI-коуч и статистика — в удобном интерфейсе.\n" +
      "Также: кнопка меню ☰ → «Открыть Бережно».",
    { parse_mode: "Markdown", reply_markup: appKb }
  );
}

async function sendHelp(ctx: Context) {
  await ctx.reply(
    `ℹ️ *Как пользоваться*\n\n` +
      `🌿 *Приложение* — /app или кнопка меню\n` +
      `🌤 *Чек-ин* — настроение, энергия, стресс, сон (2–3 мин)\n` +
      `🧘 *Практики* — дыхание, заземление, CBT, сон\n` +
      `📝 *Дневник* — короткий journaling с промптом\n` +
      `📊 *Стресс* — быстрая отметка уровня и источника\n` +
      `💬 *AI-коуч* — разговор на русском (лимиты по тарифу)\n` +
      `📈 *Статистика* — неделя и серия\n` +
      `💎 *Подписка* — 199 / 349 ₽\n\n` +
      `Команды: /start /app /checkin /coach /stats /help\n\n` +
      `${DISCLAIMER}\n\n` +
      `${CRISIS_HINT}`,
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
  );
}
