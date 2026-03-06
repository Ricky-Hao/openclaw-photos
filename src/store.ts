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

  // ── Get Random ──────────────────────────────────────────────────

  getRandom(collection?: string, tags?: string[], count: number = 1): PhotoRecord[] {
    const clampedCount = Math.min(Math.max(count, 1), 10);

    let sql: string;
    const params: unknown[] = [];

    if (tags && tags.length > 0) {
      // Filter by tags (OR match) + optional collection
      const placeholders = tags.map(() => "?").join(", ");
      sql = `
        SELECT DISTINCT p.id, p.collection, p.file, p.description, p.hash
        FROM photos p
        JOIN photo_tags pt ON pt.photo_id = p.id
        WHERE pt.tag IN (${placeholders})
      `;
      params.push(...tags);

      if (collection) {
        sql += " AND p.collection = ?";
        params.push(collection);
      }

      sql += " ORDER BY RANDOM() LIMIT ?";
      params.push(clampedCount);
    } else if (collection) {
      sql = `
        SELECT p.id, p.collection, p.file, p.description, p.hash
        FROM photos p
        WHERE p.collection = ?
        ORDER BY RANDOM() LIMIT ?
      `;
      params.push(collection, clampedCount);
    } else {
      sql = `
        SELECT p.id, p.collection, p.file, p.description, p.hash
        FROM photos p
        ORDER BY RANDOM() LIMIT ?
      `;
      params.push(clampedCount);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      collection: string;
      file: string;
      description: string;
      hash: string;
    }>;

    return rows.map((row) => {
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
