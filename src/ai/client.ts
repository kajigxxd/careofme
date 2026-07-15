import OpenAI from "openai";
import type { UserProfile } from "../db/store";
import {
  buildCoachSystemPrompt,
  CRISIS_HINT,
  FOCUS_LABELS,
} from "../data/prompts";
import { recommendPractice, getPractice } from "../data/practices";

const CRISIS_PATTERNS =
  /суицид|самоубий|убить себя|не хочу жить|хочу умереть|покончить|самоповреж|резать себя|прыгнуть с|нет смысла жить|пропадаю|нет сил жить/i;

export function looksLikeCrisis(text: string): boolean {
  return CRISIS_PATTERNS.test(text);
}

function getClient(): OpenAI | null {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: "https://api.x.ai/v1",
  });
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

function modelName(): string {
  return process.env.XAI_MODEL || "grok-4.5";
}

/** Rich context for the coach from user history */
function buildUserContext(user: UserProfile): string {
  const parts: string[] = [];
  parts.push(`Имя: ${user.firstName || "друг"}`);
  parts.push(
    `Фокус чувств: ${user.focusAreas.map((f) => FOCUS_LABELS[f] || f).join(", ") || "не указан"}`
  );
  parts.push(`Серия чек-инов: ${user.streak} дн.`);
  parts.push(`Тариф: ${user.plan || "free"}`);

  const last = user.checkins[0];
  if (last) {
    parts.push(
      `Последний чек-ин (${last.at.slice(0, 16)}): настроение ${last.mood}/5, энергия ${last.energy}/5, стресс ${last.stress}/5` +
        (last.sleep ? `, сон ${last.sleep}/5` : "") +
        (last.note ? `. Заметка человека: «${last.note.slice(0, 160)}»` : "")
    );
  }

  const week = user.checkins.slice(0, 7);
  if (week.length >= 2) {
    const avgM = week.reduce((s, c) => s + c.mood, 0) / week.length;
    const avgE = week.reduce((s, c) => s + c.energy, 0) / week.length;
    const avgS = week.reduce((s, c) => s + c.stress, 0) / week.length;
    parts.push(
      `За ${week.length} чек-инов: ср. настроение ${avgM.toFixed(1)}, энергия ${avgE.toFixed(1)}, стресс ${avgS.toFixed(1)}`
    );
    // Trend hint
    if (week.length >= 3) {
      const older = week.slice(Math.floor(week.length / 2));
      const newer = week.slice(0, Math.floor(week.length / 2));
      const oM = older.reduce((s, c) => s + c.mood, 0) / older.length;
      const nM = newer.reduce((s, c) => s + c.mood, 0) / newer.length;
      if (nM - oM <= -0.6) parts.push("Тренд: настроение недавно ниже, чем раньше.");
      else if (nM - oM >= 0.6) parts.push("Тренд: настроение недавно чуть выше.");
    }
  }

  const stressPts = user.stress.slice(0, 4);
  if (stressPts.length) {
    parts.push(
      "Недавний стресс: " +
        stressPts
          .map(
            (s) =>
              `${s.level}/5` +
              (s.source ? ` (${s.source})` : "") +
              (s.note ? ` «${s.note.slice(0, 50)}»` : "")
          )
          .join("; ")
    );
  }

  const practice = user.practices[0];
  if (practice) {
    parts.push(`Последняя практика: «${practice.title}»`);
  }

  const journals = user.journal.slice(0, 3);
  if (journals.length) {
    parts.push(
      "Дневник (фрагменты): " +
        journals.map((j) => `«${(j.text || "").slice(0, 120)}»`).join(" | ")
    );
  }

  // Recent coach thread for continuity (beyond messages already in chat)
  const recentCoach = user.coachMessages.slice(-4);
  if (recentCoach.length) {
    parts.push(
      "Недавний диалог с коучем (сжато): " +
        recentCoach
          .map(
            (m) =>
              `${m.role === "user" ? "он/она" : "коуч"}: ${m.content.slice(0, 80)}`
          )
          .join(" · ")
    );
  }

  return parts.join("\n");
}

