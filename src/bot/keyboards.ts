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
    kb.webApp("🌿 Открыть careofme", url).row();
  }
  return kb
    .text("🌤 Чек-ин")
    .text("🧘 Практики")
    .row()
    .text("📝 Дневник")
    .text("📊 Стресс")
    .row()
    .text("💬 AI-коуч")
    .text("📈 Статистика")
    .row()
    .text("💎 Подписка")
    .text("ℹ️ Помощь")
    .resized()
    .persistent();
}

export function openAppKeyboard() {
  const url = webappUrl();
  if (!url) return undefined;
  return new InlineKeyboard().webApp("🌿 Открыть careofme", url);
}

export function moodKeyboard(prefix: string) {
  const kb = new InlineKeyboard();
  const labels = [
    ["1", "😫 1"],
    ["2", "😕 2"],
    ["3", "😐 3"],
    ["4", "🙂 4"],
    ["5", "😊 5"],
  ];
  for (const [v, label] of labels) {
    kb.text(label, `${prefix}:${v}`);
  }
  return kb;
}

export function focusKeyboard(selected: FocusArea[] = []) {
  const kb = new InlineKeyboard();
  for (const a of ALL_FOCUS_AREAS) {
    const mark = selected.includes(a) ? "✓ " : "";
    kb.text(`${mark}${FOCUS_LABELS[a]}`, `focus_toggle:${a}`).row();
  }
  kb.text("Готово →", "focus_done");
  return kb;
}

export function practicesKeyboard(list: Practice[], premium: boolean) {
  const kb = new InlineKeyboard();
  for (const p of list) {
    const lock = !p.free && !premium ? "🔒 " : "";
    kb.text(
      `${lock}${p.emoji} ${p.title} · ${p.durationMin} мин`,
      `practice:${p.id}`
    ).row();
  }
  kb.text("🎲 Рекомендовать мне", "practice:recommend").row();
  kb.text("« В меню", "nav:home");
  return kb;
}

export function practiceActionsKeyboard(practiceId: string) {
  return new InlineKeyboard()
    .text("✅ Сделал(а)", `practice_done:${practiceId}`)
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
    .text("🧘 Практика по состоянию", "practice:recommend")
    .row()
    .text("💬 Коротко с AI-коучем", "nav:coach")
    .row()
    .text("« В меню", "nav:home");
}

export function coachKeyboard() {
  return new InlineKeyboard()
    .text("🔥 Выгораю", "coach_quick:burnout")
    .text("🌊 Тревожно", "coach_quick:anxiety")
    .row()
    .text("🌙 Не сплю", "coach_quick:sleep")
    .text("🌧 Грустно", "coach_quick:sad")
    .row()
    .text("🫧 Одиноко", "coach_quick:lonely")
    .text("🌀 Перегруз", "coach_quick:overwhelm")
    .row()
    .text("💬 Свой вопрос", "coach_quick:free")
    .row()
    .text("« В меню", "nav:home");
}

export function plansKeyboard() {
  return new InlineKeyboard()
    .text("🌱 Забота · 199 ₽", "plan:care")
    .row()
    .text("✨ Плюс · 349 ₽", "plan:plus")
    .row()
    .text("Остаться на бесплатном", "plan:free")
    .row()
    .text("« В меню", "nav:home");
}

export function confirmPlanKeyboard(plan: "care" | "plus", payUrl?: string) {
  const kb = new InlineKeyboard();
  if (payUrl) {
    kb.url("💎 Оплатить криптой", payUrl).row();
    kb.text("🔄 Проверить оплату", `pay_check:${plan}`).row();
  } else {
    kb.text("↻ Создать счёт снова", `plan:${plan}`).row();
  }
  kb.text("Отмена", "nav:premium");
  return kb;
}

export function payUrlKeyboard(url: string, plan: "care" | "plus") {
  return new InlineKeyboard()
    .url("💎 Открыть Crypto Bot", url)
    .row()
    .text("🔄 Я оплатил(а)", `pay_check:${plan}`)
    .row()
    .text("« Назад", "nav:premium");
}

export function allPracticesList(premium: boolean) {
  return practicesKeyboard(PRACTICES, premium);
}
