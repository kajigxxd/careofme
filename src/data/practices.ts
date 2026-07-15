import type { FocusArea } from "../db/store";

export type PracticeKind = "breathing" | "cbt" | "body" | "sleep" | "grounding" | "journal";

export interface Practice {
  id: string;
  title: string;
  emoji: string;
  kind: PracticeKind;
  durationMin: number;
  focus: FocusArea[];
  /** Free tier can use these */
  free: boolean;
  intro: string;
  steps: string[];
  outro: string;
}

export const PRACTICES: Practice[] = [
  {
    id: "box_breath",
    title: "Квадратное дыхание",
    emoji: "🫧",
    kind: "breathing",
    durationMin: 3,
    focus: ["anxiety", "fear", "overwhelm", "anger", "general", "burnout"],
    free: true,
    intro:
      "Простая техника, чтобы сбавить обороты нервной системы. Можно делать где угодно — в метро, перед созвоном, в кровати.",
    steps: [
      "Сядь или встань удобно. Плечи мягко опусти.",
      "Вдох через нос на 4 счёта.",
      "Задержка дыхания на 4 счёта.",
      "Выдох через рот на 4 счёта.",
      "Пауза на 4 счёта.",
      "Повтори цикл 4–6 раз. Не торопись.",
    ],
    outro:
      "Если голова закружилась — вернись к обычному дыханию. Это нормально: ты только что «переключил» тело из режима тревоги.",
  },
  {
    id: "478_breath",
    title: "Дыхание 4–7–8",
    emoji: "🌙",
    kind: "breathing",
    durationMin: 4,
    focus: ["insomnia", "anxiety", "fear", "overwhelm", "general"],
    free: true,
    intro:
      "Классика для вечера и беспокойных мыслей. Помогает телу понять: «сейчас можно отпустить».",
    steps: [
      "Ляг или сядь. Язык касается нёба за верхними зубами.",
      "Полный выдох через рот со звуком «whoosh».",
      "Вдох носом на 4 счёта.",
      "Задержка на 7 счётов.",
      "Выдох ртом на 8 счётов.",
      "Сделай 3–4 цикла. Не усиливай — мягко.",
    ],
    outro:
      "Если не получается держать 7 и 8 — укороти счёт. Важна ритмичность, а не рекорд.",
  },
  {
    id: "54321",
    title: "Заземление 5–4–3–2–1",
    emoji: "🌿",
    kind: "grounding",
    durationMin: 3,
    focus: ["anxiety", "fear", "overwhelm", "emptiness", "anger", "general"],
    free: true,
    intro:
      "Когда тревога «уносит» в голову — возвращаем внимание в тело и комнату. Без философии, просто факты.",
    steps: [
      "Назови 5 вещей, которые видишь прямо сейчас.",
      "4 вещи, которые можешь потрогать (ткань, стол, телефон).",
      "3 звука вокруг.",
      "2 запаха (или вспомни любимый).",
      "1 вкус во рту (или глоток воды).",
      "Скажи себе тихо: «Я здесь. Сейчас.»",
    ],
    outro:
      "Тревога любит абстракции. Ты только что вернул себе конкретику — это уже опора.",
  },
  {
    id: "thought_catch",
    title: "Поймать мысль (CBT)",
    emoji: "💭",
    kind: "cbt",
    durationMin: 5,
    focus: [
      "anxiety",
      "burnout",
      "guilt",
      "self_doubt",
      "fear",
      "relationships",
      "general",
    ],
    free: true,
    intro:
      "Не «думать позитивно», а чуть отойти в сторону и посмотреть на мысль как на событие, а не как на истину.",
    steps: [
      "Какая мысль крутится сейчас? Запиши одной фразой.",
      "Насколько ты веришь ей от 0 до 100%?",
      "Какие факты ЗА эту мысль? (только факты, не интерпретации)",
      "Какие факты ПРОТИВ?",
      "Как бы ты сказал другу в такой же ситуации?",
      "Сформулируй более сбалансированную версию мысли.",
    ],
    outro:
      "Мысль не исчезла — но у неё появился сосед: более честный и мягкий вариант. Этого достаточно на сегодня.",
  },
  {
    id: "tiny_win",
    title: "Маленькая победа дня",
    emoji: "🌱",
    kind: "cbt",
    durationMin: 2,
    focus: ["burnout", "apathy", "sadness", "self_doubt", "emptiness", "general"],
    free: true,
    intro:
      "При выгорании мозг фильтрует только «недовёл». Мы сознательно добавляем крошечные факты «сделал».",
    steps: [
      "Вспомни одно действие за сутки, которое ты всё-таки сделал(а).",
      "Даже крошечное: встал, написал сообщение, помыл чашку, ответил коллеге.",
      "Запиши: «Сегодня я …»",
      "Добавь: «Это было непросто, потому что …»",
      "И: «Я всё равно …»",
    ],
    outro:
      "Ты не обязан быть продуктивным, чтобы заслуживать уважения к себе. Одна строка — уже якорь.",
  },
  {
    id: "body_scan_short",
    title: "Короткий скан тела",
    emoji: "🍃",
    kind: "body",
    durationMin: 4,
    focus: [
      "burnout",
      "anxiety",
      "insomnia",
      "emptiness",
      "apathy",
      "anger",
      "overwhelm",
      "general",
    ],
    free: true,
    intro:
      "Не медитация «опустоши ум». Просто пройтись вниманием по телу и отметить, где зажато — без исправлений.",
    steps: [
      "Сядь или ляг. Закрой глаза, если комфортно.",
      "Заметь стопы: тепло, холод, давление.",
      "Икры, бёдра, таз — просто отметь.",
      "Живот, грудь, плечи. Где напряжение 1–10?",
      "Челюсть, лоб, глаза. Можно мягко расслабить на 10%.",
      "Сделай 3 спокойных выдоха длиннее вдоха.",
    ],
    outro:
      "Не нужно «всё расслабить». Достаточно заметить. Замечание уже снижает автопилот.",
  },
  {
    id: "sleep_wind_down",
    title: "Вечерний сброс",
    emoji: "💤",
    kind: "sleep",
    durationMin: 5,
    focus: ["insomnia", "anxiety", "burnout", "fear", "overwhelm"],
    free: false,
    intro:
      "Не «усни сейчас», а «переведи мозг из дня в ночь». Подходит за 20–40 минут до сна.",
    steps: [
      "Запиши 3 незакрытых дела на завтра (чтобы мозг отпустил).",
      "Выключи яркий экран или включи тёплый свет.",
      "3 цикла дыхания 4–7–8 (или просто длинный выдох).",
      "Положи руку на грудь: «Сегодня хватит. Остальное — завтра.»",
      "Если мысли лезут — отметь: «мысли о …, могу вернуться утром.»",
    ],
    outro:
      "Бессонница усиливается от борьбы со сном. Твоя задача — снизить стимуляцию, а не «заставить» уснуть.",
  },
  {
    id: "worry_window",
    title: "Окно тревоги",
    emoji: "🪟",
    kind: "cbt",
    durationMin: 6,
    focus: ["anxiety", "insomnia", "fear", "overwhelm", "guilt"],
    free: false,
    intro:
      "Тревога ненавидит расписание. Даём ей 10 минут «официального» времени — и выключаем вне окна.",
    steps: [
      "Выбери время «окна тревоги» (например, 18:00–18:10).",
      "Сейчас: быстро запиши все беспокойства списком, без разбора.",
      "Отметь: что реально можно сделать сегодня? Одно действие max.",
      "Остальное пометь: «в окно тревоги».",
      "Когда мысль вернётся днём: «не сейчас, в 18:00».",
      "В окне — разбирай. Вне окна — мягко откладывай.",
    ],
    outro:
      "Это не подавление. Это договор с собой: тревоге есть место, но не весь день.",
  },
  {
    id: "boundaries_one",
    title: "Одна граница",
    emoji: "🪴",
    kind: "cbt",
    durationMin: 4,
    focus: ["burnout", "relationships", "guilt", "overwhelm", "anger", "general"],
    free: false,
    intro:
      "Выгорание часто кормится «неудобно отказать». Сегодня — одна маленькая граница, не революция.",
    steps: [
      "Где ты сейчас отдаёшь больше, чем готов(а)?",
      "Сформулируй границу одной фразой: «Я не … / Я могу … после …»",
      "Кому и когда скажешь? (или напишешь)",
      "Что самое страшное, если откажешь? Насколько это вероятно 0–100?",
      "Что ты выиграешь для себя, если удержишь границу?",
    ],
    outro:
      "Граница — не грубость. Это инструкция, как с тобой можно бережно.",
  },
  {
    id: "gratitude_real",
    title: "Реальная благодарность",
    emoji: "🌼",
    kind: "journal",
    durationMin: 3,
    focus: ["general", "burnout", "sadness", "loneliness", "apathy", "emptiness"],
    free: true,
    intro:
      "Не токсичный позитив. Только то, что правда чувствуется — даже если это «тёплый чай» и «тишина 5 минут».",
    steps: [
      "Назови 1 вещь в теле, за которую можно сказать «ок».",
      "1 вещь вовне (человек, место, предмет).",
      "1 вещь, которую ты сам(а) для себя сделал(а) недавно.",
      "Если ничего не находится — напиши: «Сегодня тяжело, и это тоже факт.»",
    ],
    outro:
      "Благодарность не отменяет боль. Она просто расширяет кадр на пару градусов.",
  },
  {
    id: "energy_sip",
    title: "3 минуты на топливо",
    emoji: "🍵",
    kind: "body",
    durationMin: 3,
    focus: ["burnout", "apathy", "sadness", "emptiness", "overwhelm", "general"],
    free: true,
    intro:
      "Когда сил почти нет — не «мотивация», а минимум топлива для тела. Без героизма.",
    steps: [
      "Выпей несколько глотков воды (или чая), медленно.",
      "Встань, если можешь: мягко потяни руки вверх, затем вниз к полу.",
      "3 раза: вдох носом, выдох ртом длиннее вдоха.",
      "Спроси себя: что одно крошечное сейчас возможно? (сесть, поесть, написать «мне тяжело»).",
      "Сделай только это одно — или осознанно ничего, 60 секунд без телефона.",
    ],
    outro:
      "Истощение не лечится силой воли. Ты только что вернул(а) телу каплю внимания — этого достаточно как старт.",
  },
  {
    id: "name_the_feeling",
    title: "Назвать чувство",
    emoji: "🤍",
    kind: "journal",
    durationMin: 2,
    focus: [
      "sadness",
      "anger",
      "guilt",
      "emptiness",
      "anxiety",
      "self_doubt",
      "general",
    ],
    free: true,
    intro:
      "Мозг часто смешивает «я плохой» и «мне больно». Разделяем: имя чувства без приговора.",
    steps: [
      "Спроси: какое чувство сейчас ближе всего? (грусть, злость, страх, стыд, пустота…)",
      "Дополни: где в теле? (грудь, живот, горло, плечи)",
      "Скажи или напиши: «Сейчас я чувствую … в …»",
      "Добавь: «Мне не нужно это исправлять за 2 минуты.»",
      "Если хочется — один мягкий запрос к себе: «Что мне сейчас нужно на 1%?»",
    ],
    outro:
      "Названное чувство чуть меньше управляет из тени. Можно остановиться здесь.",
  },
  {
    id: "shoulders_drop",
    title: "Плечи вниз + выдох",
    emoji: "☁️",
    kind: "body",
    durationMin: 2,
    focus: ["anxiety", "overwhelm", "anger", "fear", "burnout", "general"],
    free: true,
    intro:
      "Стресс часто «сидит» в плечах и челюсти. 2 минуты телесного сброса — без приложений и коврика.",
    steps: [
      "Заметь плечи: где они сейчас? Подтяни к ушам на вдохе.",
      "На выдохе резко (но мягко) отпусти вниз. Повтори 3 раза.",
      "Расслабь челюсть: язык на нижнее нёбо, губы чуть разомкнуты.",
      "5 выдохов длиннее вдоха. Считай только выдох.",
      "Потряси кистями 10 секунд, как стряхиваешь воду.",
    ],
    outro:
      "Тело получило сигнал «можно чуть отпустить». Мысли могут ещё крутиться — это нормально.",
  },
];

