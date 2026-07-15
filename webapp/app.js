/* global Telegram */

const tg = window.Telegram?.WebApp;
if (tg) {
  try {
    tg.ready();
    tg.expand();
  } catch (_) {}
  // Soft header colors — some macOS builds crash on secondary_bg_color
  try {
    if (tg.setHeaderColor) tg.setHeaderColor("bg_color");
    if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color");
  } catch (_) {}
}

/** Telegram Desktop on macOS is picky about deep-links & auto-navigation */
function tgPlatform() {
  return String(tg?.platform || "").toLowerCase();
}
function isDesktopClient() {
  const p = tgPlatform();
  return (
    p === "tdesktop" ||
    p === "macos" ||
    p === "web" ||
    p === "weba" ||
    p === "webk" ||
    /Mac|Win/i.test(navigator.platform || "")
  );
}
function isMacDesktop() {
  const p = tgPlatform();
  const ua = `${navigator.userAgent || ""} ${navigator.platform || ""}`;
  return p === "macos" || (p === "tdesktop" && /Mac/i.test(ua)) || (/Mac/i.test(ua) && !/iPhone|iPad|iPod|Android/i.test(ua));
}

const state = {
  me: null,
  checkin: { step: 0, mood: null, energy: null, stress: null, sleep: null, note: "" },
  stressLevel: null,
  stressSource: null,
  currentPracticeId: null,
  journalPrompt: "",
  focusDraft: [],
};

const CHECKIN_STEPS = [
  { key: "mood", title: "Настроение", hint: "1 — очень тяжело · 5 — отлично" },
  { key: "energy", title: "Энергия", hint: "Сколько сил прямо сейчас?" },
  { key: "stress", title: "Стресс", hint: "1 — почти нет · 5 — на пределе" },
  { key: "sleep", title: "Сон прошлой ночи", hint: "Можно пропустить" },
  { key: "note", title: "Заметка", hint: "Что повлияло на день? Необязательно" },
];

function initDataHeader() {
  return tg?.initData || "";
}

