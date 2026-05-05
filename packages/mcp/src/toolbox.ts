import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolNameCollisionError, ToolNotFoundError } from "@patch-cat/shared";
import {
  type ParsedTool,
  type ToolManifest,
  parseManifest,
  serializeManifest,
} from "@patch-cat/shared";
import envPaths from "env-paths";

export interface ToolEntry {
  name: string;
  version: string;
  description: string;
  filePath: string;
  embedding: number[] | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ToolIndex = Record<string, ToolEntry>;

export interface Toolbox {
  readonly rootDir: string;
  init(): Promise<void>;
  loadIndex(): Promise<ToolIndex>;
  saveTool(manifest: ToolManifest, body: string): Promise<ToolEntry>;
  listTools(): Promise<ToolEntry[]>;
  getTool(name: string): Promise<ParsedTool | null>;
  removeTool(name: string): Promise<void>;
  markUsed(name: string): Promise<void>;
}

export function createToolbox(rootDir?: string): Toolbox {
  const root = rootDir ?? envPaths("patch-cat", { suffix: "" }).config;
  const toolsDir = join(root, "tools");
  const runsDir = join(root, "runs");
  const indexPath = join(root, "index.json");
  const configPath = join(root, "config.json");

  async function ensureLayout(): Promise<void> {
    await mkdir(toolsDir, { recursive: true });
    await mkdir(runsDir, { recursive: true });
    if (!existsSync(indexPath)) {
      await writeFile(indexPath, "{}\n", "utf8");
    }
    if (!existsSync(configPath)) {
      await writeFile(configPath, "{}\n", "utf8");
    }
  }

  async function readIndex(): Promise<ToolIndex> {
    if (!existsSync(indexPath)) {
      return {};
    }
    const raw = await readFile(indexPath, "utf8");
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as ToolIndex;
      return parsed;
    } catch {
      return {};
    }
  }

  async function writeIndex(index: ToolIndex): Promise<void> {
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  function toolFilePath(name: string): string {
    return join(toolsDir, `${name}.py`);
  }

  return {
    rootDir: root,

    async init() {
      await ensureLayout();
    },

    async loadIndex() {
      await ensureLayout();
      return readIndex();
    },

    async saveTool(manifest, body) {
      await ensureLayout();
      const index = await readIndex();
      if (index[manifest.name]) {
        throw new ToolNameCollisionError(manifest.name);
      }

      const filePath = toolFilePath(manifest.name);
      const serialized = serializeManifest(manifest, body);
      await writeFile(filePath, serialized, "utf8");

      const entry: ToolEntry = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        filePath,
        embedding: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      index[manifest.name] = entry;
      await writeIndex(index);
      return entry;
    },

    async listTools() {
      await ensureLayout();
      const index = await readIndex();
      return Object.values(index);
    },

    async getTool(name) {
      await ensureLayout();
      const index = await readIndex();
      const entry = index[name];
      if (!entry) return null;
      if (!existsSync(entry.filePath)) return null;
      const source = await readFile(entry.filePath, "utf8");
      return parseManifest(source);
    },

    async removeTool(name) {
      await ensureLayout();
      const index = await readIndex();
      const entry = index[name];
      if (!entry) {
        throw new ToolNotFoundError(name);
      }
      if (existsSync(entry.filePath)) {
        await rm(entry.filePath);
      }
      delete index[name];
      await writeIndex(index);
    },

    async markUsed(name) {
      const index = await readIndex();
      const entry = index[name];
      if (!entry) return;
      entry.lastUsedAt = new Date().toISOString();
      await writeIndex(index);
    },
  };
}
