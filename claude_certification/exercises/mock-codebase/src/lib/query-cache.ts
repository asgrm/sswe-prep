interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-process read cache for repository lookups. Keys are caller-supplied
 * strings (by convention `<table>:<id>`).
 */
export class QueryCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs = 60_000) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  // Added for the v2 refactor so writers could drop every entry for one
  // aggregate (e.g. "order:1001"). Nothing calls it yet.
  invalidateByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