/** Same-origin by default; override with ?api= or meta tag for split deploys */
function apiBase() {
  const params = new URLSearchParams(location.search);
  if (params.get("api")) return params.get("api").replace(/\/$/, "");
  const meta = document.querySelector('meta[name="berezhno-api"]');
  if (meta?.content) return meta.content.replace(/\/$/, "");
  return "";
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initDataHeader(),
    ...(options.headers || {}),
  };
  const url = `${apiBase()}/api${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (networkErr) {
    const err = new Error("network_error");
    err.status = 0;
    err.data = { error: "network_error", detail: String(networkErr) };
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "request_failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function $(sel, root = document) {
  return root.querySelector(sel);
}

function $all(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(1);
}

function bar(v, max = 5) {
  const f = Math.round((v / max) * 5);
  return "█".repeat(f) + "░".repeat(5 - f);
}

function go(screen) {
  $all(".screen").forEach((s) => s.classList.toggle("active", s.dataset.screen === screen));
  $all(".tab").forEach((t) => t.classList.toggle("active", t.dataset.go === screen));

  if (screen === "checkin") resetCheckinUI();
  if (screen === "practices") loadPractices();
  if (screen === "stress") renderStressUI();
  if (screen === "journal") openJournalScreen();
  if (screen === "coach") renderCoachMeta();
  if (screen === "stats") loadStats();
  if (screen === "premium") renderPlans();
  if (screen === "onboarding") renderOnboarding();

  if (tg?.HapticFeedback) {
    try {
      tg.HapticFeedback.selectionChanged();
    } catch (_) {}
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openFeelingsEditor() {
  try {
    const areas = state.me?.focusAreas;
    state.focusDraft =
      Array.isArray(areas) && areas.length ? [...areas] : ["general"];
    go("onboarding");
    // macOS WebView sometimes needs a second paint
    requestAnimationFrame(() => {
      renderOnboarding();
      const chips = document.getElementById("focusChips");
      if (chips) chips.scrollTop = 0;
    });
  } catch (err) {
    console.error("openFeelingsEditor", err);
    toast("Не удалось открыть список чувств");
  }
}

/** Resolve click target — macOS WebView often fires on Text nodes inside buttons */
function eventEl(e) {
  const t = e.target;
  if (t instanceof Element) return t;
  if (t && t.parentElement) return t.parentElement;
  return null;
}

function onAppClick(e) {
  const target = eventEl(e);
  if (!target) return;

  // Feelings editor
  if (target.closest("[data-action='edit-feelings'], #editFeelingsBtn")) {
    e.preventDefault();
    e.stopPropagation();
    openFeelingsEditor();
    return;
  }

  // Journal tabs
  const jtab = target.closest("[data-journal-tab]");
  if (jtab) {
    e.preventDefault();
    e.stopPropagation();
    setJournalTab(jtab.getAttribute("data-journal-tab"));
    return;
  }

  // Open journal entry for edit
  const jitem = target.closest("[data-journal-id]");
  if (jitem) {
    e.preventDefault();
    e.stopPropagation();
    openJournalEdit(jitem.getAttribute("data-journal-id"));
    return;
  }

  const pay = target.closest("[data-pay-plan]");
  if (pay && !pay.disabled) {
    e.preventDefault();
    e.stopPropagation();
    startCryptoPay(pay.getAttribute("data-pay-plan"));
    return;
  }

  const freePlan = target.closest("[data-plan='free']");
  if (freePlan && !freePlan.disabled) {
    e.preventDefault();
    e.stopPropagation();
    startCryptoPay("free");
    return;
  }

  const coach = target.closest("[data-coach]");
  if (coach) {
    e.preventDefault();
    go("coach");
    sendCoach(coach.dataset.coach);
    return;
  }

  const nav = target.closest("[data-go]");
  if (nav) {
    e.preventDefault();
    go(nav.dataset.go);
  }
}

function bindNav() {
  // bubble phase is enough once Text-node clicks are resolved
  document.addEventListener("click", onAppClick, false);
}

async function loadMe() {
  try {
    state.me = await api("/me");
    const name = state.me.user.firstName || "друг";
    $("#greeting").textContent = `Привет, ${name}`;
    $("#streakChip").textContent = `🔥 ${state.me.streak}`;
    $("#sMood").textContent = fmt(state.me.stats.avgMood);
    $("#sEnergy").textContent = fmt(state.me.stats.avgEnergy);
    $("#sStress").textContent = fmt(state.me.stats.avgStress);
    $("#disclaimer").textContent = state.me.disclaimer || "";
    renderCoachMeta();

    if (!state.me.onboardingDone) {
      state.focusDraft = [...(state.me.focusAreas || ["general"])];
      go("onboarding");
    }
    updatePayBanner();
  } catch (e) {
    console.error(e);
    if (e.status === 401) {
      $("#greeting").textContent = "Открой через Telegram";
      toast("Открой приложение из бота @careofme_bot");
    } else if (e.status === 0) {
      $("#greeting").textContent = "Нет сети";
      toast("Сервер недоступен.");
    } else {
      $("#greeting").textContent = "Ошибка загрузки";
      toast("Не удалось загрузить профиль");
    }
  }
}

/* —— Onboarding —— */
const DEFAULT_FOCUS_LABELS = {
  burnout: "🔥 Выгорание",
  anxiety: "🌊 Тревога",
  insomnia: "🌙 Бессонница / сон",
  loneliness: "🫧 Одиночество",
  sadness: "🌧 Грусть / тяжесть",
  overwhelm: "🌀 Перегруз / хаос",
  anger: "⚡️ Раздражение / злость",
  emptiness: "🕳 Пустота / онемение",
  guilt: "🪞 Вина / стыд",
  fear: "🕯 Страх / неуверенность в будущем",
  relationships: "💬 Напряжение в отношениях",
  self_doubt: "🌫️ Неуверенность в себе",
  apathy: "🪨 Апатия / нет сил",
  general: "🌿 Просто тяжело / не знаю",
};

function renderOnboarding() {
  const labels = state.me?.focusLabels || DEFAULT_FOCUS_LABELS;
  if (!state.focusDraft?.length) state.focusDraft = ["general"];
  const box = $("#focusChips");
  if (!box) {
    console.warn("focusChips missing");
    return;
  }
  box.innerHTML = "";
  for (const [id, label] of Object.entries(labels)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.classList.toggle("on", state.focusDraft.includes(id));
    b.onclick = (ev) => {
      ev.preventDefault();
      const i = state.focusDraft.indexOf(id);
      if (i >= 0) {
        if (state.focusDraft.length > 1) state.focusDraft.splice(i, 1);
      } else state.focusDraft.push(id);
      renderOnboarding();
    };
    box.appendChild(b);
  }
}

/* —— Check-in —— */
function resetCheckinUI() {
  state.checkin = { step: 0, mood: null, energy: null, stress: null, sleep: null, note: "" };
  renderCheckinStep();
}

function renderCheckinStep() {
  const s = state.checkin.step;
  const meta = CHECKIN_STEPS[s];
  if (!meta) return;
  if ($("#checkinTitle")) $("#checkinTitle").textContent = meta.title;
  if ($("#checkinHint")) $("#checkinHint").textContent = meta.hint;

  const dots = $("#checkinDots");
  if (dots) {
    dots.innerHTML = CHECKIN_STEPS.map(
      (_, i) => `<span class="${i <= s ? "on" : ""}"></span>`
    ).join("");
  }

  const scoreRow = $("#scoreRow");
  const note = $("#checkinNote");
  const next = $("#checkinNext");
  const back = $("#checkinBack");
  if (!scoreRow || !next) return;

  if (meta.key === "note") {
    scoreRow.classList.add("hidden");
    note?.classList.remove("hidden");
    if (note) note.value = state.checkin.note || "";
    next.textContent = "Сохранить";
  } else {
    scoreRow.classList.remove("hidden");
    note?.classList.add("hidden");
    next.textContent = meta.key === "sleep" ? "Далее / пропуск" : "Далее";
    const current = state.checkin[meta.key];
    scoreRow.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "score" + (current === i ? " selected" : "");
      b.textContent = String(i);
      b.onclick = () => {
        state.checkin[meta.key] = i;
        renderCheckinStep();
        try {
          tg?.HapticFeedback?.impactOccurred?.("light");
        } catch (_) {}
      };
      scoreRow.appendChild(b);
    }
  }

  if (back) back.style.visibility = s === 0 ? "hidden" : "visible";
}

async function submitCheckin() {
  const s = state.checkin.step;
  const key = CHECKIN_STEPS[s].key;

  if (key === "note") {
    state.checkin.note = $("#checkinNote")?.value?.trim() || "";
  } else if (key !== "sleep" && !state.checkin[key]) {
    toast("Выбери оценку");
    return;
  }

  if (s < CHECKIN_STEPS.length - 1) {
    state.checkin.step += 1;
    renderCheckinStep();
    return;
  }

  try {
    const body = {
      mood: state.checkin.mood,
      energy: state.checkin.energy,
      stress: state.checkin.stress,
      note: state.checkin.note || undefined,
    };
    if (state.checkin.sleep) body.sleep = state.checkin.sleep;
    const res = await api("/checkin", { method: "POST", body });
    toast(`Сохранено · серия ${res.streak} 🔥`);
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    await loadMe();
    go("home");
  } catch {
    toast("Ошибка сохранения");
  }
}

/* —— Practices —— */
async function loadPractices() {
  const list = $("#practicesList");
  list.innerHTML = `<p class="muted">Загрузка…</p>`;
  try {
    const data = await api("/practices");
    list.innerHTML = "";
    for (const p of data.practices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "practice-item";
      b.innerHTML = `
        <div class="emoji">${p.emoji}</div>
        <div class="meta">
          <div class="t">${p.title}</div>
          <div class="s">${p.durationMin} мин · ${p.kind}</div>
        </div>
        <div class="lock">${p.locked ? "🔒" : "›"}</div>`;
      b.onclick = () => openPractice(p.id, p.locked);
      list.appendChild(b);
    }
  } catch {
    list.innerHTML = `<p class="muted">Не удалось загрузить</p>`;
  }
}

async function onRecommendPractice() {
  try {
    const { practice } = await api("/practices-recommend");
    openPractice(practice.id, false);
  } catch {
    toast("Нет рекомендации");
  }
}

async function openPractice(id, locked) {
  if (locked) {
    toast("Доступно в подписке");
    go("premium");
    return;
  }
  try {
    const { practice } = await api(`/practices/${id}`);
    state.currentPracticeId = practice.id;
    $("#pTitle").textContent = `${practice.emoji} ${practice.title}`;
    $("#pMeta").textContent = `~${practice.durationMin} мин`;
    $("#pIntro").textContent = practice.intro;
    $("#pOutro").textContent = practice.outro;
    $("#pSteps").innerHTML = practice.steps.map((s) => `<li>${s}</li>`).join("");
    go("practice-detail");
  } catch (e) {
    if (e.status === 403) {
      toast("Нужна подписка");
      go("premium");
    } else toast("Не найдено");
  }
}

async function onPracticeDone() {
  if (!state.currentPracticeId) return;
  try {
    await api(`/practices/${state.currentPracticeId}/done`, { method: "POST", body: {} });
    toast("Засчитано 🌿");
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    go("practices");
  } catch {
    toast("Ошибка");
  }
}

/* —— Stress —— */
function renderStressUI() {
  const row = $("#stressScore");
  if (!row) return;
  row.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "score" + (state.stressLevel === i ? " selected" : "");
    b.textContent = String(i);
    b.onclick = () => {
      state.stressLevel = i;
      renderStressUI();
    };
    row.appendChild(b);
  }

  const sources = state.me?.stressSources || [];
  const box = $("#stressSources");
  if (!box) return;
  box.innerHTML = "";
  for (const s of sources) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.label;
    b.classList.toggle("on", state.stressSource === s.label);
    b.onclick = () => {
      state.stressSource = s.label;
      renderStressUI();
    };
    box.appendChild(b);
  }
}

async function onStressSave() {
  if (!state.stressLevel) {
    toast("Выбери уровень");
    return;
  }
  try {
    await api("/stress", {
      method: "POST",
      body: {
        level: state.stressLevel,
        source: state.stressSource || undefined,
        note: $("#stressNote")?.value?.trim() || undefined,
      },
    });
    toast("Стресс записан");
    state.stressLevel = null;
    state.stressSource = null;
    if ($("#stressNote")) $("#stressNote").value = "";
    await loadMe();
    go("home");
  } catch {
    toast("Ошибка");
  }
}

/* —— Journal —— */
state.journalTab = "new";
state.journalEntries = [];
state.editingJournalId = null;

function openJournalScreen() {
  setJournalTab(state.journalTab || "new");
}

function setJournalTab(tab) {
  state.journalTab = tab;
  const newPane = $("#journalNewPane");
  const listPane = $("#journalListPane");
  const editPane = $("#journalEditPane");
  if (newPane) newPane.classList.toggle("hidden", tab !== "new");
  if (listPane) listPane.classList.toggle("hidden", tab !== "list");
  if (editPane) editPane.classList.toggle("hidden", tab !== "edit");

  $all("#journalTabs .seg-btn").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-journal-tab") === tab);
  });

  if (tab === "new") loadJournalPrompt();
  if (tab === "list") loadJournalList();
}

async function loadJournalPrompt() {
  try {
    const { prompt } = await api("/journal/prompt");
    state.journalPrompt = prompt;
    if ($("#journalPrompt")) $("#journalPrompt").textContent = prompt;
  } catch {
    if ($("#journalPrompt"))
      $("#journalPrompt").textContent =
        "Что сейчас сильнее всего влияет на твоё состояние?";
  }
}

function formatJournalDate(iso) {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

async function loadJournalList() {
  const list = $("#journalList");
  const empty = $("#journalEmpty");
  if (list) list.innerHTML = `<p class="muted">Загрузка…</p>`;
  try {
    const data = await api("/journal");
    state.journalEntries = data.entries || [];
    if (!state.journalEntries.length) {
      if (list) list.innerHTML = "";
      if (empty) empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";
    if (!list) return;
    list.innerHTML = state.journalEntries
      .map((e) => {
        const preview = (e.text || "").replace(/</g, "&lt;").slice(0, 280);
        const prompt = (e.prompt || "Запись").replace(/</g, "&lt;");
        const edited = e.updatedAt ? " · изм." : "";
        return `<button type="button" class="journal-item" data-journal-id="${e.id}">
          <span class="j-date">${formatJournalDate(e.at)}${edited}</span>
          <span class="j-prompt">${prompt}</span>
          <span class="j-text">${preview}</span>
        </button>`;
      })
      .join("");
  } catch {
    if (list) list.innerHTML = `<p class="muted">Не удалось загрузить записи</p>`;
    if (empty) empty.style.display = "none";
  }
}

function openJournalEdit(id) {
  const entry =
    state.journalEntries.find((x) => x.id === id) ||
    null;
  if (!entry) {
    toast("Запись не найдена");
    return;
  }
  state.editingJournalId = id;
  if ($("#journalEditPrompt")) $("#journalEditPrompt").textContent = entry.prompt || "";
  if ($("#journalEditText")) $("#journalEditText").value = entry.text || "";
  if ($("#journalEditMeta")) {
    const upd = entry.updatedAt
      ? ` · изменено ${formatJournalDate(entry.updatedAt)}`
      : "";
    $("#journalEditMeta").textContent = `Создано ${formatJournalDate(entry.at)}${upd}`;
  }
  setJournalTab("edit");
}

async function onJournalSave() {
  const text = $("#journalText")?.value?.trim() || "";
  if (!text) {
    toast("Напиши хотя бы пару слов");
    return;
  }
  try {
    await api("/journal", {
      method: "POST",
      body: { text, prompt: state.journalPrompt },
    });
    if ($("#journalText")) $("#journalText").value = "";
    toast("Сохранено 📝");
    await loadJournalPrompt();
    setJournalTab("list");
  } catch {
    toast("Ошибка");
  }
}

async function onJournalUpdate() {
  const id = state.editingJournalId;
  if (!id) return;
  const text = $("#journalEditText")?.value?.trim() || "";
  if (!text) {
    toast("Текст не может быть пустым");
    return;
  }
  try {
    await api(`/journal/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { text },
    });
    toast("Изменения сохранены");
    state.editingJournalId = null;
    setJournalTab("list");
  } catch {
    toast("Не удалось сохранить");
  }
}

