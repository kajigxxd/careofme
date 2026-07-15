export function escapeMd(text: string): string {
  // Telegram MarkdownV2 is painful; we use classic Markdown with light escaping
  return text.replace(/([_*`\[])/g, "\\$1");
}

export function bar(value: number, max = 5, width = 5): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function fmtAvg(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toFixed(1);
}

export function pluralDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} дней`;
  if (last === 1) return `${n} день`;
  if (last >= 2 && last <= 4) return `${n} дня`;
  return `${n} дней`;
}
