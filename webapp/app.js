/* global Telegram */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("secondary_bg_color");
    tg.setBackgroundColor("bg_color");
  } catch (_) {
    /* older clients */
  }
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
  if (screen === "journal") loadJournalPrompt();
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

function bindNav() {
  document.body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-go]");
    if (t) {
      e.preventDefault();
      go(t.dataset.go);
    }
    const coach = e.target.closest("[data-coach]");
    if (coach) {
      e.preventDefault();
      go("coach");
      sendCoach(coach.dataset.coach);
    }
  });
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
function renderOnboarding() {
  const labels = state.me?.focusLabels || {
    burnout: "🔥 Выгорание",
    anxiety: "🌊 Тревога",
    insomnia: "🌙 Бессонница",
    general: "🌿 Общее",
  };
  const box = $("#focusChips");
  box.innerHTML = "";
  for (const [id, label] of Object.entries(labels)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.classList.toggle("on", state.focusDraft.includes(id));
    b.onclick = () => {
      const i = state.focusDraft.indexOf(id);
      if (i >= 0) {
        if (state.focusDraft.length > 1) state.focusDraft.splice(i, 1);
      } else state.focusDraft.push(id);
      renderOnboarding();
    };
    box.appendChild(b);
  }
}

$("#onboardingDone").onclick = async () => {
  try {
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
};

/* —— Check-in —— */
function resetCheckinUI() {
  state.checkin = { step: 0, mood: null, energy: null, stress: null, sleep: null, note: "" };
  renderCheckinStep();
}

function renderCheckinStep() {
  const s = state.checkin.step;
  const meta = CHECKIN_STEPS[s];
  $("#checkinTitle").textContent = meta.title;
  $("#checkinHint").textContent = meta.hint;

  const dots = $("#checkinDots");
  dots.innerHTML = CHECKIN_STEPS.map((_, i) => `<span class="${i <= s ? "on" : ""}"></span>`).join(
    ""
  );

  const scoreRow = $("#scoreRow");
  const note = $("#checkinNote");
  const next = $("#checkinNext");
  const back = $("#checkinBack");

  if (meta.key === "note") {
    scoreRow.classList.add("hidden");
    note.classList.remove("hidden");
    note.value = state.checkin.note || "";
    next.textContent = "Сохранить";
  } else {
    scoreRow.classList.remove("hidden");
    note.classList.add("hidden");
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
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
      };
      scoreRow.appendChild(b);
    }
  }

  back.style.visibility = s === 0 ? "hidden" : "visible";
}

$("#checkinBack").onclick = () => {
  if (state.checkin.step > 0) {
    state.checkin.step -= 1;
    renderCheckinStep();
  }
};

$("#checkinNext").onclick = async () => {
  const s = state.checkin.step;
  const key = CHECKIN_STEPS[s].key;

  if (key === "note") {
    state.checkin.note = $("#checkinNote").value.trim();
  } else if (key !== "sleep" && !state.checkin[key]) {
    toast("Выбери оценку");
    return;
  }

  if (s < CHECKIN_STEPS.length - 1) {
    // sleep can be skipped
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
};

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

$("#recommendPractice").onclick = async () => {
  try {
    const { practice } = await api("/practices-recommend");
    openPractice(practice.id, false);
  } catch {
    toast("Нет рекомендации");
  }
};

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

$("#practiceDone").onclick = async () => {
  if (!state.currentPracticeId) return;
  try {
    await api(`/practices/${state.currentPracticeId}/done`, { method: "POST", body: {} });
    toast("Засчитано 🌿");
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    go("practices");
  } catch {
    toast("Ошибка");
  }
};

/* —— Stress —— */
function renderStressUI() {
  const row = $("#stressScore");
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

$("#stressSave").onclick = async () => {
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
        note: $("#stressNote").value.trim() || undefined,
      },
    });
    toast("Стресс записан");
    state.stressLevel = null;
    state.stressSource = null;
    $("#stressNote").value = "";
    await loadMe();
    go("home");
  } catch {
    toast("Ошибка");
  }
};

/* —— Journal —— */
async function loadJournalPrompt() {
  try {
    const { prompt } = await api("/journal/prompt");
    state.journalPrompt = prompt;
    $("#journalPrompt").textContent = prompt;
  } catch {
    $("#journalPrompt").textContent = "Что сейчас сильнее всего влияет на твоё состояние?";
  }
}

$("#journalRefresh").onclick = () => loadJournalPrompt();

$("#journalSave").onclick = async () => {
  const text = $("#journalText").value.trim();
  if (!text) {
    toast("Напиши хотя бы пару слов");
    return;
  }
  try {
    await api("/journal", {
      method: "POST",
      body: { text, prompt: state.journalPrompt },
    });
    $("#journalText").value = "";
    toast("В дневнике 📝");
    go("home");
  } catch {
    toast("Ошибка");
  }
};

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

$("#coachForm").onsubmit = (e) => {
  e.preventDefault();
  sendCoach($("#coachInput").value);
};

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

function openPayUrl(url) {
  if (!url) return;
  // Crypto Bot deep links must use openTelegramLink
  try {
    if (url.includes("t.me/") && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      return;
    }
    if (tg?.openLink) {
      tg.openLink(url, { try_instant_view: false });
      return;
    }
  } catch (e) {
    console.warn(e);
  }
  window.open(url, "_blank");
}