async function onJournalDelete() {
  const id = state.editingJournalId;
  if (!id) return;
  if (!confirm("Удалить эту запись?")) return;
  try {
    await api(`/journal/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Удалено");
    state.editingJournalId = null;
    setJournalTab("list");
  } catch {
    toast("Не удалось удалить");
  }
}

/* —— Coach —— */
function renderCoachMeta() {
  const q = state.me?.coachQuota;
  if (q) $("#coachQuota").textContent = `${q.remaining}/${q.limit}`;
}

function appendBubble(text, who) {
  const chat = $("#chat");
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function sendCoach(text) {
  if (!text?.trim()) return;
  appendBubble(text, "me");
  $("#coachInput").value = "";
  appendBubble("…", "bot");
  const chat = $("#chat");
  const pending = chat.lastElementChild;
  try {
    const res = await api("/coach", { method: "POST", body: { text } });
    if (pending) pending.textContent = res.reply;
    else appendBubble(res.reply, "bot");
    if (state.me) {
      state.me.coachQuota = {
        remaining: res.remaining,
        limit: res.limit,
        ok: res.remaining > 0,
      };
      renderCoachMeta();
    }
    if (res.usedFallback === false) {
      /* live AI */
    }
  } catch (e) {
    if (pending) pending.remove();
    if (e.status === 429) {
      appendBubble(
        "Лимит на сегодня. Завтра обновится — или подписка 💎 (крипта через Crypto Bot).",
        "bot"
      );
      toast("Лимит коуча");
    } else {
      appendBubble("Сейчас не удалось ответить. Попробуй ещё раз.", "bot");
    }
  }
}

/* —— Stats —— */
async function loadStats() {
  try {
    const data = await api("/stats");
    const s = data.stats;
    $("#statsCard").innerHTML = `
      <div class="stats-mini" style="margin:0">
        <div class="stat"><div class="stat-v">${s.streak}</div><div class="stat-l">серия</div></div>
        <div class="stat"><div class="stat-v">${s.checkinCount}</div><div class="stat-l">чек-ины / 7д</div></div>
        <div class="stat"><div class="stat-v">${s.practiceCount}</div><div class="stat-l">практики</div></div>
      </div>
      <p style="margin:14px 0 0">
        Настроение ${fmt(s.avgMood)} <span class="bar">${s.avgMood != null ? bar(s.avgMood) : ""}</span><br/>
        Энергия ${fmt(s.avgEnergy)} <span class="bar">${s.avgEnergy != null ? bar(s.avgEnergy) : ""}</span><br/>
        Стресс ${fmt(s.avgStress)} <span class="bar">${s.avgStress != null ? bar(s.avgStress) : ""}</span>
      </p>`;

    const hist = $("#checkinHistory");
    if (!data.recentCheckins?.length) {
      hist.innerHTML = `<p class="muted">Пока нет чек-инов</p>`;
    } else {
      hist.innerHTML = data.recentCheckins
        .map((c) => {
          const d = new Date(c.at).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return `<div class="hist-row"><span>${d}</span><span>😊${c.mood} ⚡${c.energy} 🌊${c.stress}</span></div>`;
        })
        .join("");
    }
  } catch {
    $("#statsCard").innerHTML = `<p class="muted">Не удалось загрузить</p>`;
  }
}

/* —— Premium / Crypto pay —— */
state.lastInvoiceId = null;
state.lastPayUrl = null;

/** Convert https://t.me/CryptoBot?start=XXX → tg:// deep link (better on macOS Desktop) */
function toTgDeepLink(url) {
  try {
    const u = new URL(url, "https://t.me");
    if (!/t\.me$/i.test(u.hostname) && !/telegram\.me$/i.test(u.hostname)) {
      return null;
    }
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    // https://t.me/CryptoBot?start=IV...
    if (parts.length === 1 && u.searchParams.get("start")) {
      return `tg://resolve?domain=${encodeURIComponent(parts[0])}&start=${encodeURIComponent(u.searchParams.get("start"))}`;
    }
    // https://t.me/CryptoBot/app?startapp=...
    if (parts.length >= 1 && u.searchParams.get("startapp")) {
      return `tg://resolve?domain=${encodeURIComponent(parts[0])}&startapp=${encodeURIComponent(u.searchParams.get("startapp"))}`;
    }
    if (parts[0]) return `tg://resolve?domain=${encodeURIComponent(parts[0])}`;
  } catch (_) {}
  return null;
}

