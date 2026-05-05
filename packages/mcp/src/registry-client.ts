import {
  type ContributeToolResponse,
  type RegistryToolEntry,
  type RegistryToolVersion,
  type ToolManifest,
} from "@patch-cat/shared";
import type { Logger } from "pino";

export interface RegistryClientConfig {
  baseUrl: string;
  contributeToken?: string | null;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface RecordedRun {
  version: string;
  success: boolean;
  duration_ms: number;
  error_class?: string;
}

export interface RegistryClient {
  searchTools(description: string, limit?: number): Promise<RegistryToolEntry[]>;
  fetchTool(name: string, version?: string): Promise<{ manifest: ToolManifest; source: string }>;
  contributeTool(manifest: ToolManifest, source: string): Promise<ContributeToolResponse>;
  recordRun(name: string, run: RecordedRun): Promise<void>;
  readonly baseUrl: string;
}

export class RegistryHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RegistryHttpError";
  }
}

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string };
}

export function createRegistryClient(config: RegistryClientConfig): RegistryClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const log = config.logger;

  async function request<T>(
    path: string,
    init: RequestInit & { authed?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (init.authed) {
      if (!config.contributeToken) {
        throw new RegistryHttpError(401, "missing_token", "Contribute token not configured.");
      }
      headers.set("Authorization", `Bearer ${config.contributeToken}`);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      let envelope: ApiErrorEnvelope = {};
      try {
        envelope = (await response.json()) as ApiErrorEnvelope;
      } catch {
        // body wasn't JSON
      }
      const code = envelope.error?.code ?? `http_${response.status}`;
      const message = envelope.error?.message ?? response.statusText;
      throw new RegistryHttpError(response.status, code, message);
    }

    return (await response.json()) as T;
  }

  return {
    baseUrl,

    async searchTools(description, limit = 10) {
      const params = new URLSearchParams({ q: description, limit: String(limit) });
      const json = await request<{ results: RegistryToolEntry[] }>(
        `/v1/tools/search?${params.toString()}`,
      );
      return json.results;
    },

    async fetchTool(name, version) {
      const path = version
        ? `/v1/tools/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
        : `/v1/tools/${encodeURIComponent(name)}`;
      const meta = await request<RegistryToolVersion>(path);

      const sourceResp = await fetchImpl(meta.source_url);
      if (!sourceResp.ok) {
        throw new RegistryHttpError(
          sourceResp.status,
          "source_fetch_failed",
          `Failed to fetch tool source from ${meta.source_url}`,
        );
      }
      const source = await sourceResp.text();
      return { manifest: meta.manifest, source };
    },

    async contributeTool(manifest, source) {
      return request<ContributeToolResponse>(`/v1/tools`, {
        method: "POST",
        body: JSON.stringify({ manifest, source }),
        authed: true,
      });
    },

    async recordRun(name, run) {
      try {
        await request<{ status: string }>(`/v1/tools/${encodeURIComponent(name)}/runs`, {
          method: "POST",
          body: JSON.stringify(run),
        });
      } catch (error) {
        // recordRun is fire-and-forget; never throw to caller.
        log?.debug({ err: error, tool: name }, "recordRun failed (ignored)");
      }
    },
  };
}

export const NOOP_REGISTRY_CLIENT: RegistryClient = {
  baseUrl: "noop://disabled",
  async searchTools() {
    return [];
  },
  async fetchTool() {
    throw new RegistryHttpError(503, "disabled", "Registry is disabled.");
  },
  async contributeTool() {
    throw new RegistryHttpError(503, "disabled", "Registry is disabled.");
  },
  async recordRun() {
    /* noop */
  },
};
