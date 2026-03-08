// ── Tool parameter schemas + execute factories ─────────────────────

import { Type, type TObject } from "@sinclair/typebox";
import { copyFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { PhotoStore } from "./store.js";

// ── Tool Result type ────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  meta?: Record<string, unknown>;
};

function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}

// ── photo_save ──────────────────────────────────────────────────────

export const photoSaveParameters: TObject = Type.Object({
  url: Type.String({ description: "Image URL to download" }),
  collection: Type.String({ description: 'Collection ID (e.g. "yaoyao")' }),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags to assign", default: [] })),
  description: Type.Optional(Type.String({ description: "Human description" })),
});

export function createPhotoSaveExecute(
  store: PhotoStore,
): (_id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id, params) => {
    try {
      const url = params.url as string;
      const collection = params.collection as string;
      const tags = (params.tags as string[] | undefined) ?? [];
      const description = params.description as string | undefined;

      const result = await store.save(url, collection, tags, description);
      return textResult(result);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ── tmp cleanup ─────────────────────────────────────────────────────

/** Delete files in tmpDir older than maxAgeMs (default 5 min). */
function cleanupExpiredTmpFiles(tmpDir: string, maxAgeMs: number = 5 * 60 * 1000): number {
  if (!existsSync(tmpDir)) return 0;
  let cleaned = 0;
  const now = Date.now();
  for (const file of readdirSync(tmpDir)) {
    try {
      const filepath = join(tmpDir, file);
      const stat = statSync(filepath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filepath);
        cleaned++;
      }
    } catch {
      // ignore errors on individual files
    }
  }
  return cleaned;
}

// ── photo_get ───────────────────────────────────────────────────────

export const photoGetParameters: TObject = Type.Object({
  collection: Type.Optional(Type.String({ description: "Filter by collection" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (OR match)" })),
  count: Type.Optional(
    Type.Integer({ description: "Number of photos to return", default: 1, minimum: 1, maximum: 10 }),
  ),
  target: Type.Optional(
    Type.String({ description: 'Send target for dedup tracking (e.g. "qq:group:123456"). When provided, avoids repeating photos already sent to this target until most have been shown.' }),
  ),
});

export function createPhotoGetExecute(
  store: PhotoStore,
  tmpDir: string,
): (_id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id, params) => {
    try {
      // Clean up expired tmp files from previous calls
      cleanupExpiredTmpFiles(tmpDir);

      const collection = params.collection as string | undefined;
      const tags = params.tags as string[] | undefined;
      const count = (params.count as number | undefined) ?? 1;
      const target = params.target as string | undefined;

      const { photos, history } = store.getRandom(collection, tags, count, target);
      if (photos.length === 0) {
        return textResult({ photos: [], message: "No photos found" });
      }

      // Copy selected photos to tmpDir (inside media whitelist) for sending
      mkdirSync(tmpDir, { recursive: true });
      for (const photo of photos) {
        const srcPath = photo.path;
        if (existsSync(srcPath)) {
          const destPath = join(tmpDir, basename(srcPath));
          copyFileSync(srcPath, destPath);
          photo.path = destPath;
        }
      }

      return textResult({
        photos,
        _history: history,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ── photo_list ──────────────────────────────────────────────────────

export const photoListParameters: TObject = Type.Object({
  collection: Type.Optional(Type.String({ description: "Filter to specific collection" })),
});

export function createPhotoListExecute(
  store: PhotoStore,
): (_id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id, params) => {
    try {
      const collection = params.collection as string | undefined;
      const result = store.list(collection);
      return textResult(result);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ── photo_delete ────────────────────────────────────────────────────

export const photoDeleteParameters: TObject = Type.Object({
  id: Type.String({ description: "Photo ID to delete" }),
});

export function createPhotoDeleteExecute(
  store: PhotoStore,
): (_id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id, params) => {
    try {
      const id = params.id as string;
      const result = store.delete(id);
      if (!result.deleted) {
        return errorResult(result.error ?? "Photo not found");
      }
      return textResult(result);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ── photo_reset_history ─────────────────────────────────────────────

export const photoResetHistoryParameters: TObject = Type.Object({
  target: Type.Optional(
    Type.String({ description: 'Target to clear history for (e.g. "qq:group:123456"). If omitted, clears all targets.' }),
  ),
  collection: Type.Optional(
    Type.String({ description: "Only clear history for photos in this collection" }),
  ),
});

export function createPhotoResetHistoryExecute(
  store: PhotoStore,
): (_id: string, params: Record<string, unknown>) => Promise<ToolResult> {
  return async (_id, params) => {
    try {
      const target = params.target as string | undefined;
      const collection = params.collection as string | undefined;
      const cleared = store.clearHistory(target, collection);
      return textResult({
        cleared,
        target: target ?? "all",
        collection: collection ?? "all",
        message: `Cleared ${cleared} random history record(s).`,
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}