function openPayUrl(url) {
  if (!url) {
    toast("Нет ссылки на оплату");
    return;
  }

  const tgLink = toTgDeepLink(url);
  const desktop = isDesktopClient() || isMacDesktop();

  // 1) Official WebApp APIs
  try {
    if (typeof tg?.openTelegramLink === "function" && /t\.me\//i.test(url)) {
      tg.openTelegramLink(url);
      // On macOS this often no-ops — keep falling through with delay only if still here
      if (!desktop) return;
    }
  } catch (e) {
    console.warn("openTelegramLink", e);
  }

  // 2) tg:// deep link (macOS Telegram Desktop / Lite)
  if (tgLink) {
    try {
      const a = document.createElement("a");
      a.href = tgLink;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.warn("tg://", e);
    }
    try {
      window.location.href = tgLink;
    } catch (_) {}
  }

  // 3) openLink / https
  try {
    if (typeof tg?.openLink === "function") {
      tg.openLink(url, { try_instant_view: false });
    }
  } catch (e) {
    console.warn("openLink", e);
  }

  // 4) last resort
  try {
    window.open(url, "_blank");
  } catch (_) {}
}

function showPayModal(plan, payUrl, invoiceId) {
  state.lastInvoiceId = invoiceId;
  state.lastPayUrl = payUrl;
  const title = plan === "plus" ? "Плюс · 349 ₽" : "Забота · 199 ₽";
  const usdtHint = plan === "plus" ? "≈ 4.31 USDT" : "≈ 2.46 USDT";
  const macHint = isMacDesktop() || isDesktopClient()
    ? " На Mac: обязательно нажми кнопку «Открыть Crypto Bot» (авто-переход блокируется)."
    : "";
  $("#payModalText").textContent =
    `Тариф «${title}» · ${usdtHint} (курс 81 ₽). Оплати в Crypto Bot, вернись и нажми «Проверить оплату».${macHint}`;
  $("#payModal").classList.remove("hidden");
  const st = $("#payStatus");
  if (st) st.textContent = `Счёт #${invoiceId} создан`;
  // Focus primary action for keyboard / accessibility on desktop
  setTimeout(() => {
    document.getElementById("payModalOpen")?.focus?.();
  }, 50);
}

