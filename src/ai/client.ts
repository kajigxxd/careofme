import OpenAI from "openai";
import type { UserProfile } from "../db/store";
import { buildCoachSystemPrompt, CRISIS_HINT } from "../data/prompts";

const CRISIS_PATTERNS =
  /суицид|самоубий|убить себя|не хочу жить|хочу умереть|покончить|самоповреж|резать себя|прыгнуть с|нет смысла жить/i;

export function looksLikeCrisis(text: string): boolean {
  return CRISIS_PATTERNS.test(text);
}

function getClient(): OpenAI | null {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: "https://api.x.ai/v1",
  });
}

export async function coachReply(
  user: UserProfile,
  userMessage: string
): Promise<{ text: string; usedFallback: boolean }> {
  if (looksLikeCrisis(userMessage)) {
    return {
      text:
        `${CRISIS_HINT}\n\n` +
        "Я рядом текстом, но сейчас важнее живой контакт. " +
        "Если можешь — напиши близкому человеку или позвони на линию доверия. " +
        "Хочешь, после того как тебе станет чуть безопаснее, разберём одну маленькую опору на ближайший час?",
      usedFallback: true,
    };
  }

  const client = getClient();
  const model = process.env.XAI_MODEL || "grok-4.5";

  if (!client) {
    return { text: fallbackCoach(user, userMessage), usedFallback: true };
  }

  const history = user.coachMessages.slice(-12).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.7,
      max_tokens: 600,
      messages: [
        { role: "system", content: buildCoachSystemPrompt(user) },
        ...history,
        { role: "user", content: userMessage },
      ],
    });

    const text =
      resp.choices[0]?.message?.content?.trim() ||
      fallbackCoach(user, userMessage);

    return { text, usedFallback: false };
  } catch (err) {
    console.error("AI coach error:", err);
    return {
      text:
        fallbackCoach(user, userMessage) +
        "\n\n_Сейчас AI недоступен — ответил запасным режимом._",
      usedFallback: true,
    };
  }
}

function fallbackCoach(user: UserProfile, message: string): string {
  const lower = message.toLowerCase();
  const name = user.firstName ? `${user.firstName}, ` : "";

  if (/не сплю|бессон|не могу уснуть|кошмар/.test(lower)) {
    return (
      `${name}бессонница часто усиливается от борьбы со сном.\n\n` +
      `Попробуй на 5 минут:\n` +
      `1) Запиши 3 «хвоста» дел на завтра — чтобы мозг отпустил.\n` +
      `2) Дыхание: вдох 4, выдох 6–8, 5 циклов.\n` +
      `3) Фраза: «Мне не обязательно уснуть прямо сейчас — достаточно отдыхать».\n\n` +
      `Если хочешь — открой практики → «Вечерний сброс» или «Дыхание 4–7–8».`
    );
  }

  if (/тревог|паник|волн|сердце колотится|страшно/.test(lower)) {
    return (
      `${name}тревога сейчас в теле — это неприятно, но не значит, что опасность реальна.\n\n` +
      `Микро-шаг (2 минуты):\n` +
      `• Назови 5 предметов, которые видишь\n` +
      `• 4, которые можешь потрогать\n` +
      `• 3 звука\n\n` +
      `Потом квадратное дыхание 4–4–4–4. Хочешь, разберём, какая мысль крутится под тревогой?`
    );
  }

  if (/выгор|нет сил|выжат|не могу больше|апати|уста/.test(lower)) {
    return (
      `${name}похоже на истощение — и это сигнал системы, а не «лень».\n\n` +
      `Сегодня не про подвиг. Одна крошечная опора:\n` +
      `• Что одно ты уже сделал(а) сегодня? (даже «встал» считается)\n` +
      `• Что можно убрать/отложить на 10%?\n` +
      `• 3 минуты — рука на груди, длинный выдох.\n\n` +
      `Можно открыть практику «Маленькая победа дня». Я рядом.`
    );
  }

  const last = user.checkins[0];
  const moodHint = last
    ? `В последнем чек-ине настроение ${last.mood}/5, стресс ${last.stress}/5. `
    : "";

  return (
    `${name}слышал(а) тебя. ${moodHint}` +
    `Давай бережно и по делу.\n\n` +
    `1) Назови одной фразой, что сейчас тяжелее всего.\n` +
    `2) Оцени интенсивность 0–10.\n` +
    `3) Какой самый маленький шаг на ближайшие 15 минут сделал бы тебе чуть легче?\n\n` +
    `Можешь просто ответить цифрой и фразой — разберём вместе. ` +
    `Или меню → «Практики» / «Чек-ин», если хочется структуры.`
  );
}

export async function weeklyInsight(user: UserProfile): Promise<string> {
  const client = getClient();
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

  if (!client) {
    const avgMood =
      checkins.reduce((s, c) => s + c.mood, 0) / checkins.length;
    const avgStress =
      checkins.reduce((s, c) => s + c.stress, 0) / checkins.length;
    return (
      `📊 *Краткая сводка (без AI)*\n\n` +
      `Среднее настроение: ${avgMood.toFixed(1)}/5\n` +
      `Средний стресс: ${avgStress.toFixed(1)}/5\n` +
      `Чек-инов в выборке: ${checkins.length}\n` +
      `Серия: ${user.streak} дн.\n\n` +
      (avgStress >= 3.5
        ? "Стресс заметный — чаще подключай дыхание и границы по нагрузке."
        : "Есть опора. Продолжай короткие ритуалы — они копятся.")
    );
  }

  try {
    const model = process.env.XAI_MODEL || "grok-4.5";
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.6,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
            "Ты — «Бережно». Сделай короткий недельный отчёт на русском: 3 наблюдения + 2 мягкие рекомендации. Без диагнозов. 120–180 слов.",
        },
        {
          role: "user",
          content: `Фокус: ${user.focusAreas.join(", ")}\nStreak: ${user.streak}\nДанные:\n${lines}`,
        },
      ],
    });
    return (
      resp.choices[0]?.message?.content?.trim() ||
      "Не удалось собрать отчёт. Попробуй позже."
    );
  } catch (e) {
    console.error(e);
    return "Не удалось собрать AI-отчёт. Попробуй позже или посмотри «Статистику».";
  }
}
