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
  reminderHour?: number; // 0-23 local-ish
  lastCheckinDate?: string; // YYYY-MM-DD
  streak: number;
  checkins: MoodCheckin[];
  journal: JournalEntry[];
  practices: PracticeLog[];
  stress: StressPoint[];
  coachMessages: { role: "user" | "assistant"; content: string; at: string }[];
  freeCoachToday: number;
  freeCoachDate?: string;
  /** Last crypto invoice ids for this user */
  pendingInvoices?: { invoiceId: number; plan: "care" | "plus"; at: string }[];
  paymentHistory?: {
    invoiceId: number;
    plan: "care" | "plus";
    paidAt: string;
    amount?: string;
    asset?: string;
  }[];
}

interface StoreData {
  users: Record<string, UserProfile>;
}

function defaultDataPath(): string {
  if (process.env.DATA_PATH) return process.env.DATA_PATH;
  if (
    process.env.RENDER ||
    process.env.RAILWAY_ENVIRONMENT ||
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
      } else {
        this.persist();
      }
    } catch {
      this.data = { users: {} };
      this.persist();
    }
  }

  private persist() {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
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
    if (!user) {
      user = {
        userId: params.userId,
        chatId: params.chatId,
        username: params.username,
        firstName: params.firstName,
        createdAt: new Date().toISOString(),
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
        freeCoachToday: 0,
        pendingInvoices: [],
        paymentHistory: [],
      };
      this.data.users[key] = user;
      this.persist();
    } else {
      user.chatId = params.chatId;
      if (params.username) user.username = params.username;
      if (params.firstName) user.firstName = params.firstName;
      this.persist();
    }
    return user;
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
    return new Date(user.premiumUntil) > new Date();
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
  ): UserProfile {
    const user = this.getUser(userId);
    if (!user) throw new Error("User not found");
    user.journal.unshift({
      id: `j_${Date.now()}`,
      at: new Date().toISOString(),
      prompt,
      text,
    });
    if (user.journal.length > 200) user.journal = user.journal.slice(0, 200);
    this.persist();
    return user;
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

  trackInvoice(
    userId: number,
    invoiceId: number,
    plan: "care" | "plus"
  ): void {
    const user = this.getUser(userId);
    if (!user) return;
    user.pendingInvoices = user.pendingInvoices || [];
    user.pendingInvoices.unshift({
      invoiceId,
      plan,
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