export function getPractice(id: string): Practice | undefined {
  return PRACTICES.find((p) => p.id === id);
}

export function practicesForFocus(
  focus: FocusArea[],
  opts?: { freeOnly?: boolean }
): Practice[] {
  const set = new Set(focus.length ? focus : (["general"] as FocusArea[]));
  return PRACTICES.filter((p) => {
    if (opts?.freeOnly && !p.free) return false;
    return p.focus.some((f) => set.has(f) || f === "general");
  });
}

export function recommendPractice(
  focus: FocusArea[],
  mood?: number,
  stress?: number,
  freeOnly = false
): Practice {
  const list = recommendPractices(1, focus, { mood, stress, freeOnly });
  return list[0]!;
}

export type PracticePick = {
  id: string;
  title: string;
  emoji: string;
  durationMin: number;
  kind: PracticeKind;
  free: boolean;
  reason: string;
};

/**
 * Several diverse practices for low wellbeing — not only grounding.
 */
export function recommendPractices(
  count: number,
  focus: FocusArea[],
  opts?: {
    mood?: number;
    energy?: number;
    stress?: number;
    freeOnly?: boolean;
  }
): Practice[] {
  const freeOnly = !!opts?.freeOnly;
  const mood = opts?.mood;
  const energy = opts?.energy;
  const stress = opts?.stress;

  let pool = practicesForFocus(focus, { freeOnly });
  if (!pool.length) pool = PRACTICES.filter((p) => p.free || !freeOnly);

  // Score-based boost lists (still keep diversity across kinds)
  const preferredIds = new Set<string>();
  if (stress != null && stress >= 4) {
    [
      "box_breath",
      "54321",
      "shoulders_drop",
      "body_scan_short",
      "478_breath",
      "worry_window",
    ].forEach((id) => preferredIds.add(id));
  }
  if (mood != null && mood <= 2) {
    [
      "tiny_win",
      "name_the_feeling",
      "gratitude_real",
      "body_scan_short",
      "energy_sip",
      "thought_catch",
    ].forEach((id) => preferredIds.add(id));
  }
  if (energy != null && energy <= 2) {
    ["energy_sip", "tiny_win", "body_scan_short", "box_breath", "gratitude_real"].forEach(
      (id) => preferredIds.add(id)
    );
  }
  if (preferredIds.size === 0) {
    ["box_breath", "54321", "tiny_win", "body_scan_short", "thought_catch"].forEach((id) =>
      preferredIds.add(id)
    );
  }

  const preferred = pool.filter((p) => preferredIds.has(p.id));
  const rest = pool.filter((p) => !preferredIds.has(p.id));

  // Round-robin by kind so we don't return 3 groundings
  const picked: Practice[] = [];
  const usedKinds = new Set<string>();
  const usedIds = new Set<string>();

  const tryPick = (list: Practice[], respectKind: boolean) => {
    for (const p of shuffle(list)) {
      if (usedIds.has(p.id)) continue;
      if (respectKind && usedKinds.has(p.kind) && picked.length < count) {
        // allow second of same kind only later
        continue;
      }
      picked.push(p);
      usedIds.add(p.id);
      usedKinds.add(p.kind);
      if (picked.length >= count) return;
    }
  };

  tryPick(preferred, true);
  if (picked.length < count) tryPick(preferred, false);
  if (picked.length < count) tryPick(rest, true);
  if (picked.length < count) tryPick(rest, false);
  if (picked.length < count) {
    const any = PRACTICES.filter((p) => (freeOnly ? p.free : true) && !usedIds.has(p.id));
    tryPick(any, false);
  }

  // Guarantee at least one practice
  if (!picked.length) {
    const fallback =
      getPractice("box_breath") ||
      getPractice("54321") ||
      PRACTICES.find((p) => p.free)!;
    return [fallback];
  }

  return picked.slice(0, Math.max(1, count));
}

