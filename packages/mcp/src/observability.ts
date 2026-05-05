// Minimal Langfuse Cloud tracer.
//
// Calls Langfuse's `/api/public/ingestion` endpoint directly via fetch instead
// of pulling in the Langfuse SDK (~100 KB transitive). For v0.4 the only
// signal we send is `generation` events around the Anthropic Opus call —
// captures cost, latency, model, input description, output token count.
// Best-effort: failures here are silently swallowed so observability never
// breaks the main flow.

import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const FLUSH_TIMEOUT_MS = 5_000;

export interface TraceGenerationInput {
  name: string;
  model: string;
  input: unknown;
  output: unknown;
  startTime: number;
  endTime: number;
  metadata?: Record<string, unknown>;
}

export interface Tracer {
  readonly enabled: boolean;
  traceGeneration(input: TraceGenerationInput): Promise<void>;
}

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createLangfuseTracer(config: LangfuseConfig): Tracer {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    enabled: true,

    async traceGeneration(input) {
      try {
        const traceId = randomUUID();
        const generationId = randomUUID();
        const now = new Date().toISOString();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);

        try {
          await fetchImpl(`${baseUrl}/api/public/ingestion`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({
              batch: [
                {
                  id: randomUUID(),
                  timestamp: now,
                  type: "trace-create",
                  body: {
                    id: traceId,
                    name: input.name,
                    metadata: input.metadata ?? {},
                  },
                },
                {
                  id: randomUUID(),
                  timestamp: now,
                  type: "generation-create",
                  body: {
                    id: generationId,
                    traceId,
                    name: input.name,
                    model: input.model,
                    input: input.input,
                    output: input.output,
                    startTime: new Date(input.startTime).toISOString(),
                    endTime: new Date(input.endTime).toISOString(),
                    metadata: input.metadata ?? {},
                  },
                },
              ],
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // best-effort; never break the main flow
      }
    },
  };
}

export const NOOP_TRACER: Tracer = {
  enabled: false,
  async traceGeneration() {
    /* noop */
  },
};