export type CoachResult = {
  text: string;
  usedFallback: boolean;
  suggestedPracticeId?: string;
};

export async function coachReply(
  user: UserProfile,
  userMessage: string
): Promise<CoachResult> {
  if (looksLikeCrisis(userMessage)) {
    return {
      text:
        `${CRISIS_HINT}\n\n` +
        "Я рядом текстом, но сейчас важнее живой контакт. " +
        "Если можешь — напиши близкому человеку или позвони на линию доверия. " +
        "Когда станет чуть безопаснее — можем разобрать одну маленькую опору на ближайший час.",
      usedFallback: true,
    };
  }

  const last = user.checkins[0];
  const suggested = recommendPractice(
    user.focusAreas,
    last?.mood,
    last?.stress,
    !user.plan || user.plan === "free"
  );

  const client = getClient();
  if (!client) {
    return {
      text: fallbackCoach(user, userMessage, suggested.id),
      usedFallback: true,
      suggestedPracticeId: suggested.id,
    };
  }

  // More history for continuity; trim long bubbles
  const history = user.coachMessages.slice(-20).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content.slice(0, 1200),
  }));

  const system =
    buildCoachSystemPrompt(user) +
    "\n\nДоп. снимок состояния:\n" +
    buildUserContext(user);

  const practiceHint =
    `\n\nПрактику «${suggested.emoji} ${suggested.title}» (~${suggested.durationMin} мин) предлагай ТОЛЬКО если она реально подходит к тексту человека. ` +
    `Не в каждом ответе. Не как скрипт «открой практику X». Можно просто словами, без id. ` +
    `Если человек в остром истощении — лучше ещё меньший шаг, чем полноценная практика.`;

  const turnHint =
    `\n\nСейчас ответь на ЭТО сообщение человека. Не повторяй дословно прошлые ответы. ` +
    `Не используй шаблон «валидация + 3 пункта + вопрос» как ритуал. ` +
    `Сделай ответ индивидуальным: отзеркаль его формулировки, учти чек-ины/фокус. ` +
    `Цель — чтобы после прочтения стало чуть легче или яснее, а не стыднее и не «должен ещё работать над собой».`;

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.88,
      max_tokens: 1100,
      messages: [
        { role: "system", content: system + practiceHint + turnHint },
        ...history,
        { role: "user", content: userMessage },
      ],
    });

    let text =
      resp.choices[0]?.message?.content?.trim() ||
      fallbackCoach(user, userMessage, suggested.id);

    // Strip markdown-heavy if any accidental
    text = text.replace(/\*\*/g, "*");
    // Soften over-scripted openers if model slips
    text = text.replace(
      /^(Я слышу тебя\.?|Слышу тебя\.?|Понимаю тебя\.?)\s*/i,
      ""
    );

    return {
      text,
      usedFallback: false,
      suggestedPracticeId: suggested.id,
    };
  } catch (err) {
    console.error("AI coach error:", err);
    return {
      text: fallbackCoach(user, userMessage, suggested.id),
      usedFallback: true,
      suggestedPracticeId: suggested.id,
    };
  }
}

