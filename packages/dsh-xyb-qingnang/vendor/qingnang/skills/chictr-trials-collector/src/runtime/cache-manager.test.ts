import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CacheManager } from "./cache-manager.js";

function createTestCache(): { cache: CacheManager; dir: string; cachePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "chictr-cache-test-"));
  const cachePath = join(dir, "cache.json");
  return { cache: new CacheManager(cachePath), dir, cachePath };
}

test("cache manager should persist value to the file-backed L2 cache", async () => {
  const { cache, dir, cachePath } = createTestCache();
  try {
    await cache.set("k1", { a: 1 }, 60_000);
    const secondCache = new CacheManager(cachePath);
    assert.deepEqual(await secondCache.get<{ a: number }>("k1"), { a: 1 });
    secondCache.close();
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cache manager should use the remaining L2 TTL when restoring L1", async () => {
  const { cache, dir, cachePath } = createTestCache();
  try {
    await cache.set("k1", { a: 1 }, 60_000);
    const entries = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { created_at: number }>;
    entries.k1!.created_at = Date.now() - 59_500;
    writeFileSync(cachePath, JSON.stringify(entries), "utf8");
    const secondCache = new CacheManager(cachePath);
    assert.deepEqual(await secondCache.get<{ a: number }>("k1"), { a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await secondCache.get("k1"), undefined);
    secondCache.close();
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("cache manager should discard malformed cache values", async () => {
  const { cache, dir, cachePath } = createTestCache();
  try {
    writeFileSync(
      cachePath,
      JSON.stringify({ bad: { value: "{", created_at: Date.now(), ttl_ms: 60_000 } }),
      "utf8"
    );
    const secondCache = new CacheManager(cachePath);
    assert.equal(await secondCache.get("bad"), undefined);
    secondCache.close();
  } finally {
    cache.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
