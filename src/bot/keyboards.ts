import { InlineKeyboard, Keyboard } from "grammy";
import { FOCUS_LABELS, STRESS_SOURCES } from "../data/prompts";
import { ALL_FOCUS_AREAS, type FocusArea } from "../db/store";
import { PRACTICES, type Practice } from "../data/practices";
import { resolveWebAppUrl } from "../config";

export function webappUrl(): string | undefined {
  return resolveWebAppUrl();
}

export function mainMenuKeyboard() {
  const kb = new Keyboard();
  const url = webappUrl();
  if (url) {
    kb.webApp("Открыть careofme", url).row();
  }
  return kb
    .text("Чек-ин")
    .text("Практики")
    .row()
    .text("Дневник")
    .text("Стресс")
    .row()
    .text("AI-коуч")
    .text("Статистика")
    .row()
    .text("Подписка")
    .text("Помощь")
    .resized()
    .persistent();
}

export function openAppKeyboard() {
  const url = webappUrl();
  if (!url) return undefined;
  return new InlineKeyboard().webApp("Открыть careofme", url);
}

export function moodKeyboard(prefix: string) {
  const kb = new InlineKeyboard();
  const labels = [
    ["1", "1"],
    ["2", "2"],
    ["3", "3"],
    ["4", "4"],
    ["5", "5"],
  ];
  for (const [v, label] of labels) {
    kb.text(label, `${prefix}:${v}`);
  }
  return kb;
}

export function focusKeyboard(selected: FocusArea[] = []) {
  const kb = new InlineKeyboard();
  for (const a of ALL_FOCUS_AREAS) {
    const mark = selected.includes(a) ? "• " : "";
    kb.text(`${mark}${FOCUS_LABELS[a]}`, `focus_toggle:${a}`).row();
  }
  kb.text("Готово →", "focus_done");
  return kb;
}

export function practicesKeyboard(list: Practice[], premium: boolean) {
  const kb = new InlineKeyboard();
  for (const p of list) {
    const lock = !p.free && !premium ? "· " : "";
    kb.text(
      `${lock}${p.title} · ${p.durationMin} мин`,
      `practice:${p.id}`
    ).row();
  }
  kb.text("Рекомендовать мне", "practice:recommend").row();
  kb.text("« В меню", "nav:home");
  return kb;
}

export function practiceActionsKeyboard(practiceId: string) {
  return new InlineKeyboard()
    .text("Сделал(а)", `practice_done:${practiceId}`)
    .text("Другая практика", "nav:practices")
    .row()
    .text("« В меню", "nav:home");
}

export function stressSourceKeyboard() {
  const kb = new InlineKeyboard();
  for (const s of STRESS_SOURCES) {
    kb.text(s.label, `stress_src:${s.id}`).row();
  }
  kb.text("Пропустить", "stress_src:skip");
  return kb;
}

export function afterCheckinKeyboard() {
  return new InlineKeyboard()
    .text("Практика по состоянию", "practice:recommend")
    .row()
    .text("Коротко с AI-коучем", "nav:coach")
    .row()
    .text("Анализ чувств (Плюс)", "feelings_analysis")
    .row()
    .text("« В меню", "nav:home");
}

export function coachKeyboard() {
  return new InlineKeyboard()
    .text("Выгораю", "coach_quick:burnout")
    .text("Тревожно", "coach_quick:anxiety")
    .row()
    .text("Не сплю", "coach_quick:sleep")
    .text("Грустно", "coach_quick:sad")
    .row()
    .text("Одиноко", "coach_quick:lonely")
    .text("Перегруз", "coach_quick:overwhelm")
    .row()
    .text("Свой вопрос", "coach_quick:free")
    .row()
    .text("« В меню", "nav:home");
}

export function plansKeyboard() {
  return new InlineKeyboard()
    .text("Забота · 3 дня бесплатно", "plan:trial:care")
    .row()
    .text("Плюс · 3 дня бесплатно", "plan:trial:plus")
    .row()
    .text("Забота · от 89 ₽", "plan:care")
    .row()
    .text("Плюс · от 119 ₽", "plan:plus")
    .row()
    .text("Остаться на бесплатном", "plan:free")
    .row()
    .text("« В меню", "nav:home");
}

/** Choose subscription length before payment */
export function planPeriodKeyboard(plan: "care" | "plus") {
  const prices =
    plan === "care"
      ? { "7d": 89, "30d": 199, "90d": 499, "180d": 899 }
      : { "7d": 119, "30d": 349, "90d": 849, "180d": 1549 };
  return new InlineKeyboard()
    .text(`7 дней · ${prices["7d"]} ₽`, `plan:${plan}:7d`)
    .row()
    .text(`30 дней · ${prices["30d"]} ₽`, `plan:${plan}:30d`)
    .row()
    .text(`3 месяца · ${prices["90d"]} ₽`, `plan:${plan}:90d`)
    .row()
    .text(`6 месяцев · ${prices["180d"]} ₽`, `plan:${plan}:180d`)
    .row()
    .text("« Назад", "nav:premium");
}

export function confirmPlanKeyboard(
  plan: "care" | "plus",
  payUrl?: string,
  period = "30d"
) {
  const kb = new InlineKeyboard();
  if (payUrl) {
    kb.url("Оплатить криптой", payUrl).row();
    kb.text("Проверить оплату", `pay_check:${plan}`).row();
  } else {
    kb.text("↻ Создать счёт снова", `plan:${plan}:${period}`).row();
  }
  kb.text("Отмена", "nav:premium");
  return kb;
}

export function payUrlKeyboard(
  url: string,
  plan: "care" | "plus",
  period = "30d"
) {
  return new InlineKeyboard()
    .url("Открыть Crypto Bot", url)
    .row()
    .text("Я оплатил(а)", `pay_check:${plan}`)
    .row()
    .text("« Сменить срок", `plan:${plan}`)
    .row()
    .text("« Назад", "nav:premium");
}

export function allPracticesList(premium: boolean) {
  return practicesKeyboard(PRACTICES, premium);
}
