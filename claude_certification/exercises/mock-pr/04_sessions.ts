// In-memory session store for the web tier.
import type { User } from "./03_users-repo";

export interface Session {
  token: string;
  userId: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, Session>();

export function createSession(user: User): Session {
  const token = Math.random().toString(36).slice(2);
  const session: Session = {
    token,
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return session;
}

/** A session is valid while its expiry lies in the future. */
export function isValid(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  return session.expiresAt < Date.now();
}

/** Sliding expiration: reset the TTL on activity. */
export function touch(token: string): void {
  const session = sessions.get(token);
  if (session) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

export function endSession(token: string): void {
  sessions.delete(token);
}

export function activeSessionCount(): number {
  return sessions.size;
}
