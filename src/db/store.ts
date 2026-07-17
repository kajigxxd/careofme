import fs from "fs";
import path from "path";

export type MoodScore = 1 | 2 | 3 | 4 | 5;

/** What the person feels / needs support with right now */
export type FocusArea =
  | "burnout"
  | "anxiety"
  | "insomnia"
  | "loneliness"
  | "sadness"
  | "overwhelm"
  | "anger"
  | "emptiness"
  | "guilt"
  | "fear"
  | "relationships"
  | "self_doubt"
  | "apathy"
  | "general";

export const ALL_FOCUS_AREAS: FocusArea[] = [
  "burnout",
  "anxiety",
  "insomnia",
  "loneliness",
  "sadness",
  "overwhelm",
  "anger",
  "emptiness",
  "guilt",
  "fear",
  "relationships",
  "self_doubt",
  "apathy",
  "general",
];

export interface MoodCheckin {
  id: string;
  at: string; // ISO
  mood: MoodScore;
  energy: MoodScore;
  stress: MoodScore;
  sleep?: MoodScore;
  note?: string;
  tags?: string[];
}

export interface JournalEntry {
  id: string;
  at: string;
  prompt: string;
  text: string;
  updatedAt?: string;
}

export interface PracticeLog {
  id: string;
  at: string;
  practiceId: string;
  title: string;
  durationSec: number;
}

export interface StressPoint {
  id: string;
  at: string;
  level: MoodScore;
  source?: string;
  note?: string;
}

export interface UserProfile {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  createdAt: string;
  focusAreas: FocusArea[];
  timezoneOffsetMin: number;
  onboardingDone: boolean;
  premiumUntil?: string; // ISO
  plan?: "free" | "care" | "plus";
  /** Active access came from free trial (not paid invoice) */
  isTrial?: boolean;
  /** One free trial per paid plan type */
  trialUsed?: { care?: boolean; plus?: boolean };
  /** Last activity (bot or Mini App API) */
  lastSeenAt?: string;
  reminderHour?: number; // 0-23 local-ish
  lastCheckinDate?: string; // YYYY-MM-DD
  streak: number;
  checkins: MoodCheckin[];
  journal: JournalEntry[];
  practices: PracticeLog[];
  stress: StressPoint[];
  coachMessages: { role: "user" | "assistant"; content: string; at: string }[];
  /** Unlocked achievement ids with timestamps */
  achievements?: { id: string; at: string }[];
  freeCoachToday: number;
  freeCoachDate?: string;
  /** Last crypto invoice ids for this user */
  pendingInvoices?: {
    invoiceId: number;
    plan: "care" | "plus";
    at: string;
    days?: number;
  }[];
  paymentHistory?: {
    invoiceId: number;
    plan: "care" | "plus";
    paidAt: string;
    amount?: string;
    asset?: string;
  }[];
  /** Unique invite code for this user (e.g. a3k9xm) */
  referralCode?: string;
  /** Who invited this user (set once) */
  referredBy?: number;
  referredAt?: string;
  /** Accumulated referral commission in USDT */
  referralBalanceUsdt?: number;
  /** Lifetime earned commission in USDT */
  referralEarnedUsdt?: number;
  referralEarnings?: ReferralEarning[];
}

export interface ReferralEarning {
  id: string;
  fromUserId: number;
  invoiceId: number;
  /** Commission credited (USDT) */
  amountUsdt: number;
  /** Original payment amount (USDT) */
  paymentUsdt: number;
  plan: "care" | "plus";
  at: string;
}

/** Share of each paid subscription that goes to the referrer */
export const REFERRAL_COMMISSION_RATE = 0.15;

interface StoreData {
  users: Record<string, UserProfile>;
  /** referralCode (lowercase) → userId */
  referralIndex?: Record<string, number>;
}

