/** Lightweight in-memory conversation state per user */

export type Flow =
  | "idle"
  | "checkin_mood"
  | "checkin_energy"
  | "checkin_stress"
  | "checkin_sleep"
  | "checkin_note"
  | "stress_level"
  | "stress_note"
  | "journal_write"
  | "coach_chat"
  | "onboarding_name";

export interface PendingCheckin {
  mood?: 1 | 2 | 3 | 4 | 5;
  energy?: 1 | 2 | 3 | 4 | 5;
  stress?: 1 | 2 | 3 | 4 | 5;
  sleep?: 1 | 2 | 3 | 4 | 5;
}

export interface UserSession {
  flow: Flow;
  pendingCheckin: PendingCheckin;
  pendingStressLevel?: 1 | 2 | 3 | 4 | 5;
  pendingStressSource?: string;
  journalPrompt?: string;
  focusDraft?: import("../db/store").FocusArea[];
}

const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession {
  let s = sessions.get(userId);
  if (!s) {
    s = { flow: "idle", pendingCheckin: {} };
    sessions.set(userId, s);
  }
  return s;
}

export function resetSession(userId: number) {
  sessions.set(userId, { flow: "idle", pendingCheckin: {} });
}

export function setFlow(userId: number, flow: Flow) {
  const s = getSession(userId);
  s.flow = flow;
}