function hidePayModal() {
  $("#payModal")?.classList.add("hidden");
}

async function startCryptoPay(plan) {
  if (!plan) return;
  if (state._paying) return; // prevent double invoices
  if (plan === "free") {
    try {
      await api("/plan", { method: "POST", body: { plan: "free" } });
      toast("Бесплатный тариф");
      await loadMe();
      renderPlans();
    } catch (e) {
      if (e.data?.error === "already_premium") {
        toast("У тебя уже есть подписка");
        await loadMe();
      } else toast("Ошибка");
    }
    return;
  }

  if (!state.me?.cryptoPayConfigured) {
    toast("Оплата временно недоступна");
    return;
  }

  state._paying = true;
  toast("Создаю счёт…");
  try {
    const res = await api("/plan", { method: "POST", body: { plan } });
    if (res.payment === "already_active") {
      toast("Подписка уже активна");
      await loadMe();
      renderPlans();
      return;
    }
    if (res.payment === "crypto" && res.payUrl) {
      showPayModal(plan, res.payUrl, res.invoiceId);
      startPayPolling(res.invoiceId, true);
      // Desktop/macOS blocks navigation without direct user gesture —
      // do NOT auto-open; user taps «Открыть Crypto Bot» in the modal.
      // On mobile we can try auto-open after a short delay.
      if (!isDesktopClient() && !isMacDesktop()) {
        setTimeout(() => openPayUrl(res.payUrl), 200);
      } else {
        toast("Нажми «Открыть Crypto Bot» ниже");
      }
      return;
    }
    toast("Не удалось создать оплату");
  } catch (e) {
    console.error(e);
    if (e.data?.error === "payments_not_configured") {
      toast("Крипто-оплата не настроена");
    } else if (e.data?.error === "invoice_failed") {
      toast("Crypto Bot не создал счёт");
    } else if (e.data?.error === "already_premium") {
      toast("Подписка уже активна");
      await loadMe();
    } else if (e.status === 401) {
      toast("Открой app из @careofme_bot");
    } else {
      toast("Ошибка оплаты");
    }
  } finally {
    state._paying = false;
  }
}

