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
  // Full height on modern Telegram (iOS / Android / Desktop)
  try {
    if (typeof tg.requestFullscreen === "function" && tg.isVersionAtLeast?.("8.0")) {
      /* optional — skip fullscreen to avoid UX surprises */
    }
    if (typeof tg.disableVerticalSwipes === "function") {
      try {
        tg.disableVerticalSwipes();
      } catch (_) {}
    }
  } catch (_) {}
}

// Keep layout stable when mobile keyboard opens (iOS / Android WebView)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVv = () => {
    document.documentElement.style.setProperty(
      "--vvh",
      `${Math.round(vv.height)}px`
    );
  };
  vv.addEventListener("resize", onVv);
  vv.addEventListener("scroll", onVv);
  onVv();
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

function getInitData() {
  // Always read live — some mobile clients refresh after ready()
  try {
    const live = window.Telegram?.WebApp?.initData;
    if (live) return live;
  } catch (_) {}
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

/** Short server session — avoids sending huge initData on every GET (Android header bugs) */
const SESSION_KEY = "careofme_session_v1";
let sessionToken = "";
let sessionReady = null;

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s?.token && s?.exp && s.exp > Date.now()) {
      sessionToken = s.token;
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch (_) {}
}
loadStoredSession();

function storeSession(token, exp) {
  sessionToken = token || "";
  try {
    if (token) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ token, exp }));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch (_) {}
}

function showAuthBanner(msg) {
  const el = $("#authBanner");
  if (!el) return;
  el.classList.remove("hidden");
  const text = $("#authBannerText");
  if (text) text.textContent = msg || "Открой приложение из бота @careofme_bot";
}

function hideAuthBanner() {
  const el = $("#authBanner");
  if (el) el.classList.add("hidden");
}

function apiErrorMessage(err) {
  const code = err?.data?.error || err?.message || "";
  if (err?.status === 0 || code === "network_error") {
    return "Нет сети. Проверь интернет и попробуй ещё раз";
  }
  if (err?.status === 429 || code === "rate_limited") {
    return err?.data?.message || "Слишком много запросов — подожди немного";
  }
  if (err?.status === 408 || code === "timeout") {
    return "Запрос слишком долгий. Попробуй ещё раз";
  }
  if (
    err?.status === 401 ||
    code === "invalid_init_data" ||
    code === "missing_init_data"
  ) {
    return (
      err?.data?.message ||
      "Открой приложение заново из бота @careofme_bot (меню или /app)"
    );
  }
  if (code === "text_required") return "Напиши хотя бы пару слов";
  if (code === "save_failed") return "Не удалось сохранить на сервере";
  return err?.data?.message || "Не удалось выполнить запрос";
}

