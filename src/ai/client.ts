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
    `Фокус: ${user.focusAreas.map((f) => FOCUS_LABELS[f] || f).join(", ")}`
  );
  parts.push(`Серия чек-инов: ${user.streak} дн.`);
  parts.push(`Тариф: ${user.plan || "free"}`);

  const last = user.checkins[0];
  if (last) {
    parts.push(
      `Последний чек-ин (${last.at.slice(0, 16)}): настроение ${last.mood}/5, энергия ${last.energy}/5, стресс ${last.stress}/5` +
        (last.sleep ? `, сон ${last.sleep}/5` : "") +
        (last.note ? `. Заметка: «${last.note.slice(0, 120)}»` : "")
    );
  }

  const stress = user.stress[0];
  if (stress) {
    parts.push(
      `Последний стресс: ${stress.level}/5` +
        (stress.source ? ` · ${stress.source}` : "") +
        (stress.note ? ` · ${stress.note.slice(0, 80)}` : "")
    );
  }

  const practice = user.practices[0];
  if (practice) {
    parts.push(`Последняя практика: «${practice.title}»`);
  }

  const journal = user.journal[0];
  if (journal) {
    parts.push(
      `Последняя запись в дневнике: «${journal.text.slice(0, 150)}»`
    );
  }

  // Pattern from week
  const week = user.checkins.slice(0, 7);
  if (week.length >= 3) {
    const avgM = week.reduce((s, c) => s + c.mood, 0) / week.length;
    const avgS = week.reduce((s, c) => s + c.stress, 0) / week.length;
    parts.push(
      `За ${week.length} чек-инов: ср. настроение ${avgM.toFixed(1)}, ср. стресс ${avgS.toFixed(1)}`
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

  const history = user.coachMessages.slice(-16).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const system = buildCoachSystemPrompt(user) + "\n\n" + buildUserContext(user);
  const practiceHint =
    `\n\nЕсли уместно, мягко предложи практику «${suggested.emoji} ${suggested.title}» (~${suggested.durationMin} мин) — id: ${suggested.id}. ` +
    `Не навязывай. Один раз за ответ максимум.`;

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.75,
      max_tokens: 700,
      messages: [
        { role: "system", content: system + practiceHint },
        ...history,
        { role: "user", content: userMessage },
      ],
    });

    let text =
      resp.choices[0]?.message?.content?.trim() ||
      fallbackCoach(user, userMessage, suggested.id);

    // Strip markdown-heavy if any accidental
    text = text.replace(/\*\*/g, "*");

    return {
      text,
      usedFallback: false,
      suggestedPracticeId: suggested.id,
    };
  } catch (err) {
    console.error("AI coach error:", err);
    return {
      text:
        fallbackCoach(user, userMessage, suggested.id) +
        "\n\n_Сейчас модель недоступна — ответил запасным режимом._",
      usedFallback: true,
      suggestedPracticeId: suggested.id,
    };
  }
}