function startPayPolling(invoiceId, silent = true) {
  let n = 0;
  if (state._payTimer) clearInterval(state._payTimer);
  state._payTimer = setInterval(async () => {
    n++;
    const ok = await verifyPayment(invoiceId, silent);
    if (ok || n > 40) {
      clearInterval(state._payTimer);
      state._payTimer = null;
    }
  }, 5000);
}

async function verifyPayment(invoiceId, silent = false) {
  try {
    const st = await api("/plan/check", {
      method: "POST",
      body: { invoiceId: invoiceId || state.lastInvoiceId || undefined },
    });
    if (st.premium) {
      toast("Оплата прошла ✨");
      hidePayModal();
      await loadMe();
      renderPlans();
      return true;
    }
    if (!silent) toast("Оплата ещё не пришла — подожди 10–20 сек");
    return false;
  } catch {
    if (!silent) toast("Не удалось проверить");
    return false;
  }
}

function updatePayBanner() {
  const banner = $("#payBanner");
  const chip = $("#payChip");
  if (!banner) return;

  if (state.me?.premium) {
    const until = state.me.premiumUntil
      ? new Date(state.me.premiumUntil).toLocaleDateString("ru-RU")
      : "";
    const title =
      state.me.plans?.[state.me.plan]?.title || state.me.plan || "Pro";
    banner.innerHTML = `
      <div class="pay-banner-title">✅ Подписка активна</div>
      <p class="muted">Тариф «${title}»${until ? ` до ${until}` : ""}</p>
      <button class="linkish" data-go="premium" type="button">Управление →</button>`;
    if (chip) chip.textContent = "✅ Pro";
    return;
  }

  // Restore pay UI for free users
  banner.innerHTML = `
    <div class="pay-banner-title">💎 Подписка · оплата криптой</div>
    <p class="muted" id="payBannerText">
      ${
        state.me?.cryptoPayConfigured
          ? "USDT · фиксированный курс 81 ₽ · через Crypto Bot"
          : "⚠️ Оплата временно недоступна"
      }
    </p>
    <div class="pay-row">
      <button class="btn primary" type="button" data-pay-plan="care">
        Забота · 199 ₽
      </button>
      <button class="btn primary" type="button" data-pay-plan="plus">
        Плюс · 349 ₽
      </button>
    </div>
    <button class="linkish" data-go="premium" type="button">Все тарифы и детали →</button>`;
  if (chip) chip.textContent = "💎 Pro";
  bindPayButtons(banner);
}

