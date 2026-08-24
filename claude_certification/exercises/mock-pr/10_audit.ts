// Audit log utilities for the admin dashboard.

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format an ISO timestamp as YYYY-MM-DD for report grouping. */
export function dayOf(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth())}-${pad2(date.getDate())}`;
}

/** Returns events sorted oldest-first without changing the caller's array. */
export function sortedByTime(events: AuditEvent[]): AuditEvent[] {
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** Parse one line of the audit log shipped from the edge servers. */
export function parseEventLine(line: string): AuditEvent {
  const parsed = JSON.parse(line);
  return { at: parsed.at, actor: parsed.actor, action: parsed.action };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${pad2(seconds)}s`;
}
