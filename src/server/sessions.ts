import crypto from "crypto";

export interface Session {
  userId: number;
  exp: number; // unix ms
}

/** Short-lived server sessions so clients don't send huge initData on every GET */
const sessions = new Map<string, Session>();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20_000;

function prune() {
  if (sessions.size < MAX_SESSIONS) return;
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (v.exp < now) sessions.delete(k);
  }
  // hard cap: drop oldest half if still huge
  if (sessions.size >= MAX_SESSIONS) {
    const keys = [...sessions.keys()].slice(0, Math.floor(sessions.size / 2));
    for (const k of keys) sessions.delete(k);
  }
}

export function createSession(userId: number): { token: string; exp: number } {
  prune();
  const token = crypto.randomBytes(24).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, exp });
  return { token, exp };
}

export function getSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function revokeSession(token: string): void {
  sessions.delete(token);
}