export function practicePickReason(
  p: Practice,
  scores?: { mood?: number; energy?: number; stress?: number }
): string {
  if (scores?.stress != null && scores.stress >= 4) {
    if (p.kind === "breathing") return "снизить стресс через дыхание";
    if (p.kind === "grounding") return "вернуть в «здесь и сейчас»";
    if (p.kind === "body") return "сбросить напряжение в теле";
  }
  if (scores?.mood != null && scores.mood <= 2) {
    if (p.id === "tiny_win") return "опереться на крошечный факт «сделал»";
    if (p.id === "name_the_feeling") return "назвать чувство без самокритики";
    if (p.kind === "journal") return "чуть разгрузить голову на бумаге";
  }
  if (scores?.energy != null && scores.energy <= 2) {
    if (p.id === "energy_sip") return "дать телу минимум топлива";
    if (p.kind === "body") return "мягко оживить тело без нагрузки";
  }
  if (p.kind === "cbt") return "отойти от липкой мысли";
  if (p.kind === "breathing") return "успокоть нервную систему";
  if (p.kind === "grounding") return "заземлиться";
  return "короткая опора на сейчас";
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function toPracticePicks(
  practices: Practice[],
  scores?: { mood?: number; energy?: number; stress?: number }
): PracticePick[] {
  return practices.map((p) => ({
    id: p.id,
    title: p.title,
    emoji: p.emoji,
    durationMin: p.durationMin,
    kind: p.kind,
    free: p.free,
    reason: practicePickReason(p, scores),
  }));
}