function showPayModal(plan, payUrl, invoiceId) {
  state.lastInvoiceId = invoiceId;
  state.lastPayUrl = payUrl;
  const title = plan === "plus" ? "Плюс · 349 ₽" : "Забота · 199 ₽";
  $("#payModalText").textContent =
    `Тариф «${title}». Нажми «Открыть Crypto Bot», оплати USDT/TON/BTC… и вернись — «Проверить оплату».`;
  $("#payModal").classList.remove("hidden");
  const st = $("#payStatus");
  if (st) st.textContent = `Счёт #${invoiceId} создан`;
}

function hidePayModal() {
  $("#payModal")?.classList.add("hidden");
}

async function startCryptoPay(plan) {
  if (plan === "free") {
    try {
      await api("/plan", { method: "POST", body: { plan: "free" } });
      toast("Бесплатный тариф");
      await loadMe();
      renderPlans();
      updatePayBanner();
    } catch {
      toast("Ошибка");
    }
    return;
  }

  toast("Создаю счёт…");
  try {
    const res = await api("/plan", { method: "POST", body: { plan } });
    if (res.payment === "crypto" && res.payUrl) {
      showPayModal(plan, res.payUrl, res.invoiceId);
      openPayUrl(res.payUrl);
      startPayPolling(res.invoiceId);
      return;
    }
    if (res.payment === "demo" || res.premium) {
      toast("Тариф активен ✨");
      await loadMe();
      renderPlans();
      updatePayBanner();
      return;
    }
    toast("Не удалось создать оплату");
  } catch (e) {
    console.error(e);
    if (e.data?.error === "payments_not_configured") {
      toast("Крипто-оплата не настроена на сервере");
    } else if (e.data?.error === "invoice_failed") {
      toast("Crypto Bot не создал счёт. Попробуй позже");
    } else {
      toast("Ошибка оплаты");
    }
  }
}

function startPayPolling(invoiceId) {
  let n = 0;
  if (state._payTimer) clearInterval(state._payTimer);
  state._payTimer = setInterval(async () => {
    n++;
    const ok = await verifyPayment(invoiceId);
    if (ok || n > 30) {
      clearInterval(state._payTimer);
      state._payTimer = null;
    }
  }, 4000);
}

async function verifyPayment(invoiceId) {
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
      updatePayBanner();
      return true;
    }
    toast("Пока не видно оплату — подожди и нажми снова");
    return false;
  } catch {
    toast("Не удалось проверить");
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
    banner.innerHTML = `
      <div class="pay-banner-title">✅ Подписка активна</div>
      <p class="muted">Тариф «${state.me.plans?.[state.me.plan]?.title || state.me.plan}»${
        until ? ` до ${until}` : ""
      }</p>
      <button class="linkish" data-go="premium" type="button">Управление →</button>`;
    if (chip) chip.textContent = "✅ Pro";
  } else if (state.me && state.me.cryptoPayConfigured === false) {
    $("#payBannerText").textContent =
      "Крипто-оплата на сервере выключена. Напиши в поддержку.";
  }
}

function renderPlans() {
  const plans = state.me?.plans;
  if (!plans) {
    $("#plans").innerHTML = `<p class="muted">Загрузка…</p>`;
    return;
  }
  const current = state.me.plan || "free";
  const cryptoOk = !!state.me.cryptoPayConfigured;
  const info = $("#cryptoInfo");
  if (info) {
    info.style.display = state.me.premium ? "none" : "block";
  }

  $("#plans").innerHTML =
    `<p class="muted" style="margin-bottom:10px">${
      cryptoOk
        ? "Ниже — детали тарифов. Кнопки оплаты криптой — сверху 👆"
        : "⚠️ CRYPTO_PAY не активен на сервере"
    }</p>` +
    Object.values(plans)
      .map((p) => {
        const active =
          current === p.id && (p.id === "free" || state.me.premium);
        return `
      <div class="plan">
        <h3>${p.title}${active ? " · сейчас" : ""}</h3>
        <div class="price">${p.price}</div>
        <ul>${p.perks.map((x) => `<li>${x}</li>`).join("")}</ul>
        ${
          p.id === "free"
            ? `<button class="btn ghost block" data-plan="free" type="button">${
                active ? "Активен" : "Остаться на free"
              }</button>`
            : active
              ? `<button class="btn ghost block" type="button" disabled>Активен</button>`
              : `<button class="btn primary block" data-pay-plan="${p.id}" type="button">💎 Оплатить криптой · ${p.price}</button>`
        }
      </div>`;
      })
      .join("");

  bindPayButtons(document);
}

function bindPayButtons(root = document) {
  root.querySelectorAll("[data-pay-plan]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      startCryptoPay(btn.getAttribute("data-pay-plan"));
    };
  });
  root.querySelectorAll("[data-plan]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      startCryptoPay(btn.getAttribute("data-plan"));
    };
  });
}

/* —— boot —— */
bindNav();
bindPayButtons(document);

$("#checkPayBtn")?.addEventListener("click", () => verifyPayment());
$("#payModalOpen")?.addEventListener("click", () => openPayUrl(state.lastPayUrl));
$("#payModalCheck")?.addEventListener("click", () => verifyPayment());
$("#payModalClose")?.addEventListener("click", hidePayModal);

loadMe();

// Dev preview without Telegram
if (!tg?.initData) {
  console.info("Preview mode: open via Telegram bot for full auth");
}
