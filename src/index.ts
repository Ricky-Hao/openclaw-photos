// ── OpenClaw Photo Library plugin entry point ───────────────────────

import { join } from "node:path";
import { homedir } from "node:os";
import { openDatabase } from "./db.js";
import { PhotoStore } from "./store.js";
import {
  photoSaveParameters,
  createPhotoSaveExecute,
  photoGetParameters,
  createPhotoGetExecute,
  photoListParameters,
  createPhotoListExecute,
  photoDeleteParameters,
  createPhotoDeleteExecute,
} from "./tools.js";
import type { ToolResult } from "./tools.js";

// ── Minimal OpenClaw Plugin SDK types ───────────────────────────────

export interface PluginLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

export interface PluginServiceContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
}

interface PluginTool {
  name: string;
  description?: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

interface PluginService {
  id: string;
  start: (ctx: PluginServiceContext) => void | Promise<void>;
  stop?: (ctx: PluginServiceContext) => void | Promise<void>;
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool: (tool: PluginTool, opts?: { optional?: boolean }) => void;
  registerService: (service: PluginService) => void;
  registerHook?: (hookName: string, handler: (...args: unknown[]) => void) => void;
  registerCommand?: (...args: unknown[]) => void;
  resolvePath: (input: string) => string;
  on?: (hookName: string, handler: (...args: unknown[]) => void) => void;
}

// ── Plugin state ────────────────────────────────────────────────────

let store: PhotoStore | null = null;
let mediaTmpDir: string = "";

function ensureInit(api: OpenClawPluginApi, stateDir?: string): void {
  if (store) return;

  const resolvedStateDir = stateDir ?? join(homedir(), ".openclaw");
  const cfg = (api.pluginConfig ?? {}) as { dataDir?: string };
  const dataDir = cfg.dataDir || join(resolvedStateDir, "data", "photos");

  const dbPath = join(dataDir, "photos.db");
  const db = openDatabase(dbPath);
  store = new PhotoStore(db, join(dataDir, "images"));

  // Temp dir under /tmp/openclaw — allowed by resolveAllowedTmpMediaPath for sandbox agents
  mediaTmpDir = join("/tmp", "openclaw", "photos");

  api.logger.info(`[openclaw-photos] initialized — db=${dbPath}, tmpDir=${mediaTmpDir}`);
}

// ── Register ────────────────────────────────────────────────────────

function register(api: OpenClawPluginApi): void {
  // ── Tools ─────────────────────────────────────────────────────────

  const toolDefs: Array<{
    name: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }> = [
    {
      name: "photo_save",
      description: "Save a photo to the library with tags and collection.",
      parameters: photoSaveParameters,
      execute: async (id, params) => {
        if (!store) return { content: [{ type: "text", text: JSON.stringify({ error: "Plugin not initialized" }) }] };
        return createPhotoSaveExecute(store)(id, params);
      },
    },
    {
      name: "photo_get",
      description: "Get random photo(s) from the library, optionally filtered by collection and/or tags.",
      parameters: photoGetParameters,
      execute: async (id, params) => {
        if (!store) return { content: [{ type: "text", text: JSON.stringify({ error: "Plugin not initialized" }) }] };
        return createPhotoGetExecute(store, mediaTmpDir)(id, params);
      },
    },
    {
      name: "photo_list",
      description: "List collections and tag statistics in the photo library.",
      parameters: photoListParameters,
      execute: async (id, params) => {
        if (!store) return { content: [{ type: "text", text: JSON.stringify({ error: "Plugin not initialized" }) }] };
        return createPhotoListExecute(store)(id, params);
      },
    },
    {
      name: "photo_delete",
      description: "Delete a photo from the library by ID.",
      parameters: photoDeleteParameters,
      execute: async (id, params) => {
        if (!store) return { content: [{ type: "text", text: JSON.stringify({ error: "Plugin not initialized" }) }] };
        return createPhotoDeleteExecute(store)(id, params);
      },
    },
  ];

  for (const tool of toolDefs) {
    api.registerTool(tool);
  }

  // ── Init service ──────────────────────────────────────────────────

  api.registerService({
    id: "photos-init",
    start(ctx: PluginServiceContext) {
      ensureInit(api, ctx.stateDir);
      if (ctx.workspaceDir) {
        api.logger.info(`[openclaw-photos] workspaceDir=${ctx.workspaceDir}`);
      }
    },
  });
}

// ── Plugin definition ───────────────────────────────────────────────

const plugin = {
  id: "openclaw-photos",
  name: "OpenClaw Photo Library",
  description:
    "Tag-based photo library with collections — save, random retrieve, list, delete.",
  version: "0.1.0",
  register,
};

export default plugin;
export { register };
export { PhotoStore } from "./store.js";
