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
    const photos = store.getRandom("cats");
    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe(saved.id);
    expect(photos[0].path).toBe(saved.path);
  });

  // ── filter by tag ──────────────────────────────────────────────

  it("should filter photos by tags (OR match)", () => {
    store.saveFromBuffer(Buffer.from("img-a"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("img-b"), ".jpg", "cats", ["angry"]);
    store.saveFromBuffer(Buffer.from("img-c"), ".jpg", "cats", ["sleepy"]);

    const cute = store.getRandom(undefined, ["cute"], 10);
    expect(cute).toHaveLength(1);
    expect(cute[0].tags).toContain("cute");

    const cuteOrAngry = store.getRandom(undefined, ["cute", "angry"], 10);
    expect(cuteOrAngry).toHaveLength(2);
  });

  // ── filter by collection ───────────────────────────────────────

  it("should filter photos by collection", () => {
    store.saveFromBuffer(Buffer.from("cat-1"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("meme-1"), ".jpg", "memes", ["funny"]);

    const cats = store.getRandom("cats", undefined, 10);
    expect(cats).toHaveLength(1);
    expect(cats[0].collection).toBe("cats");

    const memes = store.getRandom("memes", undefined, 10);
    expect(memes).toHaveLength(1);
    expect(memes[0].collection).toBe("memes");
  });

  // ── filter by both collection and tags ─────────────────────────

  it("should filter by both collection and tags", () => {
    store.saveFromBuffer(Buffer.from("cat-cute"), ".jpg", "cats", ["cute"]);
    store.saveFromBuffer(Buffer.from("cat-angry"), ".jpg", "cats", ["angry"]);
    store.saveFromBuffer(Buffer.from("dog-cute"), ".jpg", "dogs", ["cute"]);

    const catCute = store.getRandom("cats", ["cute"], 10);
    expect(catCute).toHaveLength(1);
    expect(catCute[0].collection).toBe("cats");
    expect(catCute[0].tags).toContain("cute");
  });

  // ── randomness ─────────────────────────────────────────────────

  it("should return valid results on random retrieval", () => {
    for (let i = 0; i < 10; i++) {
      store.saveFromBuffer(Buffer.from(`img-${i}`), ".jpg", "cats", ["cat"]);
    }

    const results = store.getRandom("cats", undefined, 3);
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
    const all = store.getRandom("cats", undefined, 10);
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
    const photos = store.getRandom("cats", undefined, 10);
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

  it("should return empty array when library is empty", () => {
    const photos = store.getRandom();
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
    const photos = store.getRandom("cats", undefined, 20);
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
});
