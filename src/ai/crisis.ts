/**
 * Crisis / suicidal ideation signals — detection + immediate help package.
 * Not a clinical diagnosis. Priority: live human help over the bot.
 */
import type { UserProfile } from "../db/store";
import { CRISIS_HINT, FOCUS_LABELS } from "../data/prompts";
import { getPractice } from "../data/practices";

export type CrisisLevel = "none" | "concern" | "crisis";

export interface CrisisScan {
  detected: boolean;
  level: CrisisLevel;
  matches: string[];
  sources: string[];
}

export interface CrisisHelp {
  text: string;
  practiceId: string;
  practiceTitle: string;
  urgent: true;
  level: CrisisLevel;
  usedFallback: boolean;
  trigger: "crisis";
  resources: {
    hotline: string;
    emergency: string;
    note: string;
  };
}

/** Strong / active signals — treat as crisis immediately */
const ACTIVE_PATTERNS: RegExp[] = [
  /суицид/i,
  /самоубий/i,
  /убить\s*себя/i,
  /убью\s*себя/i,
  /покончить\s*с\s*собой/i,
  /покончить\s*с\s*жизн/i,
  /хочу\s*умереть/i,
  /хочу\s*сдохнуть/i,
  /хочу\s*сдох/i,
  /не\s*хочу\s*жить/i,
  /не\s*хочется\s*жить/i,
  /жить\s*не\s*хочу/i,
  /лучше\s*бы\s*умер/i,
  /лучше\s*бы\s*умерла/i,
  /лучше\s*умереть/i,
  /хочу\s*исчезнуть\s*навсегда/i,
  /прыгнуть\s*с/i,
  /сброситься/i,
  /повеситься/i,
  /отравиться/i,
  /выпью\s*таблет/i,
  /таблеток.*чтоб/i,
  /перерезать/i,
  /вскры(ть|л|ла)?\s*вен/i,
  /план\s*суицид/i,
  /готов(а)?\s*уйти\s*из\s*жизни/i,
  /уйти\s*из\s*жизни/i,
  /нет\s*смысла\s*жить/i,
  /смысла\s*жить\s*нет/i,
  /зачем\s*жить/i,
  /надоело\s*жить/i,
  /устала?\s*жить/i,
  /не\s*вижу\s*смысла/i,
  /вс[её]\s*бессмысленн/i,
  /пропадаю/i,
  /нет\s*сил\s*жить/i,
];

/** Self-harm without explicit suicide wording */
const SELF_HARM_PATTERNS: RegExp[] = [
  /самоповреж/i,
  /резать\s*себя/i,
  /режу\s*себя/i,
  /порезы/i,
  /нанести\s*себе/i,
  /хочу\s*сделать\s*себе\s*больно/i,
  /причинить\s*себе\s*вред/i,
  /вред\s*себе/i,
];

/** Softer passive ideation / hopelessness — still warrant full resources */
const CONCERN_PATTERNS: RegExp[] = [
  /не\s*хочу\s*просыпаться/i,
  /если\s*бы\s*я\s*не\s*родил/i,
  /лучше\s*бы\s*меня\s*не\s*было/i,
  /всем\s*будет\s*лучше\s*без\s*меня/i,
  /без\s*меня\s*лучше/i,
  /я\s*лишн/i,
  /никто\s*не\s*заметит/i,
  /хочу\s*чтобы\s*вс[её]\s*закончилось/i,
  /хочу\s*чтобы\s*это\s*закончилось/i,
  /навсегда\s*уснуть/i,
  /заснуть\s*и\s*не\s*проснуться/i,
  /не\s*проснуться/i,
  /устал(а)?\s*от\s*жизни/i,
  /жизнь\s*не\s*имеет\s*смысла/i,
  /нет\s*будущего/i,
  /хочу\s*исчезнуть/i,
  /меня\s*не\s*должно\s*быть/i,
  /конец\s*света\s*для\s*меня/i,
  /kill\s*myself/i,
  /want\s*to\s*die/i,
  /suicid/i,
  /end\s*my\s*life/i,
];