function renderPlans() {
  const plans = state.me?.plans;
  if (!plans) {
    $("#plans").innerHTML = `<p class="muted">Загрузка…</p>`;
    return;
  }
  const current = state.me.plan || "free";
  const cryptoOk = !!state.me.cryptoPayConfigured;
  const premium = !!state.me.premium;
  const info = $("#cryptoInfo");
  if (info) info.style.display = premium ? "none" : "block";

  // Always rebuild plan cards from live flags — never show legacy "demo" labels
  $("#plans").innerHTML =
    `<p class="muted" style="margin-bottom:10px">${
      premium
        ? "Твоя подписка активна. Ниже — что входит в тарифы."
        : cryptoOk
          ? "Оплата в USDT через Crypto Bot (курс 81 ₽). На Mac после счёта нажми «Открыть Crypto Bot»."
          : "⚠️ Оплата на сервере недоступна"
    }</p>` +
    Object.values(plans)
      .map((p) => {
        const active = premium
          ? current === p.id
          : p.id === "free" && (!premium || current === "free");
        let btn = "";
        if (p.id === "free") {
          if (!premium) {
            btn = `<button class="btn ghost block" type="button" data-plan="free">${
              active ? "Текущий тариф" : "Остаться на free"
            }</button>`;
          }
        } else if (premium && current === p.id) {
          btn = `<button class="btn ghost block" type="button" disabled>Активен</button>`;
        } else if (premium && current !== p.id) {
          btn = `<button class="btn primary block" type="button" data-pay-plan="${p.id}">💎 Перейти · ${p.price}</button>`;
        } else if (cryptoOk) {
          const usdt = p.id === "plus" ? "4.31 USDT" : "2.46 USDT";
          btn = `<button class="btn primary block" type="button" data-pay-plan="${p.id}">💎 Оплатить · ${p.price} · ${usdt}</button>`;
        } else {
          btn = `<button class="btn ghost block" type="button" disabled>Оплата недоступна</button>`;
        }
        return `
      <div class="plan">
        <h3>${p.title}${active && p.id !== "free" && premium ? " · сейчас" : ""}</h3>
        <div class="price">${p.price}</div>
        <ul>${(p.perks || []).map((x) => `<li>${x}</li>`).join("")}</ul>
        ${btn}
      </div>`;
      })
      .join("");
}