function defaultDataPath(): string {
  if (process.env.DATA_PATH) return process.env.DATA_PATH;
  // Prefer persistent volume on Railway (/data), then /tmp
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    return "/data/careofme-store.json";
  }
  if (
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.NODE_ENV === "production"
  ) {
    return "/tmp/careofme-store.json";
  }
  return path.join(process.cwd(), "data", "store.json");
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class Store {
  private filePath: string;
  private data: StoreData = { users: {} };

  constructor(filePath = defaultDataPath()) {
    this.filePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw) as StoreData;
        if (!this.data.users) this.data.users = {};
        if (!this.data.referralIndex) this.data.referralIndex = {};
        this.rebuildReferralIndex();
      } else {
        this.data = { users: {}, referralIndex: {} };
        this.persist();
      }
    } catch {
      this.data = { users: {}, referralIndex: {} };
      this.persist();
    }
  }

  private rebuildReferralIndex() {
    const idx: Record<string, number> = { ...(this.data.referralIndex || {}) };
    for (const u of Object.values(this.data.users)) {
      if (u.referralCode) {
        idx[u.referralCode.toLowerCase()] = u.userId;
      }
    }
    this.data.referralIndex = idx;
  }

  private persist() {
    ensureDir(this.filePath);
    const payload = JSON.stringify(this.data, null, 2);
    // Atomic write — avoids truncated store.json if process restarts mid-write
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      // Fallback: direct write (some FS without rename support)
      fs.writeFileSync(this.filePath, payload, "utf-8");
      console.error("store.persist atomic failed, used direct write:", err);
    }
  }

  /** Ensure every journal row has a stable id (legacy data). */
  private ensureJournalIds(user: UserProfile): void {
    let dirty = false;
    for (const j of user.journal) {
      if (!j?.id) {
        j.id = `j_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        dirty = true;
      }
      if (typeof j.text !== "string") j.text = String(j.text ?? "");
      if (typeof j.prompt !== "string") j.prompt = String(j.prompt ?? "Запись");
      if (!j.at) j.at = new Date().toISOString();
    }
    if (dirty) this.persist();
  }

  getUser(userId: number): UserProfile | undefined {
    return this.data.users[String(userId)];
  }

  getOrCreateUser(params: {
    userId: number;
    chatId: number;
    username?: string;
    firstName?: string;
  }): UserProfile {
    const key = String(params.userId);
    let user = this.data.users[key];
    const now = new Date().toISOString();
    if (!user) {
      user = {
        userId: params.userId,
        chatId: params.chatId,
        username: params.username,
        firstName: params.firstName,
        createdAt: now,
        lastSeenAt: now,
        focusAreas: ["general"],
        timezoneOffsetMin: 180, // MSK default
        onboardingDone: false,
        plan: "free",
        streak: 0,
        checkins: [],
        journal: [],
        practices: [],
        stress: [],
        coachMessages: [],
        achievements: [],
        freeCoachToday: 0,
        pendingInvoices: [],
        paymentHistory: [],
        referralBalanceUsdt: 0,
        referralEarnedUsdt: 0,
        referralEarnings: [],
      };
      this.data.users[key] = user;
      this.ensureReferralCode(params.userId);
      this.persist();
    } else {
      let dirty = false;
      if (user.chatId !== params.chatId) {
        user.chatId = params.chatId;
        dirty = true;
      }
      if (params.username && user.username !== params.username) {
        user.username = params.username;
        dirty = true;
      }
      if (params.firstName && user.firstName !== params.firstName) {
        user.firstName = params.firstName;
        dirty = true;
      }
      if (!user.referralCode) {
        this.ensureReferralCode(params.userId);
        dirty = false; // ensureReferralCode already persisted
      }
      // Throttle disk writes: lastSeen at most every 5 minutes
      const prev = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
      if (Date.now() - prev > 5 * 60_000) {
        user.lastSeenAt = now;
        dirty = true;
      }
      if (dirty) this.persist();
    }
    return user;
  }

  private lastActivityIso(user: UserProfile): string {
    const times: number[] = [];
    if (user.lastSeenAt) times.push(new Date(user.lastSeenAt).getTime());
    if (user.createdAt) times.push(new Date(user.createdAt).getTime());
    if (user.checkins[0]?.at) times.push(new Date(user.checkins[0].at).getTime());
    if (user.journal[0]?.at) times.push(new Date(user.journal[0].at).getTime());
    if (user.stress[0]?.at) times.push(new Date(user.stress[0].at).getTime());
    if (user.practices[0]?.at) times.push(new Date(user.practices[0].at).getTime());
    const coach = user.coachMessages[user.coachMessages.length - 1];
    if (coach?.at) times.push(new Date(coach.at).getTime());
    const max = times.length ? Math.max(...times.filter((n) => Number.isFinite(n))) : 0;
    return max ? new Date(max).toISOString() : user.createdAt;
  }

  /** Aggregated product metrics for the admin */
  appUsageStats() {
    const users = Object.values(this.data.users);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    let premium = 0;
    let trial = 0;
    let care = 0;
    let plus = 0;
    let free = 0;
    let onboardingDone = 0;
    let withCheckin = 0;
    let active1d = 0;
    let active7d = 0;
    let active30d = 0;
    let new7d = 0;
    let new30d = 0;
    let totalCheckins = 0;
    let totalJournal = 0;
    let totalCoach = 0;

    for (const u of users) {
      const isPrem = this.isPremium(u);
      if (isPrem) {
        premium += 1;
        if (u.isTrial) trial += 1;
        if (u.plan === "plus") plus += 1;
        else if (u.plan === "care") care += 1;
      } else {
        free += 1;
      }
      if (u.onboardingDone) onboardingDone += 1;
      if (u.checkins.length) withCheckin += 1;
      totalCheckins += u.checkins.length;
      totalJournal += u.journal.length;
      totalCoach += u.coachMessages.filter((m) => m.role === "user").length;

      const last = new Date(this.lastActivityIso(u)).getTime();
      if (now - last <= day) active1d += 1;
      if (now - last <= 7 * day) active7d += 1;
      if (now - last <= 30 * day) active30d += 1;

      const created = new Date(u.createdAt).getTime();
      if (now - created <= 7 * day) new7d += 1;
      if (now - created <= 30 * day) new30d += 1;
    }

    return {
      totalUsers: users.length,
      free,
      premium,
      trial,
      care,
      plus,
      onboardingDone,
      withCheckin,
      active1d,
      active7d,
      active30d,
      new7d,
      new30d,
      totalCheckins,
      totalJournal,
      totalCoachUserMsgs: totalCoach,
      generatedAt: new Date().toISOString(),
    };
  }

  updateUser(userId: number, patch: Partial<UserProfile>): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error(`User ${userId} not found`);
    Object.assign(user, patch);
    this.persist();
    return user;
  }

  isPremium(user: UserProfile): boolean {
    if (user.plan !== "care" && user.plan !== "plus") return false;
    if (!user.premiumUntil) return false;
    const active = new Date(user.premiumUntil) > new Date();
    if (!active && user.isTrial) {
      // Trial expired — clear flag lazily
      user.isTrial = false;
      if (user.plan === "care" || user.plan === "plus") {
        // keep plan label history but treat as free access
      }
      this.persist();
    }
    return active;
  }

  /** Free trial length in days (care & plus). */
  static readonly TRIAL_DAYS = 3;

  canStartTrial(
    user: UserProfile,
    plan: "care" | "plus"
  ): { ok: true } | { ok: false; reason: string; message: string } {
    if (this.isPremium(user)) {
      return {
        ok: false,
        reason: "already_premium",
        message: "У тебя уже есть активная подписка — пробный период сейчас не нужен",
      };
    }
    if (user.trialUsed?.[plan]) {
      return {
        ok: false,
        reason: "trial_used",
        message:
          plan === "plus"
            ? "Пробный период «Плюс» уже был использован"
            : "Пробный период «Забота» уже был использован",
      };
    }
    return { ok: true };
  }

  trialEligible(user: UserProfile): { care: boolean; plus: boolean } {
    const premium = this.isPremium(user);
    return {
      care: !premium && !user.trialUsed?.care,
      plus: !premium && !user.trialUsed?.plus,
    };
  }

  /**
   * Activate a one-time free trial for care or plus (does not require payment).
   */
  startTrial(userId: number, plan: "care" | "plus"): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const check = this.canStartTrial(user, plan);
    if (!check.ok) {
      const err = new Error(check.reason) as Error & {
        reason: string;
        message: string;
      };
      err.reason = check.reason;
      err.message = check.message;
      throw err;
    }
    const until = new Date();
    until.setDate(until.getDate() + Store.TRIAL_DAYS);
    user.plan = plan;
    user.premiumUntil = until.toISOString();
    user.isTrial = true;
    user.trialUsed = { ...(user.trialUsed || {}), [plan]: true };
    this.persist();
    return user;
  }

  todayKey(user: UserProfile): string {
    const offsetMs = (user.timezoneOffsetMin || 0) * 60_000;
    const d = new Date(Date.now() + offsetMs);
    return d.toISOString().slice(0, 10);
  }

  addCheckin(
    userId: number,
    checkin: Omit<MoodCheckin, "id" | "at"> & { at?: string }
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const entry: MoodCheckin = {
      id: `c_${Date.now()}`,
      at: checkin.at || new Date().toISOString(),
      mood: checkin.mood,
      energy: checkin.energy,
      stress: checkin.stress,
      sleep: checkin.sleep,
      note: checkin.note,
      tags: checkin.tags,
    };
    user.checkins.unshift(entry);
    if (user.checkins.length > 365) user.checkins = user.checkins.slice(0, 365);

    const today = this.todayKey(user);
    if (user.lastCheckinDate !== today) {
      const yesterday = this.shiftDay(today, -1);
      user.streak = user.lastCheckinDate === yesterday ? user.streak + 1 : 1;
      user.lastCheckinDate = today;
    }
    this.persist();
    return user;
  }

  addJournal(
    userId: number,
    prompt: string,
    text: string
  ): JournalEntry {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const entry: JournalEntry = {
      id: `j_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      prompt,
      text,
    };
    user.journal.unshift(entry);
    if (user.journal.length > 200) user.journal = user.journal.slice(0, 200);
    this.persist();
    return entry;
  }

  listJournal(userId: number, limit = 100): JournalEntry[] {
    const user = this.getUser(userId);
    if (!user) return [];
    this.ensureJournalIds(user);
    return user.journal.slice(0, limit);
  }

  getJournalEntry(userId: number, entryId: string): JournalEntry | undefined {
    const user = this.getUser(userId);
    if (!user) return undefined;
    this.ensureJournalIds(user);
    return user.journal.find((j) => j.id === entryId);
  }

  updateJournal(
    userId: number,
    entryId: string,
    patch: { text?: string; prompt?: string }
  ): JournalEntry {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const entry = user.journal.find((j) => j.id === entryId);
    if (!entry) throw new Error("Entry not found");
    if (typeof patch.text === "string") entry.text = patch.text;
    if (typeof patch.prompt === "string") entry.prompt = patch.prompt;
    entry.updatedAt = new Date().toISOString();
    this.persist();
    return entry;
  }

  deleteJournal(userId: number, entryId: string): boolean {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const before = user.journal.length;
    user.journal = user.journal.filter((j) => j.id !== entryId);
    if (user.journal.length === before) return false;
    this.persist();
    return true;
  }

  addPractice(
    userId: number,
    practiceId: string,
    title: string,
    durationSec: number
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    user.practices.unshift({
      id: `p_${Date.now()}`,
      at: new Date().toISOString(),
      practiceId,
      title,
      durationSec,
    });
    if (user.practices.length > 300) user.practices = user.practices.slice(0, 300);
    this.persist();
    return user;
  }

  getAchievementIds(userId: number): string[] {
    const user = this.getUser(userId);
    return (user?.achievements || []).map((a) => a.id);
  }

  /**
   * Unlock achievement ids that are not yet owned. Returns newly unlocked ids.
   */
  unlockAchievements(userId: number, ids: string[]): string[] {
    const user = this.getUser(userId);
    if (!user || !ids.length) return [];
    user.achievements = user.achievements || [];
    const have = new Set(user.achievements.map((a) => a.id));
    const fresh: string[] = [];
    const now = new Date().toISOString();
    for (const id of ids) {
      if (have.has(id)) continue;
      user.achievements.unshift({ id, at: now });
      have.add(id);
      fresh.push(id);
    }
    if (fresh.length) {
      if (user.achievements.length > 100) {
        user.achievements = user.achievements.slice(0, 100);
      }
      this.persist();
    }
    return fresh;
  }

  addStress(
    userId: number,
    level: MoodScore,
    source?: string,
    note?: string
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    user.stress.unshift({
      id: `s_${Date.now()}`,
      at: new Date().toISOString(),
      level,
      source,
      note,
    });
    if (user.stress.length > 300) user.stress = user.stress.slice(0, 300);
    this.persist();
    return user;
  }

  pushCoachMessage(
    userId: number,
    role: "user" | "assistant",
    content: string
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    user.coachMessages.push({
      role,
      content,
      at: new Date().toISOString(),
    });
    // keep last 20 turns
    if (user.coachMessages.length > 40) {
      user.coachMessages = user.coachMessages.slice(-40);
    }
    this.persist();
    return user;
  }

  canUseCoach(user: UserProfile): { ok: boolean; remaining: number; limit: number } {
    const today = this.todayKey(user);
    if (user.freeCoachDate !== today) {
      user.freeCoachToday = 0;
      user.freeCoachDate = today;
      this.persist();
    }
    const premium = this.isPremium(user);
    const limit = premium ? (user.plan === "plus" ? 50 : 20) : 3;
    const remaining = Math.max(0, limit - user.freeCoachToday);
    return { ok: remaining > 0, remaining, limit };
  }

  consumeCoach(userId: number): void {
    const user = this.getUser(userId);
    if (!user) return;
    const today = this.todayKey(user);
    if (user.freeCoachDate !== today) {
      user.freeCoachToday = 0;
      user.freeCoachDate = today;
    }
    user.freeCoachToday += 1;
    this.persist();
  }

  findUserByUsername(username: string): UserProfile | undefined {
    const needle = username.replace(/^@/, "").toLowerCase();
    if (!needle) return undefined;
    return Object.values(this.data.users).find(
      (u) => u.username?.toLowerCase() === needle
    );
  }

  /**
   * Admin / gift: full paid-tier access without Crypto Pay invoice.
   * Extends from current premiumUntil if still active.
   */
  grantPlan(
    userId: number,
    plan: "care" | "plus",
    days: number,
    opts?: { replace?: boolean }
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const d = Math.max(1, Math.min(3650, Math.floor(days)));
    if (opts?.replace) {
      const until = new Date();
      until.setDate(until.getDate() + d);
      user.plan = plan;
      user.premiumUntil = until.toISOString();
      user.isTrial = false;
      this.persist();
      return user;
    }
    return this.activatePlan(userId, plan, d);
  }

  revokePlan(userId: number): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    user.plan = "free";
    user.premiumUntil = undefined;
    user.isTrial = false;
    this.persist();
    return user;
  }

  activatePlan(
    userId: number,
    plan: "care" | "plus",
    days = 30,
    payment?: { invoiceId: number; amount?: string; asset?: string }
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    const until = new Date();
    // extend if already premium same or higher
    const base =
      user.premiumUntil && new Date(user.premiumUntil) > until
        ? new Date(user.premiumUntil)
        : until;
    base.setDate(base.getDate() + days);
    user.plan = plan;
    user.premiumUntil = base.toISOString();
    // Paid activation ends trial flag
    user.isTrial = false;
    if (payment) {
      user.paymentHistory = user.paymentHistory || [];
      // prevent double-credit same invoice
      if (!user.paymentHistory.some((p) => p.invoiceId === payment.invoiceId)) {
        user.paymentHistory.unshift({
          invoiceId: payment.invoiceId,
          plan,
          paidAt: new Date().toISOString(),
          amount: payment.amount,
          asset: payment.asset,
        });
        if (user.paymentHistory.length > 50) {
          user.paymentHistory = user.paymentHistory.slice(0, 50);
        }
        // 15% referral commission on newly recorded paid invoices
        this.creditReferralCommission(userId, {
          invoiceId: payment.invoiceId,
          amount: payment.amount,
          plan,
        });
      } else {
        // already paid this invoice — just ensure plan active
      }
      user.pendingInvoices = (user.pendingInvoices || []).filter(
        (i) => i.invoiceId !== payment.invoiceId
      );
    }
    this.persist();
    return user;
  }

  /** Generate or return stable invite code for user */
  ensureReferralCode(userId: number): string {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    if (user.referralCode) {
      this.data.referralIndex = this.data.referralIndex || {};
      this.data.referralIndex[user.referralCode.toLowerCase()] = userId;
      return user.referralCode;
    }
    this.data.referralIndex = this.data.referralIndex || {};
    let code = "";
    for (let i = 0; i < 12; i++) {
      const base = userId.toString(36);
      const rnd = Math.random().toString(36).slice(2, 6);
      code = `${base}${rnd}`.replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
      if (!code) code = `u${userId.toString(36)}`;
      const taken = this.data.referralIndex[code];
      if (!taken || taken === userId) break;
      code = `${code}${i}`;
    }
    user.referralCode = code;
    this.data.referralIndex[code] = userId;
    this.persist();
    return code;
  }

  findUserIdByReferralCode(raw: string): number | undefined {
    const code = this.normalizeReferralCode(raw);
    if (!code) return undefined;
    this.data.referralIndex = this.data.referralIndex || {};
    const id = this.data.referralIndex[code];
    if (id && this.getUser(id)) return id;
    // fallback scan
    for (const u of Object.values(this.data.users)) {
      if (u.referralCode?.toLowerCase() === code) {
        this.data.referralIndex[code] = u.userId;
        return u.userId;
      }
    }
    return undefined;
  }

  /** Parse start payload / startapp: ref_CODE or just CODE */
  normalizeReferralCode(raw: string | undefined | null): string | null {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // /start ref_xxx  or deep link leftovers
    s = s.replace(/^\/start(@\w+)?\s*/i, "").trim();
    s = s.replace(/^ref[_-]?/i, "");
    s = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (s.length < 3 || s.length > 24) return null;
    return s;
  }

  /**
   * Attach invitee to referrer once. Ignores self-ref and already-attached.
   */
  attachReferrer(
    inviteeId: number,
    rawCode: string
  ): {
    ok: boolean;
    reason?: string;
    referrerId?: number;
  } {
    const code = this.normalizeReferralCode(rawCode);
    if (!code) return { ok: false, reason: "bad_code" };
    const invitee = this.getUser(inviteeId);
    if (!invitee) return { ok: false, reason: "no_user" };
    if (invitee.referredBy) {
      return {
        ok: false,
        reason: "already",
        referrerId: invitee.referredBy,
      };
    }
    const referrerId = this.findUserIdByReferralCode(code);
    if (!referrerId) return { ok: false, reason: "not_found" };
    if (referrerId === inviteeId) return { ok: false, reason: "self" };
    // Ensure referrer has code set
    this.ensureReferralCode(referrerId);
    invitee.referredBy = referrerId;
    invitee.referredAt = new Date().toISOString();
    this.persist();
    return { ok: true, referrerId };
  }

  /**
   * Credit 15% of paid subscription to the payer's referrer (idempotent by invoiceId).
   */
  creditReferralCommission(
    payerId: number,
    payment: {
      invoiceId: number;
      amount?: string;
      plan: "care" | "plus";
    }
  ): ReferralEarning | null {
    const payer = this.getUser(payerId);
    if (!payer?.referredBy) return null;
    const referrer = this.getUser(payer.referredBy);
    if (!referrer) return null;
    if (referrer.userId === payerId) return null;

    referrer.referralEarnings = referrer.referralEarnings || [];
    if (referrer.referralEarnings.some((e) => e.invoiceId === payment.invoiceId)) {
      return null; // already credited
    }

    let paymentUsdt = Number(payment.amount);
    if (!Number.isFinite(paymentUsdt) || paymentUsdt <= 0) {
      // fallback: no amount on invoice — skip zero commission
      return null;
    }
    // round commission to 2 decimals
    const amountUsdt =
      Math.round(paymentUsdt * REFERRAL_COMMISSION_RATE * 100 + 1e-9) / 100;
    if (amountUsdt < 0.01) return null;

    const earning: ReferralEarning = {
      id: `ref_${payment.invoiceId}_${payerId}`,
      fromUserId: payerId,
      invoiceId: payment.invoiceId,
      amountUsdt,
      paymentUsdt:
        Math.round(paymentUsdt * 100 + 1e-9) / 100,
      plan: payment.plan,
      at: new Date().toISOString(),
    };
    referrer.referralEarnings.unshift(earning);
    if (referrer.referralEarnings.length > 100) {
      referrer.referralEarnings = referrer.referralEarnings.slice(0, 100);
    }
    referrer.referralBalanceUsdt =
      Math.round(
        ((referrer.referralBalanceUsdt || 0) + amountUsdt) * 100 + 1e-9
      ) / 100;
    referrer.referralEarnedUsdt =
      Math.round(
        ((referrer.referralEarnedUsdt || 0) + amountUsdt) * 100 + 1e-9
      ) / 100;
    this.persist();
    return earning;
  }

  referralStats(userId: number) {
    const user = this.getUser(userId);
    if (!user) {
      return {
        code: "",
        invitedCount: 0,
        paidCount: 0,
        balanceUsdt: 0,
        earnedUsdt: 0,
        earnings: [] as ReferralEarning[],
        rate: REFERRAL_COMMISSION_RATE,
      };
    }
    const code = this.ensureReferralCode(userId);
    const invited = Object.values(this.data.users).filter(
      (u) => u.referredBy === userId
    );
    const paidCount = invited.filter(
      (u) => (u.paymentHistory || []).length > 0
    ).length;
    return {
      code,
      invitedCount: invited.length,
      paidCount,
      balanceUsdt: user.referralBalanceUsdt || 0,
      earnedUsdt: user.referralEarnedUsdt || 0,
      earnings: (user.referralEarnings || []).slice(0, 30),
      rate: REFERRAL_COMMISSION_RATE,
      referredBy: user.referredBy,
    };
  }

  trackInvoice(
    userId: number,
    invoiceId: number,
    plan: "care" | "plus",
    days?: number
  ): void {
    const user = this.getUser(userId);
    if (!user) return;
    user.pendingInvoices = user.pendingInvoices || [];
    user.pendingInvoices.unshift({
      invoiceId,
      plan,
      days: days && days > 0 ? days : 30,
      at: new Date().toISOString(),
    });
    user.pendingInvoices = user.pendingInvoices.slice(0, 20);
    this.persist();
  }

  hasPaidInvoice(userId: number, invoiceId: number): boolean {
    const user = this.getUser(userId);
    if (!user?.paymentHistory) return false;
    return user.paymentHistory.some((p) => p.invoiceId === invoiceId);
  }

  private shiftDay(yyyyMmDd: string, delta: number): string {
    const d = new Date(yyyyMmDd + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  weekStats(user: UserProfile) {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const checkins = user.checkins.filter((c) => new Date(c.at).getTime() >= since);
    const stress = user.stress.filter((s) => new Date(s.at).getTime() >= since);
    const practices = user.practices.filter(
      (p) => new Date(p.at).getTime() >= since
    );
    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    return {
      checkinCount: checkins.length,
      practiceCount: practices.length,
      stressCount: stress.length,
      avgMood: avg(checkins.map((c) => c.mood)),
      avgEnergy: avg(checkins.map((c) => c.energy)),
      avgStress: avg(
        checkins.map((c) => c.stress).concat(stress.map((s) => s.level))
      ),
      streak: user.streak,
    };
  }
}

export const store = new Store();
