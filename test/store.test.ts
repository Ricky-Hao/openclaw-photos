// ── PhotoStore unit tests (in-memory SQLite) ────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDatabase } from "../src/db.js";
import { PhotoStore } from "../src/store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "photos-test-"));
}

describe("PhotoStore", () => {
  let store: PhotoStore;
  let imagesDir: string;

  beforeEach(() => {
    const db = openMemoryDatabase();
    imagesDir = makeTmpDir();
    store = new PhotoStore(db, imagesDir);
  });

  // ── save + get basic flow ───────────────────────────────────────

  it("should save a photo and retrieve it", () => {
    const buf = Buffer.from("fake-image-data-1");
    const saved = store.saveFromBuffer(buf, ".jpg", "cats", ["cute", "fluffy"], "A cute cat");

    expect(saved.id).toBeTruthy();
    expect(saved.collection).toBe("cats");
    expect(saved.tags).toEqual(["cute", "fluffy"]);
    expect(saved.description).toBe("A cute cat");
    expect(saved.hash).toBeTruthy();
    expect(saved.file).toMatch(/\.jpg$/);

    // File should exist on disk
    expect(existsSync(saved.path)).toBe(true);

    // Get should return it
    const { photos } = store.getRandom("cats");
    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe(saved.id);
    expect(photos[0].path).toBe(saved.path);
  });

  // ── filter by tag ──────────────────────────────────────────────

  it("should filter photos by tags (OR match)", () => {
    store.saveFromBuffer(Buffer.from("img-a"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("img-b"), ".jpg", "cats", ["angry"]);
    store.saveFromBuffer(Buffer.from("img-c"), ".jpg", "cats", ["sleepy"]);

    const { photos: cute } = store.getRandom(undefined, ["cute"], 10);
    expect(cute).toHaveLength(1);
    expect(cute[0].tags).toContain("cute");

    const { photos: cuteOrAngry } = store.getRandom(undefined, ["cute", "angry"], 10);
    expect(cuteOrAngry).toHaveLength(2);
  });

  // ── filter by collection ───────────────────────────────────────

  it("should filter photos by collection", () => {
    store.saveFromBuffer(Buffer.from("cat-1"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("meme-1"), ".jpg", "memes", ["funny"]);

    const { photos: cats } = store.getRandom("cats", undefined, 10);
    expect(cats).toHaveLength(1);
    expect(cats[0].collection).toBe("cats");

    const { photos: memes } = store.getRandom("memes", undefined, 10);
    expect(memes).toHaveLength(1);
    expect(memes[0].collection).toBe("memes");
  });

  // ── filter by both collection and tags ─────────────────────────

  it("should filter by both collection and tags", () => {
    store.saveFromBuffer(Buffer.from("cat-cute"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("cat-angry"), ".jpg", "cats", ["angry"]);
    store.saveFromBuffer(Buffer.from("dog-cute"), ".jpg", "dogs", ["cute"]);

    const { photos: catCute } = store.getRandom("cats", ["cute"], 10);
    expect(catCute).toHaveLength(1);
    expect(catCute[0].collection).toBe("cats");
    expect(catCute[0].tags).toContain("cute");
  });

  // ── randomness ─────────────────────────────────────────────────

  it("should return valid results on random retrieval", () => {
    for (let i = 0; i < 10; i++) {
      store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", ["cat"]);
    }

    const { photos: results } = store.getRandom("cats", undefined, 3);
    expect(results).toHaveLength(3);
    // Each result should be valid
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.collection).toBe("cats");
      expect(existsSync(r.path)).toBe(true);
    }
  });

  // ── dedup by hash ──────────────────────────────────────────────

  it("should deduplicate by hash within the same collection", () => {
    const buf = Buffer.from("duplicate-image");
    const first = store.saveFromBuffer(buf, ".jpg", "cats", ["cute"]);
    const second = store.saveFromBuffer(buf, ".jpg", "cats", ["another-tag"]);

    // Should return the same record (first one)
    expect(second.id).toBe(first.id);
    expect(second.hash).toBe(first.hash);

    // Only one photo in DB
    const { photos: all } = store.getRandom("cats", undefined, 10);
    expect(all).toHaveLength(1);
  });

  it("should allow same hash in different collections", () => {
    const buf = Buffer.from("shared-image");
    const inCats = store.saveFromBuffer(buf, ".jpg", "cats", ["cute"]);
    const inDogs = store.saveFromBuffer(buf, ".jpg", "dogs", ["cute"]);

    expect(inCats.id).not.toBe(inDogs.id);
    expect(inCats.collection).toBe("cats");
    expect(inDogs.collection).toBe("dogs");
  });

  // ── delete ─────────────────────────────────────────────────────

  it("should delete a photo from DB and disk", () => {
    const saved = store.saveFromBuffer(Buffer.from("to-delete"), ".jpg", "cats", ["bye"]);
    expect(existsSync(saved.path)).toBe(true);

    const result = store.delete(saved.id);
    expect(result.deleted).toBe(true);
    expect(result.id).toBe(saved.id);

    // File should be gone
    expect(existsSync(saved.path)).toBe(false);

    // DB should be empty
    const { photos } = store.getRandom("cats", undefined, 10);
    expect(photos).toHaveLength(0);
  });

  it("should return error when deleting non-existent photo", () => {
    const result = store.delete("non-existent-id");
    expect(result.deleted).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── list statistics ────────────────────────────────────────────

  it("should list collections and tag stats", () => {
    store.saveFromBuffer(Buffer.from("c1"), ".jpg", "cats", ["cute", "fluffy"]);
    store.saveFromBuffer(Buffer.from("c2"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("m1"), ".jpg", "memes", ["funny"]);

    const all = store.list();
    expect(all.total).toBe(3);
    expect(all.collections).toHaveLength(2);

    const catCol = all.collections.find((c) => c.id === "cats");
    expect(catCol).toBeTruthy();
    expect(catCol!.count).toBe(2);

    const memeCol = all.collections.find((c) => c.id === "memes");
    expect(memeCol).toBeTruthy();
    expect(memeCol!.count).toBe(1);

    // Tags
    const cuteTag = all.tags.find((t) => t.tag === "cute");
    expect(cuteTag).toBeTruthy();
    expect(cuteTag!.count).toBe(2);
  });

  it("should list stats filtered by collection", () => {
    store.saveFromBuffer(Buffer.from("c1"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("m1"), ".jpg", "memes", ["funny"]);

    const catStats = store.list("cats");
    expect(catStats.total).toBe(1);
    expect(catStats.collections).toHaveLength(1);
    expect(catStats.collections[0].id).toBe("cats");
    expect(catStats.tags).toHaveLength(1);
    expect(catStats.tags[0].tag).toBe("cute");
  });

  // ── empty library ──────────────────────────────────────────────

  it("should return empty photos when library is empty", () => {
    const { photos } = store.getRandom();
    expect(photos).toEqual([]);
  });

  it("should return empty list stats when library is empty", () => {
    const stats = store.list();
    expect(stats.total).toBe(0);
    expect(stats.collections).toEqual([]);
    expect(stats.tags).toEqual([]);
  });

  // ── count clamping ─────────────────────────────────────────────

  it("should clamp count to max 10", () => {
    for (let i = 0; i < 15; i++) {
      store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", ["cat"]);
    }
    const { photos } = store.getRandom("cats", undefined, 20);
    expect(photos.length).toBeLessThanOrEqual(10);
  });

  // ── extension handling ─────────────────────────────────────────

  it("should preserve file extension", () => {
    const png = store.saveFromBuffer(Buffer.from("png-img"), ".png", "art", []);
    expect(png.file).toMatch(/\.png$/);

    const gif = store.saveFromBuffer(Buffer.from("gif-img"), ".gif", "art", []);
    expect(gif.file).toMatch(/\.gif$/);
  });

  // ── description defaults ───────────────────────────────────────

  it("should default description to empty string", () => {
    const saved = store.saveFromBuffer(Buffer.from("no-desc"), ".jpg", "cats", []);
    expect(saved.description).toBe("");
  });

  // ── base64 data URL support ────────────────────────────────────

  it("should save photo from base64 data URL (jpeg)", async () => {
    const imageData = Buffer.from("fake-jpeg-data");
    const base64 = imageData.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const saved = await store.save(dataUrl, "cats", ["test"], "From base64");
    
    expect(saved.id).toBeTruthy();
    expect(saved.collection).toBe("cats");
    expect(saved.file).toMatch(/\.jpg$/);
    expect(saved.tags).toEqual(["test"]);
    expect(saved.description).toBe("From base64");
    expect(existsSync(saved.path)).toBe(true);

    // Verify content matches
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(saved.path);
    expect(content.toString()).toBe("fake-jpeg-data");
  });

  it("should save photo from base64 data URL (png)", async () => {
    const imageData = Buffer.from("fake-png-data");
    const base64 = imageData.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    const saved = await store.save(dataUrl, "art", []);
    
    expect(saved.file).toMatch(/\.png$/);
  });

  it("should save photo from base64 data URL (gif)", async () => {
    const imageData = Buffer.from("fake-gif-data");
    const base64 = imageData.toString("base64");
    const dataUrl = `data:image/gif;base64,${base64}`;

    const saved = await store.save(dataUrl, "memes", []);
    
    expect(saved.file).toMatch(/\.gif$/);
  });

  it("should save photo from base64 data URL (webp)", async () => {
    const imageData = Buffer.from("fake-webp-data");
    const base64 = imageData.toString("base64");
    const dataUrl = `data:image/webp;base64,${base64}`;

    const saved = await store.save(dataUrl, "modern", []);
    
    expect(saved.file).toMatch(/\.webp$/);
  });

  it("should deduplicate base64 data URLs by hash", async () => {
    const imageData = Buffer.from("duplicate-base64-data");
    const base64 = imageData.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const first = await store.save(dataUrl, "cats", ["cute"]);
    const second = await store.save(dataUrl, "cats", ["another"]);

    expect(second.id).toBe(first.id);
    expect(second.hash).toBe(first.hash);

    const { photos } = store.getRandom("cats", undefined, 10);
    expect(photos).toHaveLength(1);
  });

  it("should reject invalid data URL format", async () => {
    await expect(store.save("data:invalid", "cats", [])).rejects.toThrow("Invalid data URL format");
    await expect(store.save("data:image/jpeg,no-base64-marker", "cats", [])).rejects.toThrow("Invalid data URL format");
  });

  // ── local file path support ─────────────────────────────────────

  it("should save photo from local file path (jpg)", async () => {
    // Create a temp file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-test-"));
    const tmpFile = path.join(tmpDir, "test-image.jpg");
    const imageData = Buffer.from("fake-jpg-from-local-file");
    fs.writeFileSync(tmpFile, imageData);

    const saved = await store.save(tmpFile, "cats", ["local"], "From local path");
    expect(saved.file).toMatch(/\.jpg$/);
    expect(saved.description).toBe("From local path");
    expect(saved.tags).toContain("local");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should save photo from local file path (png)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-test-"));
    const tmpFile = path.join(tmpDir, "test-image.png");
    fs.writeFileSync(tmpFile, Buffer.from("fake-png-data"));

    const saved = await store.save(tmpFile, "cats", []);
    expect(saved.file).toMatch(/\.png$/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should reject non-existent local file path", async () => {
    await expect(store.save("/tmp/nonexistent-photo-12345.jpg", "cats", [])).rejects.toThrow("Local file not found");
  });
});

// ── Send History tests ────────────────────────────────────────────

describe("PhotoStore random history", () => {
  let store: PhotoStore;

  beforeEach(() => {
    const db = openMemoryDatabase();
    const imagesDir = makeTmpDir();
    store = new PhotoStore(db, imagesDir);
  });

  it("should prioritize unsent photos when target is provided", () => {
    // Save 10 photos (more than default threshold of 5)
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const saved = store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", []);
      ids.push(saved.id);
    }

    const sentIds = new Set<string>();
    // Get 8 photos one-by-one — all should be unique (no reset, remaining > 5)
    for (let i = 0; i < 8; i++) {
      const { photos } = store.getRandom("cats", undefined, 1, "group-a", 0);
      expect(photos).toHaveLength(1);
      expect(sentIds.has(photos[0].id)).toBe(false);
      sentIds.add(photos[0].id);
    }
    expect(sentIds.size).toBe(8);
  });

  it("should isolate history between different targets", () => {
    store.saveFromBuffer(Buffer.from("x"), ".jpg", "cats", []);

    // Send to group-a
    const { photos: forA } = store.getRandom("cats", undefined, 1, "group-a");
    expect(forA).toHaveLength(1);

    // group-b should still see it as unsent
    const statsB = store.getHistoryStats("group-b", "cats");
    expect(statsB.sent).toBe(0);
    expect(statsB.remaining).toBe(1);

    // group-a should see it as sent
    const statsA = store.getHistoryStats("group-a", "cats");
    expect(statsA.sent).toBe(1);
  });

  it("should auto-reset when remaining <= threshold", () => {
    // Save 6 photos, threshold = 5
    for (let i = 0; i < 6; i++) {
      store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", []);
    }

    // Send 1 photo → remaining = 5 → should trigger reset
    const { history: h1 } = store.getRandom("cats", undefined, 1, "group-a", 5);
    // After first call: was reset because remaining (5) <= threshold (5)
    // Actually: before the first call, sent=0, remaining=6, no reset needed
    // It sends 1, so after: sent=1, remaining=5
    expect(h1).toBeTruthy();

    // Send another → now sent=1 before this call, remaining=5 → triggers reset!
    const { history: h2 } = store.getRandom("cats", undefined, 1, "group-a", 5);
    expect(h2).toBeTruthy();
    expect(h2!.wasReset).toBe(true);
  });

  it("should return history info when target is provided", () => {
    for (let i = 0; i < 3; i++) {
      store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", []);
    }

    const { history } = store.getRandom("cats", undefined, 1, "group-a");
    expect(history).toBeTruthy();
    expect(history!.total).toBe(3);
    expect(history!.sent).toBe(1); // updated after recording
  });

  it("should not return history info without target", () => {
    store.saveFromBuffer(Buffer.from("x"), ".jpg", "cats", []);
    const { history } = store.getRandom("cats");
    expect(history).toBeUndefined();
  });

  it("should clear history for a specific target", () => {
    store.saveFromBuffer(Buffer.from("x"), ".jpg", "cats", []);

    // Send to both groups
    store.getRandom("cats", undefined, 1, "group-a");
    store.getRandom("cats", undefined, 1, "group-b");

    // Clear only group-a
    const cleared = store.clearHistory("group-a");
    expect(cleared).toBe(1);

    // group-a: reset
    const statsA = store.getHistoryStats("group-a", "cats");
    expect(statsA.sent).toBe(0);

    // group-b: still has history
    const statsB = store.getHistoryStats("group-b", "cats");
    expect(statsB.sent).toBe(1);
  });

  it("should clear history for specific target + collection", () => {
    store.saveFromBuffer(Buffer.from("cat-1"), ".jpg", "cats", []);
    store.saveFromBuffer(Buffer.from("dog-1"), ".jpg", "dogs", []);

    store.getRandom("cats", undefined, 1, "group-a");
    store.getRandom("dogs", undefined, 1, "group-a");

    // Clear only cats for group-a
    store.clearHistory("group-a", "cats");

    const catStats = store.getHistoryStats("group-a", "cats");
    expect(catStats.sent).toBe(0);

    const dogStats = store.getHistoryStats("group-a", "dogs");
    expect(dogStats.sent).toBe(1);
  });

  it("should clear all history when no args provided", () => {
    store.saveFromBuffer(Buffer.from("x"), ".jpg", "cats", []);
    store.getRandom("cats", undefined, 1, "group-a");
    store.getRandom("cats", undefined, 1, "group-b");

    const cleared = store.clearHistory();
    expect(cleared).toBe(2);
  });
});