function bindPayButtons(_root) {
  // no-op: clicks handled by document body delegation (avoids double invoices)
}

/* —— boot —— */
function wireUi() {
  bindNav();

  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };

  on("onboardingDone", "click", async () => {
    try {
      if (!state.focusDraft?.length) state.focusDraft = ["general"];
      await api("/onboarding", {
        method: "POST",
        body: { focusAreas: state.focusDraft },
      });
      toast("Сохранено");
      await loadMe();
      go("home");
    } catch {
      toast("Не удалось сохранить");
    }
  });

  on("checkinBack", "click", () => {
    if (state.checkin.step > 0) {
      state.checkin.step -= 1;
      renderCheckinStep();
    }
  });
  on("checkinNext", "click", () => submitCheckin());
  on("recommendPractice", "click", () => onRecommendPractice());
  on("practiceDone", "click", () => onPracticeDone());
  on("stressSave", "click", () => onStressSave());
  on("journalRefresh", "click", () => loadJournalPrompt());
  on("journalSave", "click", () => onJournalSave());
  on("journalEditBack", "click", () => {
    state.editingJournalId = null;
    setJournalTab("list");
  });
  on("journalUpdate", "click", () => onJournalUpdate());
  on("journalDelete", "click", () => onJournalDelete());
  on("checkPayBtn", "click", () => verifyPayment(state.lastInvoiceId, false));
  // Use real <a> click + openPayUrl — critical for macOS Desktop user-gesture rules
  on("payModalOpen", "click", (ev) => {
    ev.preventDefault();
    const url = state.lastPayUrl;
    const deep = url ? toTgDeepLink(url) : null;
    const el = document.getElementById("payModalOpen");
    if (el && url) {
      el.setAttribute("href", deep || url);
    }
    openPayUrl(url);
  });
  on("payModalCheck", "click", () => verifyPayment(state.lastInvoiceId, false));
  on("payModalClose", "click", hidePayModal);

  // Also bind feelings button directly (belt + suspenders for macOS)
  on("editFeelingsBtn", "click", (ev) => {
    ev.preventDefault();
    openFeelingsEditor();
  });

  const form = $("#coachForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendCoach($("#coachInput")?.value || "");
    });
  }
}

wireUi();
loadMe().catch((e) => console.error("loadMe", e));

if (!tg?.initData) {
  console.info("Preview mode: open via Telegram bot for full auth");
}