/** Reflection after check-in — personal, not a canned tip */
export async function checkinInsight(
  user: UserProfile
): Promise<string | null> {
  const last = user.checkins[0];
  if (!last) return null;

  const name = user.firstName || "";
  const focus = user.focusAreas.map((f) => FOCUS_LABELS[f] || f).join(", ");
  const client = getClient();
  if (!client) {
    const bits: string[] = [];
    if (name) bits.push(`${name},`);
    if (last.mood <= 2 && last.stress >= 4) {
      bits.push(
        `и настроение, и стресс сегодня тяжёлые — это уже много информации, не «просто плохой день».`
      );
      bits.push(
        `Не обязательно сейчас всё чинить: достаточно одной опоры для тела (вода, воздух, тёплое) и разрешения сделать меньше.`
      );
    } else if (last.stress >= 4) {
      bits.push(
        `стресс ${last.stress}/5 — система в режиме «напрячься».`
      );
      bits.push(
        `Имеет смысл не разгонять голову, а чуть сбросить тело: длинный выдох, плечи вниз, 2–3 минуты без экрана.`
      );
    } else if (last.mood <= 2) {
      bits.push(
        `настроение ${last.mood}/5 — тяжело, и это уже замечено.`
      );
      bits.push(
        `Сегодня можно не тянуть норму «как обычно». Один крошечный жест заботы о себе считается.`
      );
    } else if (last.energy <= 2) {
      bits.push(
        `энергии ${last.energy}/5 — мало топлива, не лень.`
      );
      bits.push(
        `Лучше укоротить день на 10–20%, чем доказывать себе выносливость.`
      );
    } else {
      bits.push(
        `чек-ин: настроение ${last.mood}, энергия ${last.energy}, стресс ${last.stress}. Есть на что опереться.`
      );
      if (last.note) {
        bits.push(`Ты отметил(а): «${last.note.slice(0, 80)}» — это важно не потерять.`);
      }
    }
    if (focus && last.mood <= 3) {
      bits.push(`На фоне твоего фокуса (${focus}) это особенно понятно.`);
    }
    return bits.join(" ");
  }

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.85,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Человек только что сделал чек-ин. " +
            "Напиши 3–6 живых предложений на русском: как читается его состояние СЕГОДНЯ, " +
            "с опорой на цифры, заметку и фокус. Без приветствия, без диагнозов, без списка «1)2)3)». " +
            "Не загоняй: не дави «исправь себя», дай облегчение и максимум один мягкий вариант опоры. " +
            "Звучи по-человечески, не как шаблон приложения.",
        },
        {
          role: "user",
          content:
            `${buildUserContext(user)}\n\n` +
            `Свежий чек-ин: настроение ${last.mood}/5, энергия ${last.energy}/5, стресс ${last.stress}/5` +
            (last.sleep ? `, сон ${last.sleep}/5` : "") +
            (last.note ? `. Заметка: «${last.note}»` : "") +
            `. Фокус: ${focus || "не указан"}.`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function fallbackCoach(
  user: UserProfile,
  message: string,
  practiceId?: string
): string {
  const lower = message.toLowerCase();
  const name = user.firstName || "";
  const p = practiceId ? getPractice(practiceId) : undefined;
  const last = user.checkins[0];
  const focus = user.focusAreas
    .slice(0, 2)
    .map((f) => FOCUS_LABELS[f] || f)
    .join(" и ");

  // Pull a concrete fragment from their message so it doesn't feel generic
  const snippet = message.replace(/\s+/g, " ").trim().slice(0, 90);
  const open =
    snippet.length > 12
      ? `${name ? name + ", " : ""}ты пишешь: «${snippet}${message.length > 90 ? "…" : ""}» — это уже многое объясняет.`
      : `${name ? name + ", " : ""}я с тобой в этом.`;

  const checkinBit = last
    ? ` В последнем чек-ине у тебя настроение ${last.mood}/5 и стресс ${last.stress}/5` +
      (last.note ? `, и ты отмечал(а): «${last.note.slice(0, 60)}»` : "") +
      "."
    : "";

  const focusBit = focus
    ? ` На фоне того, что тебе близко (${focus}), это особенно чувствительно.`
    : "";

  const softClose = p
    ? `\n\nЕсли силы есть — можно ${p.emoji} «${p.title}» (~${p.durationMin} мин). Если нет — достаточно воды, воздуха или просто ничего не делать 10 минут. Оба варианта нормальны.`
    : `\n\nСейчас можно не «чинить жизнь». Достаточно одного бережного жеста к себе — или паузы без задачи.`;

  if (/не сплю|бессон|не могу уснуть|кошмар|отключиться/.test(lower)) {
    return (
      `${open}${checkinBit}\n\n` +
      `Когда сон ускользает, часто включается борьба: «надо уснуть любой ценой» — и она сама будит.` +
      focusBit +
      `\n\nНа ближайшие минуты можно снять с себя цель уснуть: достаточно лежать и отдыхать. ` +
      `Если мысль крутится — коротко сбросить её на бумагу/в заметки, без решения. ` +
      `Длинный выдох иногда помогает телу, но это не экзамен.` +
      softClose
    );
  }

  if (/тревог|паник|волн|сердце колотится|страшно|нервн/.test(lower)) {
    return (
      `${open}${checkinBit}\n\n` +
      `Тревога часто ощущается в теле громче, чем в словах — и это пугает само по себе.` +
      focusBit +
      `\n\nНе обязательно прямо сейчас «понять причину». Можно чуть заземлиться: назвать вслух 3 вещи, которые видишь, ` +
      `почувствовать стопы/опору, сделать несколько выдохов длиннее вдоха. ` +
      `Если мысль очень липкая — можно мягко отделить: «это мысль, не приговор».` +
      softClose
    );
  }

  if (/выгор|нет сил|выжат|не могу больше|апати|устал|вымотан/.test(lower)) {
    return (
      `${open}${checkinBit}\n\n` +
      `Это больше похоже на истощение, чем на «лень» или слабость.` +
      focusBit +
      `\n\nСегодня можно убрать героизм: что реально можно отложить или упростить на 10%? ` +
      `Даже «встал и написал сюда» — уже действие. ` +
      `Телу сейчас важнее восстановление, чем продуктивность.` +
      softClose
    );
  }

  if (/отношен|ссор|обид|один|одиноч|партн|друг|преда|бросил/.test(lower)) {
    return (
      `${open}${checkinBit}\n\n` +
      `В отношениях часто болит не только событие, а то, что оно значит для тебя: нужность, безопасность, уважение.` +
      focusBit +
      `\n\nМожно не разбирать всё сразу. Достаточно заметить: какая эмоция сейчас главная — обида, страх, злость, пустота? ` +
      `И что тебе нужно в первую очередь: быть услышанным, пространство, ясность, тепло. ` +
      `Ответ себе одной фразой уже чуть разгружает.` +
      softClose
    );
  }

  return (
    `${open}${checkinBit}${focusBit}\n\n` +
    `Не буду загонять тебя в план «исправь себя». ` +
    `Если хочешь — напиши ещё чуть подробнее, что сейчас давит сильнее всего. ` +
    `Если сил мало — можно просто остаться с этим текстом: ты уже сделал(а) шаг, когда написал(а).` +
    softClose
  );
}

export async function weeklyInsight(user: UserProfile): Promise<string> {
  const checkins = user.checkins.slice(0, 14);
  if (!checkins.length) {
    return "Пока мало данных для отчёта. Сделай несколько чек-инов — и я соберу картину недели.";
  }

  const lines = checkins
    .map(
      (c) =>
        `${c.at.slice(0, 10)}: mood=${c.mood} energy=${c.energy} stress=${c.stress}` +
        (c.note ? ` note=${c.note.slice(0, 60)}` : "")
    )
    .join("\n");

  const client = getClient();
  if (!client) {
    const avgMood =
      checkins.reduce((s, c) => s + c.mood, 0) / checkins.length;
    const avgStress =
      checkins.reduce((s, c) => s + c.stress, 0) / checkins.length;
    return (
      `📊 *Краткая сводка*\n\n` +
      `Среднее настроение: ${avgMood.toFixed(1)}/5\n` +
      `Средний стресс: ${avgStress.toFixed(1)}/5\n` +
      `Чек-инов: ${checkins.length}\n` +
      `Серия: ${user.streak} дн.\n\n` +
      (avgStress >= 3.5
        ? "Стресс заметный — чаще дыхание и границы по нагрузке."
        : "Есть опора. Короткие ритуалы копятся.")
    );
  }

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.8,
      max_tokens: 750,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Недельный разбор на русском для конкретного человека. " +
            "Пиши живо, персонально, 150–280 слов. " +
            "Свяжи цифры чек-инов с его фокусом чувств и заметками. " +
            "Не шаблон «3 наблюдения + 2 совета». Не загоняй в план самосовершенствования. " +
            "Дай облегчающую рамку + 1–2 мягких опоры на выбор. Без диагнозов.",
        },
        {
          role: "user",
          content: `${buildUserContext(user)}\n\nДанные чек-инов:\n${lines}`,
        },
      ],
    });
    return (
      resp.choices[0]?.message?.content?.trim() ||
      "Не удалось собрать отчёт. Попробуй позже."
    );
  } catch (e) {
    console.error(e);
    return "Не удалось собрать AI-отчёт. Попробуй позже или открой «Статистику».";
  }
}

