/**
 * In-memory chat session store with TTL-based eviction.
 *
 * app.locals.conversations used to be a plain object that every sessionId got added to
 * and nothing ever removed from — a long-running server accumulates one growing message
 * array per browser tab/session forever, which is an unbounded memory leak. This caps
 * both how long an idle session is kept and how many sessions can exist at once.
 */

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours of inactivity
const MAX_SESSIONS = 500; // hard cap even within the TTL window
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface StoredSession {
  messages: any[];
  lastActivity: number;
}

const sessions = new Map<string, StoredSession>();

export function getConversation(sessionId: string): any[] {
  const entry = sessions.get(sessionId);
  return entry ? entry.messages : [];
}

export function saveConversation(sessionId: string, messages: any[]): void {
  sessions.set(sessionId, { messages, lastActivity: Date.now() });
  if (sessions.size > MAX_SESSIONS) {
    evictOldest(sessions.size - MAX_SESSIONS);
  }
}

function evictOldest(count: number): void {
  const byAge = [...sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
  for (let i = 0; i < count && i < byAge.length; i++) {
    sessions.delete(byAge[i][0]);
  }
}

function sweepExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, entry] of sessions) {
    if (entry.lastActivity < cutoff) sessions.delete(sessionId);
  }
}

setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();