async function ensureSession(force = false) {
  if (!force && sessionToken) return sessionToken;
  if (sessionReady && !force) return sessionReady;

  sessionReady = (async () => {
    const initData = getInitData();
    if (!initData) {
      const err = new Error("missing_init_data");
      err.status = 401;
      err.data = {
        error: "missing_init_data",
        message:
          "Telegram не передал вход. Открой из @careofme_bot → /start → «Открыть careofme» или /app",
      };
      throw err;
    }

    const res = await fetch(`${apiBase()}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      // initData ONLY in body — most reliable path on phones
      body: JSON.stringify({ initData }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      storeSession("", 0);
      const err = new Error(data.error || "auth_failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    storeSession(data.token, data.exp);
    return data.token;
  })();

  try {
    return await sessionReady;
  } catch (e) {
    sessionReady = null;
    throw e;
  }
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // Login itself must not recurse
  const isAuthCall = path === "/auth" || path.startsWith("/auth?");

  if (!isAuthCall) {
    try {
      await ensureSession(false);
    } catch (e) {
      // one retry after clearing stale token
      if (sessionToken) {
        storeSession("", 0);
        sessionReady = null;
        await ensureSession(true);
      } else {
        throw e;
      }
    }
  }

  const initData = getInitData();
  const headers = {
    "Content-Type": "application/json",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
    // Keep initData header as secondary fallback (short sessions / old clients)
    ...(initData && initData.length < 3500
      ? { "X-Telegram-Init-Data": initData }
      : {}),
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === "object" && method !== "GET" && method !== "HEAD") {
    body = {
      ...body,
      ...(sessionToken ? { sessionToken } : {}),
      // body initData backup for POSTs if session missing mid-flight
      ...(initData ? { initData } : {}),
    };
  } else if (!body && method !== "GET" && method !== "HEAD") {
    body = {
      ...(sessionToken ? { sessionToken } : {}),
      ...(initData ? { initData } : {}),
    };
  }

  let url = `${apiBase()}/api${path}`;
  // GET: pass short session token in query if headers are stripped (Android)
  if ((method === "GET" || method === "HEAD") && sessionToken) {
    const join = path.includes("?") ? "&" : "?";
    url += `${join}sessionToken=${encodeURIComponent(sessionToken)}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (networkErr) {
    const err = new Error("network_error");
    err.status = 0;
    err.data = { error: "network_error", detail: String(networkErr) };
    throw err;
  }
  const data = await res.json().catch(() => ({}));

  // Stale session → re-auth once
  if (
    res.status === 401 &&
    !isAuthCall &&
    !options._retried &&
    (data.error === "invalid_init_data" ||
      data.error === "missing_init_data" ||
      !sessionToken)
  ) {
    storeSession("", 0);
    sessionReady = null;
    try {
      await ensureSession(true);
      return api(path, { ...options, _retried: true });
    } catch {
      /* fall through */
    }
  }

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
  if (screen === "therapy") loadTherapy();
  if (screen === "achievements") loadAchievements();
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
    state.feelingsMode = "edit"; // analyze after save
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

  // Journal save / update — delegated (mobile WebView sometimes misses direct bind)
  if (target.closest("#journalSave")) {
    e.preventDefault();
    e.stopPropagation();
    onJournalSave();
    return;
  }
  if (target.closest("#journalUpdate")) {
    e.preventDefault();
    e.stopPropagation();
    onJournalUpdate();
    return;
  }
  if (target.closest("#journalDelete")) {
    e.preventDefault();
    e.stopPropagation();
    onJournalDelete();
    return;
  }
  if (target.closest("#journalRefresh")) {
    e.preventDefault();
    e.stopPropagation();
    loadJournalPrompt();
    return;
  }
  if (target.closest("#journalEditBack")) {
    e.preventDefault();
    e.stopPropagation();
    state.editingJournalId = null;
    setJournalTab("list");
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

  // Multi practice picks on support screen
  const pp = target.closest("[data-open-practice]");
  if (pp) {
    e.preventDefault();
    e.stopPropagation();
    const pid = pp.getAttribute("data-open-practice");
    if (pid) openPractice(pid, false);
    return;
  }

  const trial = target.closest("[data-trial-plan]");
  if (trial && !trial.disabled) {
    e.preventDefault();
    e.stopPropagation();
    startTrial(trial.getAttribute("data-trial-plan"));
    return;
  }

  const periodOpt = target.closest("[data-plan-period]");
  if (periodOpt && !periodOpt.disabled) {
    e.preventDefault();
    e.stopPropagation();
    const plan = periodOpt.getAttribute("data-pay-for") || state.pendingPayPlan;
    const period = periodOpt.getAttribute("data-plan-period");
    hidePeriodModal();
    if (plan && period) startCryptoPay(plan, period);
    return;
  }

  const pay = target.closest("[data-pay-plan]");
  if (pay && !pay.disabled) {
    e.preventDefault();
    e.stopPropagation();
    openPeriodPicker(pay.getAttribute("data-pay-plan"));
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
    // Establish session first (initData in POST body — works for all testers)
    await ensureSession(false);
    state.me = await api("/me");
    hideAuthBanner();
    const name = state.me.user.firstName || "друг";
    $("#greeting").textContent = `Привет, ${name}`;
    $("#streakChip").textContent = `💫 ${state.me.streak}`;
    $("#sMood").textContent = fmt(state.me.stats.avgMood);
    $("#sEnergy").textContent = fmt(state.me.stats.avgEnergy);
    $("#sStress").textContent = fmt(state.me.stats.avgStress);
    $("#disclaimer").textContent = state.me.disclaimer || "";
    renderCoachMeta();

    if (!state.me.onboardingDone) {
      state.focusDraft = [...(state.me.focusAreas || ["general"])];
      state.feelingsMode = "onboarding";
      go("onboarding");
    }
    updatePayBanner();
    updateFeelingsAnalysisUi();
    // Soft refresh achievement counter on home
    loadAchievements().catch(() => {});
  } catch (e) {
    console.error("loadMe", e);
    if (e.status === 401) {
      $("#greeting").textContent = "Открой через Telegram";
      const msg = apiErrorMessage(e);
      showAuthBanner(msg);
      toast(msg);
    } else if (e.status === 0) {
      $("#greeting").textContent = "Нет сети";
      showAuthBanner("Нет связи с сервером. Проверь интернет.");
      toast("Сервер недоступен.");
    } else {
      $("#greeting").textContent = "Ошибка загрузки";
      toast("Не удалось загрузить профиль");
    }
  }
}

/* —— Onboarding —— */
const DEFAULT_FOCUS_LABELS = {
  burnout: "🍂 Выгорание",
  anxiety: "🌊 Тревога",
  insomnia: "🌙 Бессонница / сон",
  loneliness: "🤍 Одиночество",
  sadness: "🌧 Грусть / тяжесть",
  overwhelm: "🍃 Перегруз / хаос",
  anger: "🪨 Раздражение / злость",
  emptiness: "☁️ Пустота / онемение",
  guilt: "🪞 Вина / стыд",
  fear: "🕯 Страх / неуверенность в будущем",
  relationships: "💬 Напряжение в отношениях",
  self_doubt: "🌫️ Неуверенность в себе",
  apathy: "🌑 Апатия / нет сил",
  general: "🌿 Просто тяжело / не знаю",
};

function renderOnboarding() {
  const labels = state.me?.focusLabels || DEFAULT_FOCUS_LABELS;
  if (!state.focusDraft?.length) state.focusDraft = ["general"];
  const editing = state.feelingsMode === "edit" || state.me?.onboardingDone;
  const title = $("#onboardingTitle");
  const hint = $("#onboardingHint");
  const doneBtn = $("#onboardingDone");
  const skipBtn = $("#onboardingSkipHome");
  if (title) {
    title.textContent = editing
      ? "Что ты чувствуешь сейчас?"
      : "Что ты чувствуешь сейчас?";
  }
  if (hint) {
    hint.textContent = editing
      ? "Отметь, что ближе. Нажми «Разобрать и помочь» — сохраним выбор и разберём ситуацию, не просто вернём на главную."
      : "Можно несколько — это не диагноз. После выбора разберём, что за этим может стоять, и что поможет.";
  }
  if (doneBtn) {
    doneBtn.textContent = "Разобрать и помочь";
    doneBtn.disabled = false;
  }
  if (skipBtn) {
    skipBtn.style.display = editing ? "" : "none";
  }

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

async function finishFeelingsSelection({ analyze = true, goHome = false } = {}) {
  if (state._feelingsSaving) return;
  if (!state.focusDraft?.length) state.focusDraft = ["general"];
  state._feelingsSaving = true;
  const doneBtn = $("#onboardingDone");
  if (doneBtn) {
    doneBtn.disabled = true;
    doneBtn.textContent = analyze ? "Разбираю…" : "Сохраняю…";
  }
  try {
    const res = await api("/onboarding", {
      method: "POST",
      body: {
        focusAreas: state.focusDraft,
        analyze: !!analyze,
      },
    });
    toast(analyze ? "Смотрю, что за этим стоит…" : "Сохранено");
    await loadMe();

    if (analyze && (res.reflection || res.autoHelp || res.crisis)) {
      const help = res.autoHelp || {
        text: res.reflection?.text,
        practiceId: res.reflection?.practiceId,
        practiceTitle: res.reflection?.practiceTitle,
      };
      showSupportResult({
        title: res.crisis ? "Важно · поддержка" : "Разбор чувств",
        meta: res.reflection?.labels?.length
          ? `Сейчас: ${res.reflection.labels.join("· ")}`
          : "На основе твоего выбора",
        insight: null,
        autoHelp: help,
        needsSupport: true,
        crisis: !!res.crisis,
      });
      // Friendlier header for non-crisis feelings reflection
      if (!res.crisis && help?.text) {
        const helpEl = $("#supportHelp");
        if (helpEl) {
          helpEl.classList.remove("crisis-help");
          helpEl.textContent =
            "🪞 Что может стоять за этим\n\n" + help.text;
        }
      }
    } else {
      go("home");
    }
    state.feelingsMode = null;
  } catch (e) {
    console.error("finishFeelings", e);
    toast(apiErrorMessage(e) || "Не удалось сохранить");
  } finally {
    state._feelingsSaving = false;
    if (doneBtn) {
      doneBtn.disabled = false;
      doneBtn.textContent = "Разобрать и помочь";
    }
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
      (_, i) => `<span class="${i <= s ? "on": ""}"></span>`
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
      b.className = "score" + (current === i ? "selected" : "");
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
    toast(`Сохранено · серия ${res.streak}`);
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    await loadMe();
    if (res.crisis || res.insight || res.autoHelp || res.needsSupport) {
      showSupportResult({
        title: res.crisis ? "Важно · поддержка" : "Чек-ин сохранён",
        meta: `Серия ${res.streak} дн. · настроение ${state.checkin.mood}/5 · стресс ${state.checkin.stress}/5`,
        insight: res.crisis ? null : res.insight,
        autoHelp: res.autoHelp,
        needsSupport: res.needsSupport || res.crisis,
        crisis: !!res.crisis,
      });
    } else {
      go("home");
    }
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
        <div class="emoji">${p.emoji || "🌿"}</div>
        <div class="meta">
          <div class="t">${p.title}</div>
          <div class="s">${p.durationMin} мин · ${p.kind}</div>
        </div>
        <div class="lock">${p.locked ? "🔒" : "›"}</div>`;
      b.onclick = () => openPractice(p.id, p.locked);
      list.appendChild(b);
    }
  } catch (e) {
    list.innerHTML = `<p class="muted">${apiErrorMessage(e)}</p>`;
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
    $("#pTitle").textContent = `${practice.emoji || ""} ${practice.title}`.trim();
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

function celebrateAchievements(list) {
  if (!list?.length) return;
  const first = list[0];
  const more = list.length > 1 ? ` (+${list.length - 1})` : "";
  const msg = `${first.emoji || "✨"} ${first.title || "Ачивка"}${more}`;
  toast(msg);
  let el = document.getElementById("achToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "achToast";
    el.className = "ach-toast hidden";
    document.body.appendChild(el);
  }
  el.textContent = `Ачивка: ${first.emoji || "✨"} ${first.title || ""}${more}`;
  el.classList.remove("hidden");
  clearTimeout(celebrateAchievements._t);
  celebrateAchievements._t = setTimeout(() => el.classList.add("hidden"), 3200);
  if (tg?.HapticFeedback) {
    try {
      tg.HapticFeedback.notificationOccurred("success");
    } catch (_) {}
  }
}

async function onPracticeDone() {
  if (!state.currentPracticeId) return;
  try {
    const res = await api(`/practices/${state.currentPracticeId}/done`, {
      method: "POST",
      body: {},
    });
    toast("Засчитано 🌿");
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (res.newAchievements?.length) celebrateAchievements(res.newAchievements);
    go("practices");
  } catch {
    toast("Ошибка");
  }
}

/* —— Therapy —— */
async function loadTherapy() {
  const list = $("#therapyList");
  const disc = $("#therapyDisclaimer");
  if (list) list.innerHTML = `<p class="muted">Загрузка…</p>`;
  try {
    const data = await api("/therapy");
    if (disc) disc.textContent = data.disclaimer || "";
    if (!list) return;
    list.innerHTML = "";
    for (const t of data.modules || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "practice-item";
      b.innerHTML = `
        <div class="emoji">${t.emoji || "🤍"}</div>
        <div class="meta">
          <div class="t">${t.title}</div>
          <div class="s">${t.durationMin} мин · самопомощь</div>
        </div>
        <div class="lock">${t.locked ? "🔒" : "›"}</div>`;
      b.onclick = () => openTherapy(t.id, t.locked);
      list.appendChild(b);
    }
  } catch (e) {
    if (list) list.innerHTML = `<p class="muted">${apiErrorMessage(e)}</p>`;
  }
}

async function openTherapy(id, locked) {
  if (locked) {
    toast("Модуль доступен в подписке");
    go("premium");
    return;
  }
  try {
    const { module: t } = await api(`/therapy/${id}`);
    state.currentTherapyId = t.id;
    if ($("#tTitle")) if ($("#tTitle")) $("#tTitle").textContent = `${t.emoji || ""} ${t.title}`.trim();
    if ($("#tMeta")) $("#tMeta").textContent = `~${t.durationMin} мин`;
    if ($("#tDisclaimer")) $("#tDisclaimer").textContent = t.disclaimer || "";
    if ($("#tIntro")) $("#tIntro").textContent = t.intro || "";
    if ($("#tOutro")) $("#tOutro").textContent = t.outro || "";
    if ($("#tSteps")) {
      $("#tSteps").innerHTML = (t.steps || []).map((s) => `<li>${s}</li>`).join("");
    }
    go("therapy-detail");
  } catch (e) {
    if (e.status === 403) {
      toast("Нужна подписка");
      go("premium");
    } else toast("Не найдено");
  }
}

async function onTherapyDone() {
  if (!state.currentTherapyId) return;
  try {
    const res = await api(`/therapy/${state.currentTherapyId}/done`, {
      method: "POST",
      body: {},
    });
    toast("Модуль завершён ");
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (res.newAchievements?.length) celebrateAchievements(res.newAchievements);
    go("therapy");
  } catch {
    toast("Ошибка");
  }
}

/* —— Achievements —— */
async function loadAchievements() {
  const list = $("#achList");
  if (list) list.innerHTML = `<p class="muted">Загрузка…</p>`;
  try {
    const data = await api("/achievements");
    const s = data.stats || {};
    if ($("#achChip")) {
      $("#achChip").textContent = `${s.unlockedCount || 0}/${s.totalAchievements || 0}`;
    }
    if ($("#achStats")) {
      $("#achStats").textContent =
        `Практик: ${s.totalPractices || 0} · разных: ${s.uniquePractices || 0} · ` +
        `серия дней: ${s.dayStreak || 0} · терапия: ${s.therapyCount || 0}`;
    }
    if ($("#homeAchCount")) {
      $("#homeAchCount").textContent =
        s.unlockedCount != null
          ? `${s.unlockedCount}/${s.totalAchievements || 0}`
          : "за практики";
    }
    if (!list) return;
    list.innerHTML = (data.achievements || [])
      .map((a) => {
        const unlocked = a.unlocked;
        const when = a.unlockedAt
          ? new Date(a.unlockedAt).toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "short",
            })
          : "";
        return `<div class="ach-item ${unlocked ? "": "locked"}">
          <div class="ach-emoji">${a.emoji || "✨"}</div>
          <div>
            <div class="ach-title">${a.title || ""}</div>
            <div class="ach-desc">${a.description || ""}</div>
            <div class="ach-meta">${
              unlocked ? `Открыто · ${when}` : a.hint || "Ещё не открыто"
            }</div>
          </div>
        </div>`;
      })
      .join("");
  } catch (e) {
    if (list) list.innerHTML = `<p class="muted">${apiErrorMessage(e)}</p>`;
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
    b.className = "score" + (state.stressLevel === i ? "selected" : "");
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

function showSupportResult({
  title,
  meta,
  insight,
  autoHelp,
  needsSupport,
  crisis,
}) {
  state.lastAutoHelp = autoHelp || null;
  state.lastCrisis = !!crisis || !!autoHelp?.urgent;
  if ($("#supportTitle")) {
    $("#supportTitle").textContent = crisis
      ? "Важно · поддержка"
      : title || "Сохранено";
  }
  if ($("#supportMeta")) {
    $("#supportMeta").textContent = crisis
      ? "Живая помощь важнее бота · 8-800-2000-122 · 112"
      : meta || "";
  }

  const insightEl = $("#supportInsight");
  if (insightEl) {
    // When crisis, put full text in help block; skip duplicate insight
    if (insight && !crisis) {
      insightEl.classList.remove("hidden");
      insightEl.textContent = insight;
    } else {
      insightEl.classList.add("hidden");
      insightEl.textContent = "";
    }
  }

  const helpEl = $("#supportHelp");
  if (helpEl) {
    if (autoHelp?.text) {
      helpEl.classList.remove("hidden");
      helpEl.classList.toggle("crisis-help", !!crisis || !!autoHelp.urgent);
      const prefix = crisis || autoHelp.urgent
        ? "Сейчас важна живая поддержка\n\n"
        : needsSupport
          ? "Поддержка · варианты именно для тебя\n\n"
          : "";
      helpEl.textContent = prefix + autoHelp.text;
    } else {
      helpEl.classList.add("hidden");
      helpEl.classList.remove("crisis-help");
      helpEl.textContent = "";
    }
  }

  const practiceBtn = $("#supportPracticeBtn");
  const picks = Array.isArray(autoHelp?.practices) ? autoHelp.practices : [];
  const wrap = $("#supportPracticesWrap");
  const list = $("#supportPractices");

  if (list && wrap) {
    if (picks.length) {
      wrap.classList.remove("hidden");
      list.innerHTML = picks
        .map((p) => {
          const title = `${p.emoji || "🌿"} ${p.title || "Практика"}`;
          const meta = p.durationMin ? `~${p.durationMin} мин` : "";
          const reason = (p.reason || "").replace(/</g, "&lt;");
          return `<button type="button" class="practice-pick" data-open-practice="${p.id}">
            <span class="pp-title">${title}</span>
            <span class="pp-meta">${meta}</span>
            ${reason ? `<span class="pp-reason">${reason}</span>` : ""}
          </button>`;
        })
        .join("");
      // Primary button opens first pick
      if (practiceBtn) {
        practiceBtn.style.display = "none";
      }
    } else {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      if (practiceBtn) {
        if (autoHelp?.practiceId || needsSupport || crisis) {
          practiceBtn.style.display = "";
          practiceBtn.dataset.practiceId =
            autoHelp?.practiceId || "box_breath";
          practiceBtn.textContent = autoHelp?.practiceTitle
            ? ` ${autoHelp.practiceTitle}`
            : "Практика";
        } else {
          practiceBtn.style.display = "none";
        }
      }
    }
  } else if (practiceBtn) {
    if (autoHelp?.practiceId) {
      practiceBtn.style.display = "";
      practiceBtn.dataset.practiceId = autoHelp.practiceId;
      practiceBtn.textContent = autoHelp.practiceTitle
        ? ` ${autoHelp.practiceTitle}`
        : "Практика";
    } else {
      practiceBtn.style.display = needsSupport || crisis ? "" : "none";
      practiceBtn.dataset.practiceId = autoHelp?.practiceId || "box_breath";
      practiceBtn.textContent = "Практика";
    }
  }

  go("support-result");
}

async function runFeelingsAnalysis() {
  const out = $("#feelingsAnalysisOut");
  const isPlus =
    state.me?.premium && state.me?.plan === "plus";
  if (!isPlus) {
    toast("Полный анализ — в тарифе Плюс");
    go("premium");
    return;
  }
  if (out) {
    out.classList.remove("hidden");
    out.textContent = "Собираю разбор чувств…";
  }
  toast("Анализирую…");
  try {
    const data = await api("/analysis/feelings");
    const risk = data.summary?.riskLevel || "ok";
    const riskLabel =
      risk === "hard" ? "тяжело" : risk === "watch" ? "внимание" : "опора";
    const chip = `<span class="risk-chip ${risk}">уровень: ${riskLabel}</span>`;
    const statsLine =
      data.summary &&
      (data.summary.avgMood != null || data.summary.checkinCount)
        ? `\n\nСр. настроение ${
            data.summary.avgMood != null
              ? data.summary.avgMood.toFixed(1)
              : "—"
          } · стресс ${
            data.summary.avgStress != null
              ? data.summary.avgStress.toFixed(1)
              : "—"
          } · чек-инов ${data.summary.checkinCount || 0}`
        : "";
    if (out) {
      out.innerHTML =
        chip +
        `<div style="margin-top:8px;white-space:pre-wrap">${escapeHtml(
          data.text || ""
        )}${escapeHtml(statsLine)}</div>`;
    }
    // Also show as dedicated result screen
    showSupportResult({
      title: "Полный анализ чувств",
      meta: `Плюс · уровень: ${riskLabel}`,
      insight: data.text,
      autoHelp: null,
      needsSupport: risk === "hard",
    });
  } catch (e) {
    if (e.status === 403) {
      toast("Нужен тариф Плюс");
      go("premium");
    } else {
      toast(apiErrorMessage(e) || "Не удалось собрать анализ");
      if (out) out.textContent = "Не удалось загрузить анализ.";
    }
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateFeelingsAnalysisUi() {
  const isPlus = state.me?.premium && state.me?.plan === "plus";
  const homeBtn = $("#feelingsAnalysisBtn");
  if (homeBtn) {
    homeBtn.style.display = isPlus ? "" : "none";
  }
  const hint = $("#feelingsAnalysisHint");
  if (hint) {
    hint.textContent = isPlus
      ? "Разбор по фокусу, чек-инам, стрессу и дневнику. Не диагноз — ориентир."
      : "Полный разбор фокуса, чек-инов, стресса и дневника — в тарифе Плюс.";
  }
}

async function onStressSave() {
  if (!state.stressLevel) {
    toast("Выбери уровень");
    return;
  }
  try {
    const level = state.stressLevel;
    const res = await api("/stress", {
      method: "POST",
      body: {
        level,
        source: state.stressSource || undefined,
        note: $("#stressNote")?.value?.trim() || undefined,
      },
    });
    toast("Стресс записан");
    state.stressLevel = null;
    state.stressSource = null;
    if ($("#stressNote")) $("#stressNote").value = "";
    await loadMe();
    if (res.crisis || res.autoHelp || res.needsSupport) {
      showSupportResult({
        title: res.crisis ? "Важно · поддержка" : "Стресс записан",
        meta: `Уровень ${level}/5`,
        insight: null,
        autoHelp: res.autoHelp,
        needsSupport: res.needsSupport || res.crisis,
        crisis: !!res.crisis,
      });
    } else {
      go("home");
    }
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
  restoreJournalDraft();
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

function renderJournalList() {
  const list = $("#journalList");
  const empty = $("#journalEmpty");
  if (!list) return;
  const entries = state.journalEntries || [];
  if (!entries.length) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  list.innerHTML = entries
    .map((e) => {
      const preview = (e.text || "").replace(/</g, "&lt;").slice(0, 280);
      const prompt = (e.prompt || "Запись").replace(/</g, "&lt;");
      const edited = e.updatedAt ? "· изм." : "";
      const id = e.id || "";
      return `<button type="button" class="journal-item" data-journal-id="${id}">
          <span class="j-date">${formatJournalDate(e.at)}${edited}</span>
          <span class="j-prompt">${prompt}</span>
          <span class="j-text">${preview}</span>
        </button>`;
    })
    .join("");
}

async function loadJournalList() {
  const list = $("#journalList");
  const empty = $("#journalEmpty");
  if (list && !(state.journalEntries || []).length) {
    list.innerHTML = `<p class="muted">Загрузка…</p>`;
  }
  try {
    const data = await api("/journal");
    state.journalEntries = data.entries || [];
    renderJournalList();
  } catch (err) {
    console.error("journal list", err);
    // Keep optimistic / previous entries if we have them
    if ((state.journalEntries || []).length) {
      renderJournalList();
      toast("Список мог быть неполным — проверь сеть");
    } else {
      if (list) {
        list.innerHTML = `<p class="muted">${apiErrorMessage(err)}</p>`;
      }
      if (empty) empty.style.display = "none";
    }
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

function readJournalText(el) {
  if (!el) return "";
  // iOS / Telegram WebView: commit last keystroke before reading value
  try {
    el.blur();
  } catch (_) {}
  return String(el.value || "").trim();
}

function setJournalSaveBusy(busy) {
  const btn = $("#journalSave");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? "Сохраняю…" : "Сохранить";
}

function setJournalUpdateBusy(busy) {
  const btn = $("#journalUpdate");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? "Сохраняю…" : "Сохранить";
}

function journalDraftKey() {
  const uid = state.me?.user?.id || "anon";
  return `careofme_journal_draft_${uid}`;
}

function saveJournalDraft() {
  try {
    const text = $("#journalText")?.value || "";
    if (text.trim()) {
      localStorage.setItem(
        journalDraftKey(),
        JSON.stringify({ text, prompt: state.journalPrompt, at: Date.now() })
      );
    } else {
      localStorage.removeItem(journalDraftKey());
    }
  } catch (_) {}
}

function restoreJournalDraft() {
  try {
    const raw = localStorage.getItem(journalDraftKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d?.text && $("#journalText") && !$("#journalText").value) {
      $("#journalText").value = d.text;
    }
  } catch (_) {}
}

function clearJournalDraft() {
  try {
    localStorage.removeItem(journalDraftKey());
  } catch (_) {}
}

async function onJournalSave() {
  if (state._journalSaving) return;
  const ta = $("#journalText");
  const text = readJournalText(ta);
  if (!text) {
    toast("Напиши хотя бы пару слов");
    return;
  }
  if (!getInitData()) {
    toast("Открой приложение из бота @careofme_bot");
    return;
  }

  state._journalSaving = true;
  setJournalSaveBusy(true);
  try {
    const res = await api("/journal", {
      method: "POST",
      body: {
        text,
        prompt: state.journalPrompt || "Свободная запись",
      },
    });
    if (ta) ta.value = "";
    clearJournalDraft();
    // Optimistic: show entry even if list reload is slow
    if (res?.entry) {
      state.journalEntries = [
        res.entry,
        ...(state.journalEntries || []).filter((e) => e.id !== res.entry.id),
      ];
    }
    toast("Сохранено ");
    if (tg?.HapticFeedback) {
      try {
        tg.HapticFeedback.notificationOccurred("success");
      } catch (_) {}
    }
    await loadJournalPrompt();
    if (res.crisis || res.autoHelp) {
      showSupportResult({
        title: "Важно · поддержка",
        meta: "Запись сохранена · живая помощь важнее бота",
        insight: null,
        autoHelp: res.autoHelp,
        needsSupport: true,
        crisis: !!res.crisis,
      });
      return;
    }
    setJournalTab("list");
    // Render immediately from optimistic state, then refresh from server
    renderJournalList();
  } catch (err) {
    console.error("journal save", err);
    saveJournalDraft();
    toast(apiErrorMessage(err));
    if (tg?.HapticFeedback) {
      try {
        tg.HapticFeedback.notificationOccurred("error");
      } catch (_) {}
    }
  } finally {
    state._journalSaving = false;
    setJournalSaveBusy(false);
  }
}

async function onJournalUpdate() {
  const id = state.editingJournalId;
  if (!id || state._journalSaving) return;
  const ta = $("#journalEditText");
  const text = readJournalText(ta);
  if (!text) {
    toast("Текст не может быть пустым");
    return;
  }
  state._journalSaving = true;
  setJournalUpdateBusy(true);
  try {
    const res = await api(`/journal/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { text },
    });
    if (res?.entry) {
      state.journalEntries = (state.journalEntries || []).map((e) =>
        e.id === id ? res.entry : e
      );
    }
    toast("Изменения сохранены");
    state.editingJournalId = null;
    setJournalTab("list");
  } catch (err) {
    console.error("journal update", err);
    toast(apiErrorMessage(err));
  } finally {
    state._journalSaving = false;
    setJournalUpdateBusy(false);
  }
}

async function onJournalDelete() {
  const id = state.editingJournalId;
  if (!id) return;
  if (!confirm("Удалить эту запись?")) return;
  try {
    await api(`/journal/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.journalEntries = (state.journalEntries || []).filter((e) => e.id !== id);
    toast("Удалено");
    state.editingJournalId = null;
    setJournalTab("list");
  } catch (err) {
    toast(apiErrorMessage(err) || "Не удалось удалить");
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
    if (res.crisis) {
      toast("8-800-2000-122 · если опасно — 112");
      if (res.suggestedPracticeId) {
        state.lastAutoHelp = {
          practiceId: res.suggestedPracticeId,
          text: res.reply,
          urgent: true,
        };
      }
    }
  } catch (e) {
    if (pending) pending.remove();
    if (e.status === 429) {
      appendBubble(
        "Лимит на сегодня. Завтра обновится — или подписка (крипта через Crypto Bot).\n\n" +
          "Если совсем тяжело: 8-800-2000-122 или 112.",
        "bot"
      );
      toast("Лимит коуча");
    } else if (e.status === 401) {
      appendBubble(apiErrorMessage(e), "bot");
      showAuthBanner(apiErrorMessage(e));
    } else {
      appendBubble(
        "Сейчас не удалось ответить. Попробуй ещё раз через минуту.\n\n" +
          "Если очень тяжело: 8-800-2000-122 или 112.",
        "bot"
      );
      console.error("coach", e);
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
          return `<div class="hist-row"><span>${d}</span><span>${c.mood} ${c.energy} ${c.stress}</span></div>`;
        })
        .join("");
    }
    updateFeelingsAnalysisUi();
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

function showPayModal(plan, payUrl, invoiceId, meta = {}) {
  state.lastInvoiceId = invoiceId;
  state.lastPayUrl = payUrl;
  const planTitle = plan === "plus" ? "Плюс" : "Забота";
  const rub = meta.amountRub != null ? `${meta.amountRub} ₽` : "";
  const period = meta.periodLabel || meta.period || "";
  const usdt = meta.amountUsdt ? `≈ ${meta.amountUsdt} USDT` : "";
  const macHint = isMacDesktop() || isDesktopClient()
    ? "На Mac: обязательно нажми «Открыть Crypto Bot»."
    : "";
  $("#payModalText").textContent =
    `«${planTitle}»${period ? ` · ${period}` : ""}${rub ? ` · ${rub}` : ""}${usdt ? ` · ${usdt}` : ""} (курс 81 ₽). ` +
    `Оплати в Crypto Bot, вернись и нажми «Проверить оплату».${macHint}`;
  const openBtn = document.getElementById("payModalOpen");
  if (openBtn) {
    openBtn.textContent = "Открыть Crypto Bot";
    openBtn.setAttribute("href", payUrl || "#");
  }
  $("#payModal").classList.remove("hidden");
  const st = $("#payStatus");
  if (st) st.textContent = `Счёт #${invoiceId} создан`;
  setTimeout(() => {
    document.getElementById("payModalOpen")?.focus?.();
  }, 50);
}

function hidePayModal() {
  $("#payModal")?.classList.add("hidden");
}

const FALLBACK_PERIODS = {
  care: [
    { id: "7d", label: "7 дней", priceRub: 89 },
    { id: "30d", label: "30 дней", priceRub: 199 },
    { id: "90d", label: "3 месяца", priceRub: 499 },
    { id: "180d", label: "6 месяцев", priceRub: 899 },
  ],
  plus: [
    { id: "7d", label: "7 дней", priceRub: 119 },
    { id: "30d", label: "30 дней", priceRub: 349 },
    { id: "90d", label: "3 месяца", priceRub: 849 },
    { id: "180d", label: "6 месяцев", priceRub: 1549 },
  ],
};

function openPeriodPicker(plan) {
  if (plan !== "care" && plan !== "plus") return;
  state.pendingPayPlan = plan;
  const title = plan === "plus" ? "Плюс" : "Забота";
  if ($("#periodModalTitle")) {
    $("#periodModalTitle").textContent = `Срок · ${title}`;
  }
  if ($("#periodModalHint")) {
    $("#periodModalHint").textContent =
      "Выбери период — цена и доступ зависят от срока";
  }
  const catalog = state.me?.planCatalog?.find((p) => p.id === plan);
  const periods = catalog?.periods || FALLBACK_PERIODS[plan] || [];
  const box = $("#periodOptions");
  if (box) {
    box.innerHTML = periods
      .map((p) => {
        const usdt = p.priceUsdt ? ` · ≈ ${p.priceUsdt} USDT` : "";
        return `<button type="button" class="period-opt" data-plan-period="${p.id}" data-pay-for="${plan}">
          <span>${p.label}<span class="po-sub">${p.days || ""} дн.${usdt}</span></span>
          <span class="po-price">${p.priceRub} ₽</span>
        </button>`;
      })
      .join("");
  }
  $("#periodModal")?.classList.remove("hidden");
}

function hidePeriodModal() {
  $("#periodModal")?.classList.add("hidden");
}

async function startTrial(plan) {
  if (plan !== "care" && plan !== "plus") return;
  if (state._trialing) return;
  state._trialing = true;
  try {
    const res = await api("/plan/trial", { method: "POST", body: { plan } });
    const until = res.premiumUntil
      ? new Date(res.premiumUntil).toLocaleDateString("ru-RU")
      : "";
    toast(
      res.message ||
        `Пробный период на ${res.trialDays || 3} дня${until ? ` · до ${until}` : ""}`
    );
    if (tg?.HapticFeedback) {
      try {
        tg.HapticFeedback.notificationOccurred("success");
      } catch (_) {}
    }
    await loadMe();
    renderPlans();
    go("home");
  } catch (e) {
    console.error("trial", e);
    toast(e.data?.message || apiErrorMessage(e) || "Не удалось активировать пробный период");
    if (e.data?.error === "already_premium") {
      await loadMe();
      renderPlans();
    }
  } finally {
    state._trialing = false;
  }
}

async function startCryptoPay(plan, period) {
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

  if (!period) {
    openPeriodPicker(plan);
    return;
  }

  if (!state.me?.cryptoPayConfigured) {
    toast("Оплата временно недоступна");
    return;
  }

  state._paying = true;
  toast("Создаю счёт…");
  try {
    const res = await api("/plan", {
      method: "POST",
      body: { plan, period },
    });
    if (res.payment === "already_active") {
      toast("Подписка уже активна");
      await loadMe();
      renderPlans();
      return;
    }
    if (res.payment === "crypto" && res.payUrl) {
      showPayModal(plan, res.payUrl, res.invoiceId, {
        amountRub: res.amountRub,
        amountUsdt: res.amountUsdt,
        period: res.period,
        periodLabel: res.periodLabel,
        days: res.days,
      });
      startPayPolling(res.invoiceId, true);
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
      toast("Оплата прошла ");
      hidePayModal();
      hidePeriodModal();
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
      state.me.plans?.[state.me.plan]?.title || state.me.plan || "Plus";
    const trialNote = state.me.isTrial ? "· пробный период" : "";
    banner.innerHTML = `
      <div class="pay-banner-title">${state.me.isTrial ? "🎁 Пробный период" : "✅ Подписка активна"}</div>
      <p class="muted">Тариф «${title}»${trialNote}${until ? ` до ${until}` : ""}</p>
      <button class="linkish" data-go="premium" type="button">Управление →</button>`;
    if (chip) chip.textContent = state.me.isTrial ? "✨ Plus · пробный" : "✨ Plus";
    return;
  }

  const te = state.me?.trialEligible || {};
  const trialRow =
    te.care || te.plus
      ? `<div class="pay-row" style="margin-bottom:8px">
          ${
            te.care
              ? `<button class="btn ghost" type="button" data-trial-plan="care"> Забота · 3 дня</button>`
              : ""
          }
          ${
            te.plus
              ? `<button class="btn ghost" type="button" data-trial-plan="plus"> Плюс · 3 дня</button>`
              : ""
          }
        </div>
        <p class="muted" style="margin:0 0 10px;font-size:0.82rem">Пробный период — 1 раз на каждый тариф, без карты и крипты.</p>`
      : "";

  // Restore pay UI for free users
  banner.innerHTML = `
    <div class="pay-banner-title"> ✨ Подписка · 3 дня бесплатно</div>
    <p class="muted" id="payBannerText">
      Попробуй «Забота» или «Плюс» без оплаты, затем USDT через Crypto Bot.
    </p>
    ${trialRow}
    <div class="pay-row">
      <button class="btn primary" type="button" data-pay-plan="care">
        Забота · от 89 ₽
      </button>
      <button class="btn primary" type="button" data-pay-plan="plus">
        Плюс · от 119 ₽
      </button>
    </div>
    <button class="linkish" data-go="premium" type="button">Все тарифы и детали →</button>`;
  if (chip) chip.textContent = "✨ Plus";
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

  const te = state.me?.trialEligible || {};
  const isTrial = !!state.me?.isTrial;

  // Always rebuild plan cards from live flags — never show legacy "demo" labels
  $("#plans").innerHTML =
    `<p class="muted" style="margin-bottom:10px">${
      premium
        ? isTrial
          ? "Сейчас пробный период. После окончания можно оплатить или остаться на free."
          : "Твоя подписка активна. Ниже — что входит в тарифы."
        : "Можно взять 3 дня бесплатно (1 раз на тариф), затем оплата USDT через Crypto Bot (курс 81 ₽)."
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
          btn = `<button class="btn ghost block" type="button" disabled>${
            isTrial ? "Пробный · активен" : "Активен"
          }</button>`;
        } else if (premium && current !== p.id) {
          btn = `<button class="btn primary block" type="button" data-pay-plan="${p.id}"> Перейти · ${p.price}</button>`;
        } else {
          const canTrial = p.id === "care" || p.id === "plus" ? te[p.id] : false;
          const trialBtn = canTrial
            ? `<button class="btn primary block" type="button" data-trial-plan="${p.id}" style="margin-bottom:8px"> 3 дня бесплатно</button>`
            : state.me?.trialUsed?.[p.id]
              ? `<p class="muted" style="margin:0 0 8px;font-size:0.82rem">Пробный период уже использован</p>`
              : "";
          const payBtn = cryptoOk
            ? `<button class="btn ${canTrial ? "ghost": "primary"} block" type="button" data-pay-plan="${p.id}"> Выбрать срок и оплатить</button>`
            : `<button class="btn ghost block" type="button" disabled>Оплата недоступна</button>`;
          btn = trialBtn + payBtn;
        }
        const hint =
          p.priceHint
            ? `<p class="muted" style="font-size:0.8rem;margin:0 0 10px">${p.priceHint}</p>`
            : "";
        return `
      <div class="plan">
        <h3>${p.title}${active && p.id !== "free" && premium ? (isTrial ? "· пробный" : "· сейчас") : ""}</h3>
        <div class="price">${p.price}</div>
        ${hint}
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

  on("onboardingDone", "click", async (ev) => {
    ev.preventDefault();
    await finishFeelingsSelection({ analyze: true });
  });
  on("onboardingSkipHome", "click", async (ev) => {
    ev.preventDefault();
    await finishFeelingsSelection({ analyze: false, goHome: true });
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
  on("therapyDone", "click", () => onTherapyDone());
  on("stressSave", "click", () => onStressSave());
  on("journalRefresh", "click", (ev) => {
    ev.preventDefault();
    loadJournalPrompt();
  });
  on("journalSave", "click", (ev) => {
    ev.preventDefault();
    onJournalSave();
  });
  on("journalEditBack", "click", (ev) => {
    ev.preventDefault();
    state.editingJournalId = null;
    setJournalTab("list");
  });
  on("journalUpdate", "click", (ev) => {
    ev.preventDefault();
    onJournalUpdate();
  });
  on("journalDelete", "click", (ev) => {
    ev.preventDefault();
    onJournalDelete();
  });

  // Form submit works better than bare button on mobile keyboards
  const journalForm = $("#journalForm");
  if (journalForm) {
    journalForm.addEventListener("submit", (e) => {
      e.preventDefault();
      onJournalSave();
    });
  }
  const journalEditForm = $("#journalEditForm");
  if (journalEditForm) {
    journalEditForm.addEventListener("submit", (e) => {
      e.preventDefault();
      onJournalUpdate();
    });
  }

  // Autosave draft while typing (phone kills WebView often)
  const journalText = $("#journalText");
  if (journalText) {
    let draftT;
    journalText.addEventListener("input", () => {
      clearTimeout(draftT);
      draftT = setTimeout(saveJournalDraft, 400);
    });
  }
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
  on("periodModalClose", "click", hidePeriodModal);

  // Also bind feelings button directly (belt + suspenders for macOS)
  on("editFeelingsBtn", "click", (ev) => {
    ev.preventDefault();
    openFeelingsEditor();
  });

  on("feelingsAnalysisBtn", "click", (ev) => {
    ev.preventDefault();
    runFeelingsAnalysis();
  });
  on("feelingsAnalysisBtn2", "click", (ev) => {
    ev.preventDefault();
    runFeelingsAnalysis();
  });
  on("supportPracticeBtn", "click", (ev) => {
    ev.preventDefault();
    const id =
      $("#supportPracticeBtn")?.dataset?.practiceId ||
      state.lastAutoHelp?.practiceId;
    if (id) openPractice(id, false);
    else onRecommendPractice();
  });
  on("supportCoachBtn", "click", (ev) => {
    ev.preventDefault();
    go("coach");
    if (state.lastAutoHelp?.text) {
      // Seed chat with last auto-help so user can continue
      const chat = $("#chat");
      if (chat && !chat.dataset.seededHelp) {
        appendBubble(state.lastAutoHelp.text, "bot");
        chat.dataset.seededHelp = "1";
      }
    }
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

// Wait a tick for Telegram to inject initData on slow phones
function boot() {
  const hasTg = Boolean(window.Telegram?.WebApp);
  const hasInit = Boolean(getInitData());
  if (!hasTg || !hasInit) {
    console.info("Telegram WebApp initData missing", { hasTg, hasInit });
  }
  loadMe().catch((e) => console.error("loadMe", e));
}

if (tg) {
  try {
    tg.ready();
  } catch (_) {}
  // Some clients populate initData slightly after ready()
  setTimeout(boot, 50);
} else {
  boot();
}

const retryAuthBtn = document.getElementById("authRetryBtn");
if (retryAuthBtn) {
  retryAuthBtn.addEventListener("click", async () => {
    storeSession("", 0);
    sessionReady = null;
    toast("Пробуем снова…");
    await loadMe();
  });
}
