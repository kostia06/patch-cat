import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RegistryConfig {
  url: string;
  read_enabled: boolean;
  contribute_enabled: boolean;
  contribute_token: string | null;
}

export interface PatchConfig {
  registry: RegistryConfig;
}

export const DEFAULT_REGISTRY_URL = "https://registry.patch-cat.com";

export const DEFAULT_CONFIG: PatchConfig = {
  registry: {
    url: DEFAULT_REGISTRY_URL,
    read_enabled: true,
    contribute_enabled: false,
    contribute_token: null,
  },
};

function configPath(toolboxDir: string): string {
  return join(toolboxDir, "config.json");
}

export async function loadConfig(toolboxDir: string): Promise<PatchConfig> {
  const path = configPath(toolboxDir);
  if (!existsSync(path)) {
    return clone(DEFAULT_CONFIG);
  }
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return clone(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw) as Partial<PatchConfig>;
    return mergeConfig(parsed);
  } catch {
    return clone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(toolboxDir: string, config: PatchConfig): Promise<void> {
  const path = configPath(toolboxDir);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function mergeConfig(partial: Partial<PatchConfig>): PatchConfig {
  return {
    registry: {
      ...DEFAULT_CONFIG.registry,
      ...(partial.registry ?? {}),
    },
  };
}

function clone(config: PatchConfig): PatchConfig {
  return JSON.parse(JSON.stringify(config)) as PatchConfig;
}
