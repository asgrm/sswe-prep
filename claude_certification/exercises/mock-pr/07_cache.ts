// Tiny read-through cache for expensive lookups.

interface Entry {
  value: Record<string, unknown>;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function makeKey(parts: Array<string | number>): string {
  return parts.join(":");
}

export function set(key: string, value: Record<string, unknown>, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Return the cached value while the entry is still fresh. */
export function get(key: string): Record<string, unknown> | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    return entry.value;
  }
  return undefined;
}

export function has(key: string): boolean {
  return get(key) !== undefined;
}

export function size(): number {
  return store.size;
}