function collectMatches(text: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  const t = text || "";
  if (!t.trim()) return found;
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[0]) found.push(m[0].slice(0, 40));
  }
  return found;
}

export function scanTextForCrisis(text: string, source = "text"): CrisisScan {
  if (!text || !String(text).trim()) {
    return { detected: false, level: "none", matches: [], sources: [] };
  }
  const raw = String(text);
  const active = collectMatches(raw, ACTIVE_PATTERNS);
  const harm = collectMatches(raw, SELF_HARM_PATTERNS);
  const concern = collectMatches(raw, CONCERN_PATTERNS);

  if (active.length || harm.length) {
    return {
      detected: true,
      level: "crisis",
      matches: [...active, ...harm].slice(0, 8),
      sources: [source],
    };
  }
  if (concern.length) {
    return {
      detected: true,
      level: "concern",
      matches: concern.slice(0, 8),
      sources: [source],
    };
  }
  return { detected: false, level: "none", matches: [], sources: [] };
}

/** Back-compat helper used across the codebase */
export function looksLikeCrisis(text: string): boolean {
  return scanTextForCrisis(text).detected;
}

/**
 * Scan fresh texts + recent user history (notes, journal, coach, stress).
 */
export function scanUserForCrisis(
  user: UserProfile,
  extras: { source: string; text?: string | null }[] = []
): CrisisScan {
  const chunks: { source: string; text: string }[] = [];

  for (const e of extras) {
    if (e.text?.trim()) chunks.push({ source: e.source, text: e.text });
  }

  for (const c of user.checkins.slice(0, 8)) {
    if (c.note?.trim()) chunks.push({ source: "checkin_note", text: c.note });
  }
  for (const j of user.journal.slice(0, 8)) {
    if (j.text?.trim()) chunks.push({ source: "journal", text: j.text });
  }
  for (const s of user.stress.slice(0, 6)) {
    if (s.note?.trim()) chunks.push({ source: "stress_note", text: s.note });
  }
  for (const m of user.coachMessages.slice(-12)) {
    if (m.role === "user" && m.content?.trim()) {
      chunks.push({ source: "coach", text: m.content });
    }
  }

  let level: CrisisLevel = "none";
  const matches: string[] = [];
  const sources = new Set<string>();

  for (const ch of chunks) {
    const s = scanTextForCrisis(ch.text, ch.source);
    if (!s.detected) continue;
    for (const m of s.matches) matches.push(m);
    sources.add(ch.source);
    if (s.level === "crisis") level = "crisis";
    else if (s.level === "concern" && level !== "crisis") level = "concern";
  }

  // Very low mood/energy + despair language already handled; also hard scores alone are NOT crisis
  // (avoid false positives). Only text signals.

  return {
    detected: level !== "none",
    level,
    matches: [...new Set(matches)].slice(0, 10),
    sources: [...sources],
  };
}

export function crisisResources() {
  return {
    hotline: "8-800-2000-122",
    emergency: "112",
    note: "Телефон доверия бесплатно, круглосуточно (РФ). В опасности жизни — 112.",
  };
}

function pickGroundingPractice() {
  const p =
    getPractice("54321") ||
    getPractice("box_breath") ||
    getPractice("body_scan_short");
  return {
    id: p?.id || "54321",
    title: p ? `${p.emoji} ${p.title}` : "🌊 Заземление 5-4-3-2-1",
    durationMin: p?.durationMin || 3,
  };
}

/**
 * Full immediate help text — always includes live contacts first.
 * Used when AI is offline or as base layer.
 */
