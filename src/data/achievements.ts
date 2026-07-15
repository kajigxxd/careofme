/**
 * Achievements for completed practices (and therapy modules counted as practices).
 */
import type { PracticeLog } from "../db/store";
import { PRACTICES } from "./practices";

export interface AchievementDef {
  id: string;
  emoji: string;
  title: string;
  description: string;
  /** Soft hint how to unlock */
  hint: string;
}

export interface PracticeStats {
  total: number;
  unique: number;
  uniqueIds: string[];
  byKind: Record<string, number>;
  daysActive: number;
  /** Max consecutive calendar days with ≥1 practice */
  dayStreak: number;
  therapyCount: number;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first_step",
    emoji: "",
    title: "Первый шаг",
    description: "Выполнил(а) первую практику",
    hint: "Заверши любую практику",
  },
  {
    id: "practices_5",
    emoji: "",
    title: "Пять опор",
    description: "5 завершённых практик",
    hint: "Сделай 5 практик",
  },
  {
    id: "practices_15",
    emoji: "",
    title: "Привычка заботы",
    description: "15 завершённых практик",
    hint: "Сделай 15 практик",
  },
  {
    id: "practices_40",
    emoji: "",
    title: "Тихая сила",
    description: "40 завершённых практик",
    hint: "Сделай 40 практик",
  },
  {
    id: "unique_5",
    emoji: "",
    title: "Разнообразие",
    description: "5 разных практик",
    hint: "Попробуй 5 разных упражнений",
  },
  {
    id: "unique_all_free",
    emoji: "",
    title: "Библиотека free",
    description: "Все бесплатные практики хотя бы раз",
    hint: "Пройди каждую free-практику",
  },
  {
    id: "breath_3",
    emoji: "",
    title: "Дыхание",
    description: "3 дыхательные практики",
    hint: "Заверши дыхательные упражнения",
  },
  {
    id: "body_3",
    emoji: "",
    title: "Тело слышит",
    description: "3 телесные практики",
    hint: "Скан тела, плечи, топливо…",
  },
  {
    id: "ground_3",
    emoji: "",
    title: "Здесь и сейчас",
    description: "3 практики заземления",
    hint: "Заземление 5–4–3–2–1 и похожие",
  },
  {
    id: "cbt_3",
    emoji: "",
    title: "Ясная мысль",
    description: "3 CBT-практики",
    hint: "Поймать мысль, маленькая победа…",
  },
  {
    id: "days_3",
    emoji: "",
    title: "Три дня рядом",
    description: "Практики в 3 разных дня",
    hint: "Заглядывай в практики несколько дней",
  },
  {
    id: "streak_7",
    emoji: "",
    title: "Неделя заботы",
    description: "7 дней подряд с хотя бы одной практикой",
    hint: "Маленькая практика каждый день",
  },
  {
    id: "therapy_1",
    emoji: "",
    title: "Терапевтический путь",
    description: "Завершил(а) первый терапевтический модуль",
    hint: "Открой раздел «Терапия»",
  },
  {
    id: "therapy_3",
    emoji: "",
    title: "Глубже",
    description: "3 терапевтических модуля",
    hint: "Пройди несколько модулей терапии",
  },
];

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function computePracticeStats(
  practices: PracticeLog[],
  therapyIds: Set<string> = new Set()
): PracticeStats {
  const total = practices.length;
  const uniqueIds = [...new Set(practices.map((p) => p.practiceId))];
  const byKind: Record<string, number> = {};
  let therapyCount = 0;

  for (const log of practices) {
    if (therapyIds.has(log.practiceId) || log.practiceId.startsWith("therapy_")) {
      therapyCount += 1;
    }
    const def = PRACTICES.find((p) => p.id === log.practiceId);
    const kind = def?.kind || (log.practiceId.startsWith("therapy_") ? "therapy" : "other");
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  const days = new Set(practices.map((p) => dayKey(p.at)));
  const sortedDays = [...days].sort();
  let dayStreak = 0;
  if (sortedDays.length) {
    // streak ending at most recent practice day
    const latest = sortedDays[sortedDays.length - 1]!;
    let cur = new Date(latest + "T12:00:00Z");
    dayStreak = 1;
    for (;;) {
      cur.setUTCDate(cur.getUTCDate() - 1);
      const k = cur.toISOString().slice(0, 10);
      if (days.has(k)) dayStreak += 1;
      else break;
    }
  }

  return {
    total,
    unique: uniqueIds.length,
    uniqueIds,
    byKind,
    daysActive: days.size,
    dayStreak,
    therapyCount,
  };
}

function isUnlocked(id: string, stats: PracticeStats): boolean {
  const freeIds = PRACTICES.filter((p) => p.free).map((p) => p.id);
  switch (id) {
    case "first_step":
      return stats.total >= 1;
    case "practices_5":
      return stats.total >= 5;
    case "practices_15":
      return stats.total >= 15;
    case "practices_40":
      return stats.total >= 40;
    case "unique_5":
      return stats.unique >= 5;
    case "unique_all_free":
      return freeIds.every((id) => stats.uniqueIds.includes(id));
    case "breath_3":
      return (stats.byKind.breathing || 0) >= 3;
    case "body_3":
      return (stats.byKind.body || 0) >= 3;
    case "ground_3":
      return (stats.byKind.grounding || 0) >= 3;
    case "cbt_3":
      return (stats.byKind.cbt || 0) >= 3;
    case "days_3":
      return stats.daysActive >= 3;
    case "streak_7":
      return stats.dayStreak >= 7;
    case "therapy_1":
      return stats.therapyCount >= 1;
    case "therapy_3":
      return stats.therapyCount >= 3;
    default:
      return false;
  }
}

export function evaluateNewAchievements(
  practices: PracticeLog[],
  already: string[],
  therapyModuleIds: string[] = []
): string[] {
  const therapySet = new Set(therapyModuleIds);
  const stats = computePracticeStats(practices, therapySet);
  const have = new Set(already);
  const unlocked: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.id)) continue;
    if (isUnlocked(a.id, stats)) unlocked.push(a.id);
  }
  return unlocked;
}

export function getAchievement(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}
