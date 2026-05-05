// Client wrapper around the registry's /v1/quarantine/summarize endpoint.
// Defensive default: if the registry is unreachable, return a synthesized
// "suspicious" result so callers fail closed rather than open.

import type { Logger } from "pino";

export interface QuarantineResult {
  summary: string;
  flags: string[];
}

export interface QuarantineClient {
  readonly baseUrl: string;
  summarizeUntrusted(text: string): Promise<QuarantineResult>;
}

export interface QuarantineConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
}

export const QUARANTINE_FLAGS_INJECTION_LIKE = new Set<string>([
  "imperative_instruction",
  "instruction_override_attempt",
  "encoded_payload",
  "tool_directive",
  "agent_manipulation",
]);

export function flagsIndicateInjection(flags: string[]): boolean {
  return flags.some((f) => QUARANTINE_FLAGS_INJECTION_LIKE.has(f));
}

export function createQuarantineClient(config: QuarantineConfig): QuarantineClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    baseUrl,

    async summarizeUntrusted(text) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetchImpl(`${baseUrl}/v1/quarantine/summarize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          config.logger?.warn(
            { status: resp.status },
            "Quarantine call returned non-2xx; defaulting to suspicious.",
          );
          return synthesizeUnreachable();
        }

        const json = (await resp.json()) as Partial<QuarantineResult>;
        return {
          summary: typeof json.summary === "string" ? json.summary : "",
          flags: Array.isArray(json.flags)
            ? json.flags.filter((f): f is string => typeof f === "string")
            : [],
        };
      } catch (error) {
        config.logger?.warn(
          { err: error },
          "Quarantine fetch threw; defaulting to suspicious.",
        );
        return synthesizeUnreachable();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function synthesizeUnreachable(): QuarantineResult {
  return {
    summary: "(quarantine LLM unreachable — input treated as suspicious)",
    flags: ["quarantine_unreachable"],
  };
}

export const NOOP_QUARANTINE_CLIENT: QuarantineClient = {
  baseUrl: "noop://disabled",
  async summarizeUntrusted() {
    return {
      summary: "(quarantine disabled by configuration)",
      flags: ["quarantine_disabled"],
    };
  },
};