export function buildCrisisHelpText(
  user: UserProfile,
  scan: CrisisScan,
  contextSnippet?: string
): string {
  const name = user.firstName ? `${user.firstName}, ` : "";
  const res = crisisResources();
  const practice = pickGroundingPractice();
  const focus = user.focusAreas
    .slice(0, 2)
    .map((f) => FOCUS_LABELS[f] || f)
    .join(", ");

  const snip = contextSnippet?.replace(/\s+/g, " ").trim().slice(0, 100);

  const lines: string[] = [
    `${name}мне важно сказать прямо и тепло: то, что ты написал(а), звучит как очень тяжёлая боль` +
      (snip ? ` («${snip}${contextSnippet && contextSnippet.length > 100 ? "…" : ""}»)` : "") +
      `.`,
    "",
    "Сейчас важнее живой человек, чем любой бот.",
    "",
    `📞 Телефон доверия: *${res.hotline}* — бесплатно, 24/7, РФ`,
    `🚨 Если опасность прямо сейчас: *${res.emergency}*`,
    "",
    "Ты не обязан(а) справляться в одиночку. Позвонить — это сила, не слабость.",
    "",
    "Пока ты здесь, рядом со мной текстом:",
    "• Если можешь — останься в безопасном месте, убери то, чем можно причинить вред",
    "• Напиши или позвони кому-то живому, кому хоть чуть-чуть доверяешь",
    "• Тело: стопы на полу, 5 медленных выдохов длиннее вдоха",
    `• Если есть силы — короткая опора «${practice.title}» (~${practice.durationMin} мин)`,
    "",
    focus
      ? `Я помню, что тебе близко: ${focus}. Боль реальна — и она не делает тебя «плохим» или «слабым».`
      : "Боль реальна — и она не делает тебя «плохим» или «слабым».",
    "",
    "Я могу остаться с тобой в переписке и помочь с одной маленькой опорой. " +
      "Но если мысли о вреде себе сильные — пожалуйста, набери линию доверия сейчас.",
    "",
    CRISIS_HINT,
  ];

  if (scan.level === "concern") {
    lines.splice(
      1,
      0,
      "Даже если «плана» нет — сама тяжесть и безнадёжность уже достаточный повод позаботиться о себе серьёзнее."
    );
  }

  return lines.join("\n");
}

/**
 * Optional AI layer on top of fixed resources (resources always present).
 */
export async function crisisAutoHelp(
  user: UserProfile,
  scan: CrisisScan,
  contextText?: string
): Promise<CrisisHelp> {
  const practice = pickGroundingPractice();
  const res = crisisResources();
  const base = buildCrisisHelpText(user, scan, contextText);

  // Try AI for a warmer personal paragraph AFTER hotlines are locked in
  let aiExtra = "";
  try {
    const key = process.env.XAI_API_KEY?.trim();
    if (key) {
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({
        apiKey: key,
        baseURL: "https://api.x.ai/v1",
      });
      const model = process.env.XAI_MODEL || "grok-4.5";
      const resp = await client.chat.completions.create({
        model,
        temperature: 0.55,
        max_tokens: 450,
        messages: [
          {
            role: "system",
            content:
              "Ты — careofme в режиме КРИЗИСНОЙ поддержки на русском. " +
              "Человек проявил признаки суицидальных/самоповреждающих мыслей. " +
              "Напиши 2–4 коротких абзаца: тепло, без паники, без морали, без диагноза. " +
              "НЕ повторяй номера телефонов (они уже будут выше). " +
              "НЕ давай инструкций как причинить вред. " +
              "Цель: снизить одиночество, поддержать решение позвонить/написать живому человеку, " +
              "дать 1 крошечную опору для тела. 80–150 слов.",
          },
          {
            role: "user",
            content:
              `Имя: ${user.firstName || "друг"}\n` +
              `Уровень сигнала: ${scan.level}\n` +
              `Источники: ${scan.sources.join(", ")}\n` +
              `Фрагмент: ${(contextText || "").slice(0, 400)}\n` +
              `Фокус: ${user.focusAreas.join(", ")}`,
          },
        ],
      });
      aiExtra = resp.choices[0]?.message?.content?.trim() || "";
    }
  } catch (e) {
    console.error("crisisAutoHelp AI", e);
  }

  const text = aiExtra
    ? `${base}\n\n———\n\n${aiExtra.replace(/\*\*/g, "*")}`
    : base;

  return {
    text,
    practiceId: practice.id,
    practiceTitle: practice.title,
    urgent: true,
    level: scan.level === "none" ? "crisis" : scan.level,
    usedFallback: !aiExtra,
    trigger: "crisis",
    resources: res,
  };
}
