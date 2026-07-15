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