/** Bad check-in / stress scores that should trigger Plus auto-help */
export function isBadResult(scores: {
  mood?: number | null;
  energy?: number | null;
  stress?: number | null;
}): boolean {
  if (scores.mood != null && scores.mood <= 2) return true;
  if (scores.stress != null && scores.stress >= 4) return true;
  if (scores.energy != null && scores.energy <= 2) return true;
  return false;
}

export type RiskLevel = "ok" | "watch" | "hard";

export type FeelingsAnalysis = {
  text: string;
  summary: {
    dominantFeelings: string[];
    riskLevel: RiskLevel;
    avgMood: number | null;
    avgEnergy: number | null;
    avgStress: number | null;
    checkinCount: number;
  };
  usedFallback: boolean;
};

function avgOf(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeRisk(
  avgMood: number | null,
  avgStress: number | null,
  lastMood?: number,
  lastStress?: number
): RiskLevel {
  if (
    (lastMood != null && lastMood <= 2) ||
    (lastStress != null && lastStress >= 4) ||
    (avgMood != null && avgMood <= 2.3) ||
    (avgStress != null && avgStress >= 3.8)
  ) {
    return "hard";
  }
  if (
    (lastMood != null && lastMood <= 3) ||
    (lastStress != null && lastStress >= 3) ||
    (avgMood != null && avgMood <= 3.2) ||
    (avgStress != null && avgStress >= 3)
  ) {
    return "watch";
  }
  return "ok";
}

function fallbackFeelingsAnalysis(user: UserProfile): FeelingsAnalysis {
  const week = user.checkins.slice(0, 14);
  const avgMood = avgOf(week.map((c) => c.mood));
  const avgEnergy = avgOf(week.map((c) => c.energy));
  const avgStress = avgOf(week.map((c) => c.stress));
  const last = week[0];
  const riskLevel = computeRisk(
    avgMood,
    avgStress,
    last?.mood,
    last?.stress
  );
  const dominant = user.focusAreas
    .slice(0, 4)
    .map((f) => FOCUS_LABELS[f] || f);

  const lines = [
    "🪞 Полный разбор чувств (краткий режим)",
    "",
    `Что ты отметил(а) как важное: ${dominant.join(", ") || "общее состояние"}.`,
    avgMood != null
      ? `Среднее настроение за данные: ${avgMood.toFixed(1)}/5, энергия ${avgEnergy?.toFixed(1) ?? "—"}/5, стресс ${avgStress?.toFixed(1) ?? "—"}/5.`
      : "Пока мало чек-инов — картина ещё складывается. Каждый чек-ин делает разбор точнее.",
    "",
    riskLevel === "hard"
      ? "Сейчас тяжело или стресс высокий. Нормально не «держать лицо»: 3 минуты дыхания/заземления + один маленький бытовой шаг (вода, воздух, еда) важнее разборов."
      : riskLevel === "watch"
        ? "Есть зона напряжения. Имеет смысл короткие ритуалы и границы по нагрузке — без героизма."
        : "Есть опора. Можно закрепить тем, что уже помогает, и не ждать «идеального» состояния.",
    "",
    "Это не диагноз — ориентир для бережной самопомощи.",
  ];

  return {
    text: lines.join("\n"),
    summary: {
      dominantFeelings: dominant,
      riskLevel,
      avgMood,
      avgEnergy,
      avgStress,
      checkinCount: week.length,
    },
    usedFallback: true,
  };
}

/**
 * Plus: full multi-source analysis of feelings (focus + checkins + stress + journal).
 */
export async function fullFeelingsAnalysis(
  user: UserProfile
): Promise<FeelingsAnalysis> {
  const week = user.checkins.slice(0, 14);
  const avgMood = avgOf(week.map((c) => c.mood));
  const avgEnergy = avgOf(week.map((c) => c.energy));
  const avgStress = avgOf(week.map((c) => c.stress));
  const last = week[0];
  const riskLevel = computeRisk(
    avgMood,
    avgStress,
    last?.mood,
    last?.stress
  );
  const dominant = user.focusAreas
    .slice(0, 6)
    .map((f) => FOCUS_LABELS[f] || f);

  const baseSummary = {
    dominantFeelings: dominant,
    riskLevel,
    avgMood,
    avgEnergy,
    avgStress,
    checkinCount: week.length,
  };

  const checkinLines = week
    .map(
      (c) =>
        `${c.at.slice(0, 10)} mood=${c.mood} energy=${c.energy} stress=${c.stress}` +
        (c.sleep ? ` sleep=${c.sleep}` : "") +
        (c.note ? ` «${c.note.slice(0, 80)}»` : "")
    )
    .join("\n");

  const stressLines = user.stress
    .slice(0, 10)
    .map(
      (s) =>
        `${s.at.slice(0, 10)} level=${s.level}` +
        (s.source ? ` src=${s.source}` : "") +
        (s.note ? ` «${s.note.slice(0, 60)}»` : "")
    )
    .join("\n");

  const journalLines = user.journal
    .slice(0, 5)
    .map((j) => `${j.at.slice(0, 10)}: ${(j.text || "").slice(0, 120)}`)
    .join("\n");

  const client = getClient();
  if (!client) {
    return fallbackFeelingsAnalysis(user);
  }

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.78,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme: внимательный разбор чувств на русском для ОДНОГО человека. " +
            "Пиши как умный тёплый человек, не как отчёт-шаблон и не как скрипт коучинга.\n" +
            "Собери цельную картину: что на поверхности, что может быть глубже (гипотезы, не диагнозы), " +
            "как это стыкуется с его фокусом и цифрами, какие паттерны видны.\n" +
            "Важно: НЕ загонять — не превращай разбор в список недостатков и «надо работать над собой». " +
            "Цель — чтобы человеку стало понятнее и чуть спокойнее.\n" +
            "В конце — 2 мягкие опоры на выбор (не приказы). Если risk=hard — мягко про живую помощь (8-800-2000-122, 112).\n" +
            "200–380 слов. Без лекарств, без диагнозов, без токсичного позитива. Можно короткие подзаголовки, но не жёсткий нумерованный протокол.",
        },
        {
          role: "user",
          content:
            `${buildUserContext(user)}\n\n` +
            `Фокусы (как человек назвал чувства): ${dominant.join(", ") || "не указаны"}\n` +
            `Риск (эвристика): ${riskLevel}\n` +
            `Средние: mood=${avgMood?.toFixed(1) ?? "—"} energy=${avgEnergy?.toFixed(1) ?? "—"} stress=${avgStress?.toFixed(1) ?? "—"}\n\n` +
            `Чек-ины:\n${checkinLines || "нет"}\n\n` +
            `Стресс-точки:\n${stressLines || "нет"}\n\n` +
            `Дневник (фрагменты):\n${journalLines || "нет"}`,
        },
      ],
    });
    const text =
      resp.choices[0]?.message?.content?.trim() ||
      fallbackFeelingsAnalysis(user).text;
    return {
      text: text.replace(/\*\*/g, "*"),
      summary: baseSummary,
      usedFallback: false,
    };
  } catch (e) {
    console.error("fullFeelingsAnalysis", e);
    return fallbackFeelingsAnalysis(user);
  }
}

