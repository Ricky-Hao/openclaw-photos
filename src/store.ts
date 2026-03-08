// ── PhotoStore — all CRUD operations ────────────────────────────────

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PhotoRecord {
  id: string;
  collection: string;
  file: string;
  path: string;
  tags: string[];
  description: string;
  hash: string;
}

export interface RandomHistoryInfo {
  total: number;
  sent: number;
  remaining: number;
  wasReset: boolean;
}

export interface CollectionStat {
  id: string;
  name: string;
  count: number;
}

export interface TagStat {
  tag: string;
  count: number;
}

export interface ListResult {
  collections: CollectionStat[];
  tags: TagStat[];
  total: number;
}

function generateId(): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad4 = (n: number) => String(n).padStart(4, "0");
  const date = `${pad4(now.getFullYear())}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (let i = 0; i < 3; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${date}_${time}_${rand}`;
}

export class PhotoStore {
  private db: Database.Database;
  private imagesDir: string;

  constructor(db: Database.Database, imagesDir: string) {
    this.db = db;
    this.imagesDir = imagesDir;
  }

  // ── Save ────────────────────────────────────────────────────────

  async save(
    url: string,
    collection: string,
    tags: string[] = [],
    description?: string,
  ): Promise<PhotoRecord> {
    // Download image
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to download image: HTTP ${resp.status}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png")
      ? ".png"
      : ct.includes("gif")
        ? ".gif"
        : ct.includes("webp")
          ? ".webp"
          : ".jpg";
    const hash = createHash("sha256").update(buffer).digest("hex");

    // Dedup: check if same hash exists in same collection
    const existing = this.db
      .prepare("SELECT id, file, description FROM photos WHERE hash = ? AND collection = ?")
      .get(hash, collection) as { id: string; file: string; description: string } | undefined;

    if (existing) {
      const existingTags = this.db
        .prepare("SELECT tag FROM photo_tags WHERE photo_id = ?")
        .all(existing.id) as { tag: string }[];
      const filePath = join(this.imagesDir, collection, existing.file);
      return {
        id: existing.id,
        collection,
        file: existing.file,
        path: filePath,
        tags: existingTags.map((t) => t.tag),
        description: existing.description,
        hash,
      };
    }

    // Generate ID and filename
    const id = generateId();
    const filename = `${id}${ext}`;

    // Ensure collection directory exists
    const collectionDir = join(this.imagesDir, collection);
    mkdirSync(collectionDir, { recursive: true });

    // Write file to disk
    const filePath = join(collectionDir, filename);
    writeFileSync(filePath, buffer);

    // Ensure collection row exists
    this.db
      .prepare("INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)")
      .run(collection, collection);

    // Insert photo record
    const desc = description ?? "";
    const addedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO photos (id, collection, file, description, hash, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, collection, filename, desc, hash, addedAt);

    // Insert tags
    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) {
      insertTag.run(id, tag);
    }

