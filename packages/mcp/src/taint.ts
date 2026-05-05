// Runtime taint tracking.
//
// Approach: every string-shaped tool output is recorded to a per-session ring
// buffer. Before invoking a tool, we scan each input string against recent
// outputs. A substring match means the input "came from" a prior tool's
// output and is therefore tainted (may carry external content).
//
// This is heuristic, not provable. It catches the common case where the host
// AI passes raw output of one tool into another. It does NOT catch:
//   - The host AI paraphrasing tainted content into "clean" prose
//   - Tainted data passed through a non-string slot (numbers, booleans)
//   - Tainted data that's been transformed before passing
//
// For v0.3 the heuristic is paired with the manifest's `tainted_ok` flag:
// inputs marked `tainted_ok: false` will be blocked with a confirmation prompt
// when tainted data is detected. False positives are caller-resolvable via the
// confirmation flow; false negatives are documented in THREAT_MODEL.md as a
// gap.

const MIN_TAINT_LENGTH = 16;
const MAX_OUTPUTS = 20;
const DEFAULT_RECORD_TTL_MS = 30 * 60 * 1000;

export interface TaintMatch {
  tainted: boolean;
  matchedTools: string[];
}

export interface TaintTracker {
  recordOutput(toolName: string, output: unknown): void;
  isTainted(value: unknown): TaintMatch;
  size(): number;
  clear(): void;
}

interface OutputRecord {
  toolName: string;
  text: string;
  recordedAt: number;
}

export interface TaintedValue<T = unknown> {
  value: T;
  tainted: boolean;
  provenance: string[];
}

export function trustedValue<T>(value: T): TaintedValue<T> {
  return { value, tainted: false, provenance: [] };
}

export function taintedValue<T>(value: T, source: string): TaintedValue<T> {
  return { value, tainted: true, provenance: [source] };
}

export function combine<T>(...values: TaintedValue<T>[]): TaintedValue<T[]> {
  return {
    value: values.map((v) => v.value),
    tainted: values.some((v) => v.tainted),
    provenance: Array.from(new Set(values.flatMap((v) => v.provenance))),
  };
}

export function createTaintTracker(
  options: { maxOutputs?: number; recordTtlMs?: number } = {},
): TaintTracker {
  const maxOutputs = options.maxOutputs ?? MAX_OUTPUTS;
  const ttlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;
  const outputs: OutputRecord[] = [];

  function evict(): void {
    const cutoff = Date.now() - ttlMs;
    while (outputs.length > 0 && outputs[0] && outputs[0].recordedAt < cutoff) {
      outputs.shift();
    }
    while (outputs.length > maxOutputs) {
      outputs.shift();
    }
  }

  return {
    recordOutput(toolName, output) {
      const text = stringify(output);
      if (text.length < MIN_TAINT_LENGTH) return;
      outputs.push({ toolName, text, recordedAt: Date.now() });
      evict();
    },

    isTainted(value) {
      evict();
      const haystack = stringify(value);
      if (haystack.length < MIN_TAINT_LENGTH) {
        return { tainted: false, matchedTools: [] };
      }

      const matches = new Set<string>();
      for (const record of outputs) {
        if (record.text.includes(haystack)) {
          matches.add(record.toolName);
        }
      }
      return {
        tainted: matches.size > 0,
        matchedTools: Array.from(matches),
      };
    },

    size() {
      return outputs.length;
    },

    clear() {
      outputs.length = 0;
    },
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function findTaintedInputs(
  args: Record<string, unknown>,
  manifestInputs: Array<{ name: string; tainted_ok?: boolean }>,
  tracker: TaintTracker,
): Array<{ inputName: string; matchedTools: string[] }> {
  const violations: Array<{ inputName: string; matchedTools: string[] }> = [];
  for (const input of manifestInputs) {
    if (input.tainted_ok) continue;
    const value = args[input.name];
    const match = tracker.isTainted(value);
    if (match.tainted) {
      violations.push({ inputName: input.name, matchedTools: match.matchedTools });
    }
  }
  return violations;
}