export type AutoHelpResult = {
  text: string;
  practiceId?: string;
  practiceTitle?: string;
  usedFallback: boolean;
  trigger: "checkin" | "stress";
};

/**
 * Plus: automatic AI support when scores look hard (no coach quota charge).
 */
export async function autoSupportOnBadResult(
  user: UserProfile,
  trigger: "checkin" | "stress",
  scores: {
    mood?: number | null;
    energy?: number | null;
    stress?: number | null;
    note?: string;
    source?: string;
  }
): Promise<AutoHelpResult> {
  const practice = recommendPractice(
    user.focusAreas,
    scores.mood ?? user.checkins[0]?.mood,
    scores.stress ?? user.checkins[0]?.stress,
    false // plus → full library
  );

  const scoreLine =
    trigger === "stress"
      ? `Стресс ${scores.stress}/5` +
        (scores.source ? `, источник: ${scores.source}` : "") +
        (scores.note ? `. Заметка: ${scores.note}` : "")
      : `Настроение ${scores.mood}/5, энергия ${scores.energy}/5, стресс ${scores.stress}/5` +
        (scores.note ? `. Заметка: ${scores.note}` : "");

  const client = getClient();
  if (!client) {
    const name = user.firstName ? `${user.firstName}, ` : "";
    const focus = user.focusAreas
      .slice(0, 2)
      .map((f) => FOCUS_LABELS[f] || f)
      .join(" и ");
    const text =
      `${name}цифры сейчас тяжёлые (${scoreLine}). Это не «ты слабый» — это сигнал системы.\n\n` +
      (focus ? `С учётом того, что тебе близко (${focus}), такое состояние особенно изматывает.\n\n` : "") +
      `Не нужно прямо сейчас разгребать всю жизнь. Достаточно снизить давление на тело: ` +
      `вода или воздух, плечи вниз, несколько выдохов длиннее вдоха. ` +
      `Если останутся силы — можно «${practice.emoji} ${practice.title}», но это не обязанность.\n\n` +
      `Если совсем невыносимо и есть мысли о вреде себе — 8-800-2000-122 или 112. Ты не обязан(а) справляться в одиночку.`;
    return {
      text,
      practiceId: practice.id,
      practiceTitle: `${practice.emoji} ${practice.title}`,
      usedFallback: true,
      trigger,
    };
  }

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.88,
      max_tokens: 650,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Человек только что отметил плохие показатели — нужна АВТОПОМОЩЬ. " +
            "Пиши 120–220 слов на русском, живо и персонально. " +
            "Не скрипт «валидация + 3 пункта + практика». " +
            "Сначала сними стыд и давление, свяжи цифры с его фокусом/контекстом, " +
            "предложи 1–2 мягких опоры на выбор (можно практику, но не как приказ). " +
            "Цель — чтобы стало чуть легче, а не «надо срочно работать над собой». " +
            "Без диагнозов. Если похоже на кризис — линия доверия 8-800-2000-122, 112.",
        },
        {
          role: "user",
          content:
            `${buildUserContext(user)}\n` +
            `Триггер: ${trigger}\n${scoreLine}\n` +
            `Практика (предложить мягко, если уместно): ${practice.emoji} ${practice.title} (~${practice.durationMin} мин)`,
        },
      ],
    });
    const text =
      resp.choices[0]?.message?.content?.trim() ||
      "Сейчас тяжело. Можно не чинить всё сразу — достаточно воды, воздуха и разрешения сделать меньше.";
    return {
      text: text.replace(/\*\*/g, "*"),
      practiceId: practice.id,
      practiceTitle: `${practice.emoji} ${practice.title}`,
      usedFallback: false,
      trigger,
    };
  } catch (e) {
    console.error("autoSupportOnBadResult", e);
    return {
      text:
        "Сейчас тяжело — и это уже достаточно, чтобы замедлиться. " +
        "Не загоняй себя в «надо исправиться». Глоток воды, длинный выдох, меньше дел на ближайший час. " +
        `Если захочешь опору — «${practice.emoji} ${practice.title}», без обязательства.`,
      practiceId: practice.id,
      practiceTitle: `${practice.emoji} ${practice.title}`,
      usedFallback: true,
      trigger,
    };
  }
}