    return {
      id,
      collection,
      file: filename,
      path: filePath,
      tags: [...tags],
      description: desc,
      hash,
    };
  }

  /**
   * Save directly from a buffer — used by tests to avoid network calls.
   */
  saveFromBuffer(
    buffer: Buffer,
    ext: string,
    collection: string,
    tags: string[] = [],
    description?: string,
  ): PhotoRecord {
    const hash = createHash("sha256").update(buffer).digest("hex");

    // Dedup
    const existing = this.db
      .prepare("SELECT id, file, description FROM photos WHERE hash = ? AND collection = ?")
      .get(hash, collection) as { id: string; file: string; description: string } | undefined;

    if (existing) {
      const existingTags = this.db
        .prepare("SELECT tag FROM photo_tags WHERE photo_id = ?")
        .all(existing.id) as { tag: string }[];
      const filePath = join(this.imagesDir, collection, existing.file);
      return {
        id: existing.id,
        collection,
        file: existing.file,
        path: filePath,
        tags: existingTags.map((t) => t.tag),
        description: existing.description,
        hash,
      };
    }

    const id = generateId();
    const filename = `${id}${ext}`;

    const collectionDir = join(this.imagesDir, collection);
    mkdirSync(collectionDir, { recursive: true });

    const filePath = join(collectionDir, filename);
    writeFileSync(filePath, buffer);

    this.db
      .prepare("INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)")
      .run(collection, collection);

    const desc = description ?? "";
    const addedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO photos (id, collection, file, description, hash, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, collection, filename, desc, hash, addedAt);

    const insertTag = this.db.prepare(
      "INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) {
      insertTag.run(id, tag);
    }

    return {
      id,
      collection,
      file: filename,
      path: filePath,
      tags: [...tags],
      description: desc,
      hash,
    };
  }

  // ── Get Random (smart: per-target dedup) ─────────────────────────

  /** Default threshold: auto-reset when remaining unsent photos ≤ this value */
  static RESET_THRESHOLD = 5;

  getRandom(
    collection?: string,
    tags?: string[],
    count: number = 1,
    target?: string,
    resetThreshold: number = PhotoStore.RESET_THRESHOLD,
  ): { photos: PhotoRecord[]; history?: RandomHistoryInfo } {
    const clampedCount = Math.min(Math.max(count, 1), 10);

    // If target provided, handle random-history dedup
    let historyInfo: RandomHistoryInfo | undefined;
    if (target) {
      historyInfo = this.maybeResetAndGetInfo(collection, tags, target, resetThreshold);
    }

    let sql: string;
    const params: unknown[] = [];

    if (tags && tags.length > 0) {
      const placeholders = tags.map(() => "?").join(", ");
      sql = `
        SELECT DISTINCT p.id, p.collection, p.file, p.description, p.hash,
               rh.sent_at
        FROM photos p
        JOIN photo_tags pt ON pt.photo_id = p.id
        LEFT JOIN random_history rh ON rh.photo_id = p.id AND rh.collection = p.collection AND rh.target = ?
        WHERE pt.tag IN (${placeholders})
      `;
      params.push(target ?? "", ...tags);

      if (collection) {
        sql += " AND p.collection = ?";
        params.push(collection);
      }

      // Unsent first (NULL), then oldest sent, then random within same tier
      sql += " ORDER BY CASE WHEN rh.sent_at IS NULL THEN 0 ELSE 1 END, rh.sent_at ASC, RANDOM() LIMIT ?";
      params.push(clampedCount);
    } else if (collection) {
      sql = `
        SELECT p.id, p.collection, p.file, p.description, p.hash,
               rh.sent_at
        FROM photos p
        LEFT JOIN random_history rh ON rh.photo_id = p.id AND rh.collection = p.collection AND rh.target = ?
        WHERE p.collection = ?
        ORDER BY CASE WHEN rh.sent_at IS NULL THEN 0 ELSE 1 END, rh.sent_at ASC, RANDOM() LIMIT ?
      `;
      params.push(target ?? "", collection, clampedCount);
    } else {
      sql = `
        SELECT p.id, p.collection, p.file, p.description, p.hash,
               rh.sent_at
        FROM photos p
        LEFT JOIN random_history rh ON rh.photo_id = p.id AND rh.collection = p.collection AND rh.target = ?
        ORDER BY CASE WHEN rh.sent_at IS NULL THEN 0 ELSE 1 END, rh.sent_at ASC, RANDOM() LIMIT ?
      `;
      params.push(target ?? "", clampedCount);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      collection: string;
      file: string;
      description: string;
      hash: string;
      sent_at: string | null;
    }>;

    const photos = rows.map((row) => {
      const rowTags = this.db
        .prepare("SELECT tag FROM photo_tags WHERE photo_id = ?")
        .all(row.id) as { tag: string }[];
      return {
        id: row.id,
        collection: row.collection,
        file: row.file,
        path: join(this.imagesDir, row.collection, row.file),
        tags: rowTags.map((t) => t.tag),
        description: row.description,
        hash: row.hash,
      };
    });

    // Record random history
    if (target && photos.length > 0) {
      this.recordSent(photos, target);
      // Update remaining count after recording
      if (historyInfo) {
        historyInfo.sent += photos.length;
        historyInfo.remaining = Math.max(0, historyInfo.total - historyInfo.sent);
      }
    }

    return { photos, history: historyInfo };
  }

  // ── Random history helpers ──────────────────────────────────────────

  /**
   * Check remaining unsent count for target+collection+tags.
   * If ≤ threshold, auto-reset (clear history) for that target.
   */
  private maybeResetAndGetInfo(
    collection: string | undefined,
    tags: string[] | undefined,
    target: string,
    threshold: number,
  ): RandomHistoryInfo {
    // Count total matching photos
    const total = this.countMatchingPhotos(collection, tags);
    // Count how many of those have been sent to this target
    const sent = this.countSentPhotos(collection, tags, target);
    const remaining = total - sent;

    let wasReset = false;
    if (remaining <= threshold) {
      this.clearHistory(target, collection);
      wasReset = true;
      return { total, sent: 0, remaining: total, wasReset };
    }

    return { total, sent, remaining, wasReset };
  }

  private countMatchingPhotos(collection?: string, tags?: string[]): number {
    if (tags && tags.length > 0) {
      const placeholders = tags.map(() => "?").join(", ");
      let sql = `SELECT COUNT(DISTINCT p.id) as cnt FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id WHERE pt.tag IN (${placeholders})`;
      const params: unknown[] = [...tags];
      if (collection) {
        sql += " AND p.collection = ?";
        params.push(collection);
      }
      return (this.db.prepare(sql).get(...params) as { cnt: number }).cnt;
    } else if (collection) {
      return (this.db.prepare("SELECT COUNT(*) as cnt FROM photos WHERE collection = ?").get(collection) as { cnt: number }).cnt;
    } else {
      return (this.db.prepare("SELECT COUNT(*) as cnt FROM photos").get() as { cnt: number }).cnt;
    }
  }

  private countSentPhotos(collection: string | undefined, tags: string[] | undefined, target: string): number {
    if (tags && tags.length > 0) {
      const placeholders = tags.map(() => "?").join(", ");
      let sql = `SELECT COUNT(DISTINCT p.id) as cnt FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id JOIN random_history rh ON rh.photo_id = p.id AND rh.collection = p.collection AND rh.target = ? WHERE pt.tag IN (${placeholders})`;
      const params: unknown[] = [target, ...tags];
      if (collection) {
        sql += " AND p.collection = ?";
        params.push(collection);
      }
      return (this.db.prepare(sql).get(...params) as { cnt: number }).cnt;
    } else if (collection) {
      return (this.db.prepare("SELECT COUNT(*) as cnt FROM random_history WHERE collection = ? AND target = ?").get(collection, target) as { cnt: number }).cnt;
    } else {
      return (this.db.prepare("SELECT COUNT(*) as cnt FROM random_history WHERE target = ?").get(target) as { cnt: number }).cnt;
    }
  }

  private recordSent(photos: PhotoRecord[], target: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO random_history (collection, target, photo_id, sent_at) VALUES (?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const photo of photos) {
        stmt.run(photo.collection, target, photo.id, now);
      }
    });
    tx();
  }

  /**
   * Clear random history for a target. If collection provided, only clear
   * history for photos in that collection.
   */
  clearHistory(target?: string, collection?: string): number {
    if (target && collection) {
      const result = this.db.prepare(
        "DELETE FROM random_history WHERE collection = ? AND target = ?",
      ).run(collection, target);
      return result.changes;
    } else if (target) {
      const result = this.db.prepare("DELETE FROM random_history WHERE target = ?").run(target);
      return result.changes;
    } else if (collection) {
      const result = this.db.prepare(
        "DELETE FROM random_history WHERE collection = ?",
      ).run(collection);
      return result.changes;
    } else {
      const result = this.db.prepare("DELETE FROM random_history").run();
      return result.changes;
    }
  }

  /** Get random history stats for a target. */
  getHistoryStats(target: string, collection?: string): RandomHistoryInfo {
    const total = this.countMatchingPhotos(collection);
    const sent = this.countSentPhotos(collection, undefined, target);
    return { total, sent, remaining: total - sent, wasReset: false };
  }

  // ── List ────────────────────────────────────────────────────────

  list(collection?: string): ListResult {
    let collections: CollectionStat[];
    let tags: TagStat[];
    let total: number;

    if (collection) {
      const row = this.db
        .prepare(
          `SELECT c.id, c.name, COUNT(p.id) as count
           FROM collections c
           LEFT JOIN photos p ON p.collection = c.id
           WHERE c.id = ?
           GROUP BY c.id`,
        )
        .get(collection) as { id: string; name: string; count: number } | undefined;

      collections = row ? [{ id: row.id, name: row.name, count: row.count }] : [];

      tags = this.db
        .prepare(
          `SELECT pt.tag, COUNT(*) as count
           FROM photo_tags pt
           JOIN photos p ON p.id = pt.photo_id
           WHERE p.collection = ?
           GROUP BY pt.tag
           ORDER BY count DESC`,
        )
        .all(collection) as TagStat[];

      total = row ? row.count : 0;
    } else {
      collections = this.db
        .prepare(
          `SELECT c.id, c.name, COUNT(p.id) as count
           FROM collections c
           LEFT JOIN photos p ON p.collection = c.id
           GROUP BY c.id
           ORDER BY count DESC`,
        )
        .all() as CollectionStat[];

      tags = this.db
        .prepare(
          `SELECT pt.tag, COUNT(*) as count
           FROM photo_tags pt
           GROUP BY pt.tag
           ORDER BY count DESC`,
        )
        .all() as TagStat[];

      const countRow = this.db.prepare("SELECT COUNT(*) as count FROM photos").get() as { count: number } | undefined;
      total = countRow?.count ?? 0;
    }

    return { collections, tags, total };
  }

  // ── Delete ──────────────────────────────────────────────────────

  delete(id: string): { deleted: boolean; id: string; error?: string } {
    const row = this.db
      .prepare("SELECT collection, file FROM photos WHERE id = ?")
      .get(id) as { collection: string; file: string } | undefined;

    if (!row) {
      return { deleted: false, id, error: "Photo not found" };
    }

    // Delete from DB (cascade will delete photo_tags)
    this.db.prepare("DELETE FROM photos WHERE id = ?").run(id);

    // Delete file from disk
    const filePath = join(this.imagesDir, row.collection, row.file);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // File might already be gone — not a critical error
    }

    return { deleted: true, id };
  }
}