/** Short reflection after check-in (1–3 sentences) */
export async function checkinInsight(
  user: UserProfile
): Promise<string | null> {
  const last = user.checkins[0];
  if (!last) return null;

  const client = getClient();
  if (!client) {
    if (last.stress >= 4) {
      return "Стресс высокий — 3 минуты дыхания или заземления сейчас уместнее, чем «разобраться со всем».";
    }
    if (last.mood <= 2) {
      return "Тяжело — и это уже замечено. Одна маленькая опора (вода, воздух, короткая практика) достаточно на сейчас.";
    }
    if (last.energy <= 2) {
      return "Энергии мало. Сегодня нормально делать меньше, чем «надо».";
    }
    return "Чек-ин сохранён. Есть опора — можно закрепить короткой практикой.";
  }

  try {
    const resp = await client.chat.completions.create({
      model: modelName(),
      temperature: 0.6,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Дай 1–3 коротких предложения на русском после чек-ина: валидация + один микро-совет. Без диагнозов. Без приветствия.",
        },
        {
          role: "user",
          content: `Настроение ${last.mood}/5, энергия ${last.energy}/5, стресс ${last.stress}/5` +
            (last.sleep ? `, сон ${last.sleep}/5` : "") +
            (last.note ? `. Заметка: ${last.note}` : "") +
            `. Фокус: ${user.focusAreas.join(", ")}`,
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
  const name = user.firstName ? `${user.firstName}, ` : "";
  const p = practiceId ? getPractice(practiceId) : undefined;
  const practiceLine = p
    ? `\n\nМожно открыть практику: *${p.emoji} ${p.title}* (~${p.durationMin} мин).`
    : "";

  if (/не сплю|бессон|не могу уснуть|кошмар|отключиться/.test(lower)) {
    return (
      `${name}бессонница часто усиливается от борьбы со сном.\n\n` +
      `На 5 минут:\n` +
      `1) Запиши 3 «хвоста» дел на завтра\n` +
      `2) Дыхание: вдох 4, выдох 6–8 × 5\n` +
      `3) Фраза: «Мне не обязательно уснуть — достаточно отдыхать»` +
      practiceLine
    );
  }

  if (/тревог|паник|волн|сердце колотится|страшно|нервн/.test(lower)) {
    return (
      `${name}тревога в теле — неприятно, но не всегда значит опасность.\n\n` +
      `2 минуты:\n` +
      `• 5 предметов, которые видишь\n` +
      `• 4, которые можешь потрогать\n` +
      `• 3 звука\n` +
      `Потом квадратное дыхание 4–4–4–4.` +
      practiceLine +
      `\n\nКакая мысль крутится под тревогой — одной фразой?`
    );
  }

  if (/выгор|нет сил|выжат|не могу больше|апати|устал|вымотан/.test(lower)) {
    return (
      `${name}похоже на истощение — это сигнал, не «лень».\n\n` +
      `Сегодня не про подвиг:\n` +
      `• Что одно ты уже сделал(а)? (даже «встал» считается)\n` +
      `• Что убрать/отложить на 10%?\n` +
      `• 3 минуты — рука на груди, длинный выдох` +
      practiceLine
    );
  }

  if (/отношен|ссор|обид|один|одиноч|партн|друг/.test(lower)) {
    return (
      `${name}в отношениях часто болит не «факт», а смысл, который мы ему придали.\n\n` +
      `1) Что именно произошло — одной фразой, без оценки?\n` +
      `2) Какая эмоция в теле 0–10?\n` +
      `3) Что тебе нужно: быть услышанным, пространство, ясность?\n` +
      `Можно ответить коротко — разберём бережно.` +
      practiceLine
    );
  }

  const last = user.checkins[0];
  const moodHint = last
    ? `В последнем чек-ине настроение ${last.mood}/5, стресс ${last.stress}/5. `
    : "";

  return (
    `${name}слышал(а) тебя. ${moodHint}` +
    `Давай по делу и бережно.\n\n` +
    `1) Что сейчас тяжелее всего — одной фразой?\n` +
    `2) Интенсивность 0–10?\n` +
    `3) Какой самый маленький шаг на 15 минут сделал бы чуть легче?\n\n` +
    `Можешь просто цифрой и фразой.` +
    practiceLine
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
      temperature: 0.6,
      max_tokens: 550,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Недельный отчёт на русском: 3 наблюдения + 2 мягкие рекомендации + 1 практика. Без диагнозов. 120–200 слов.",
        },
        {
          role: "user",
          content: `Фокус: ${user.focusAreas.join(", ")}\nStreak: ${user.streak}\n${buildUserContext(user)}\nДанные:\n${lines}`,
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
      temperature: 0.55,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme, бережный AI-аналитик самочувствия на русском. " +
            "Сделай ПОЛНЫЙ разбор чувств человека по данным. Структура (заголовки коротко):\n" +
            "1) Что сейчас на поверхности (эмоции простыми словами)\n" +
            "2) Что может лежать глубже (гипотезы, не диагнозы)\n" +
            "3) Паттерны по чек-инам/стрессу (если данных мало — скажи честно)\n" +
            "4) Связь с выбранными чувствами-фокусами\n" +
            "5) 2–3 мягких опоры на ближайшие сутки\n" +
            "6) Когда лучше живая помощь (если risk hard — обязательно мягко)\n" +
            "Без диагнозов, без лекарств, без токсичного позитива. 180–320 слов. Не терапевт.",
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
    const text =
      `${name}сейчас тяжеловато — и это уже замечено.\n\n` +
      `На ближайшие 10 минут:\n` +
      `1) Выдох длиннее вдоха × 5\n` +
      `2) Вода / воздух / еда — что доступнее\n` +
      `3) Практика «${practice.emoji} ${practice.title}» (~${practice.durationMin} мин), если есть силы\n\n` +
      `Если совсем плохо и есть мысли о вреде себе — 8-800-2000-122 или 112. Ты не обязан(а) справляться в одиночку.`;
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
      temperature: 0.7,
      max_tokens: 420,
      messages: [
        {
          role: "system",
          content:
            "Ты — careofme. Пользователь только что отметил плохие показатели. " +
            "Дай АВТОМАТИЧЕСКУЮ бережную помощь на русском: 1) валидация 2) что происходит в теле/голове простыми словами " +
            "3) один микро-шаг на 5–10 минут 4) мягко предложи практику (название дано). " +
            "Без диагнозов, без «возьми себя в руки», 80–140 слов. Если признаки кризиса — линия доверия.",
        },
        {
          role: "user",
          content:
            `${buildUserContext(user)}\n` +
            `Триггер: ${trigger}\n${scoreLine}\n` +
            `Практика к предложению: ${practice.emoji} ${practice.title} (${practice.durationMin} мин, id ${practice.id})`,
        },
      ],
    });
    const text =
      resp.choices[0]?.message?.content?.trim() ||
      "Сейчас тяжело. Сделай длинный выдох и одну маленькую вещь для тела — вода или воздух.";
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
        "Сейчас тяжело — это уже сигнал. Три длинных выдоха, глоток воды, и если можешь — короткая практика. " +
        `Можно открыть «${practice.emoji} ${practice.title}».`,
      practiceId: practice.id,
      practiceTitle: `${practice.emoji} ${practice.title}`,
      usedFallback: true,
      trigger,
    };
  }
}
