import NodeCache from "node-cache";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CacheStatsV2 {
  l1_hits: number;
  l1_misses: number;
  l2_hits: number;
  l2_misses: number;
  l1_keys: number;
  l2_keys: number;
  hit_rate: number;
}

interface PersistentEntry {
  value: string;
  created_at: number;
  ttl_ms: number;
}

type PersistentStore = Record<string, PersistentEntry>;

/**
 * Two-level cache using in-memory NodeCache and an atomic JSON-file store.
 * A JSON store keeps this distributable skill free of native build dependencies.
 */
export class CacheManager {
  private readonly l1 = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  private readonly dbPath: string;
  private entries: PersistentStore;
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
  };

  constructor(
    dbPath: string = process.env.CACHE_DB_PATH || join(homedir(), ".chictr", "cache", "chictr_cache.json")
  ) {
    this.dbPath = this.ensureDbPath(dbPath);
    this.entries = this.loadStore();
    this.cleanupExpired();
  }

  private ensureDbPath(preferredPath: string): string {
    const preferredDir = dirname(preferredPath);
    try {
      mkdirSync(preferredDir, { recursive: true });
      return preferredPath;
    } catch {
      const fallbackPath = join("/tmp", "chictr", "cache", "chictr_cache.json");
      mkdirSync(dirname(fallbackPath), { recursive: true });
      return fallbackPath;
    }
  }

  private loadStore(): PersistentStore {
    if (!existsSync(this.dbPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.dbPath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return value as PersistentStore;
    } catch {
      return {};
    }
  }

  private persist(): void {
    const tempPath = `${this.dbPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.entries), "utf8");
    renameSync(tempPath, this.dbPath);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const l1Value = this.l1.get<T>(key);
    if (l1Value !== undefined) {
      this.stats.l1Hits += 1;
      return l1Value;
    }
    this.stats.l1Misses += 1;

    const entry = this.entries[key];
    if (!entry) {
      this.stats.l2Misses += 1;
      return undefined;
    }

    const remainingTtlMs = entry.ttl_ms - (Date.now() - entry.created_at);
    if (remainingTtlMs <= 0) {
      delete this.entries[key];
      this.persist();
      this.stats.l2Misses += 1;
      return undefined;
    }

    try {
      const parsed = JSON.parse(entry.value) as T;
      this.l1.set(key, parsed, remainingTtlMs / 1000);
      this.stats.l2Hits += 1;
      return parsed;
    } catch {
      delete this.entries[key];
      this.persist();
      this.stats.l2Misses += 1;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Cache TTL must be a positive finite number");
    }

    this.cleanupExpired();
    this.l1.set(key, value, ttlMs / 1000);
    this.entries[key] = {
      value: JSON.stringify(value),
      created_at: Date.now(),
      ttl_ms: ttlMs,
    };
    this.persist();
  }

  close(): void {
    this.l1.close();
  }

  clearAll(): void {
    this.l1.flushAll();
    this.entries = {};
    this.persist();
  }

  cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.created_at + entry.ttl_ms <= now) {
        delete this.entries[key];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  getStats(): CacheStatsV2 {
    const totalHits = this.stats.l1Hits + this.stats.l2Hits;
    const totalRequests = totalHits + this.stats.l1Misses + this.stats.l2Misses;
    return {
      l1_hits: this.stats.l1Hits,
      l1_misses: this.stats.l1Misses,
      l2_hits: this.stats.l2Hits,
      l2_misses: this.stats.l2Misses,
      l1_keys: this.l1.keys().length,
      l2_keys: Object.keys(this.entries).length,
      hit_rate: totalRequests === 0 ? 0 : totalHits / totalRequests,
    };
  }
}
