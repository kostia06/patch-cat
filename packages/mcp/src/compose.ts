// Tool composition / workflows.
//
// `patch_compose` lets the host AI wire existing tools into a multi-step DAG
// without generating a new monolithic tool. Each step still flows through the
// full safety pipeline (sanitizer → quarantine → taint check → confirmation
// gate → sandbox), so composition cannot bypass any defense.
//
// Step args may reference prior step results via `$<step_id>` or
// `$<step_id>.<json_path>` strings. Resolution happens immediately before the
// step is invoked, against the live result map.
//
// If any step returns a `confirmation_required` object, the workflow halts and
// surfaces that confirmation up — the host AI must collect user approval and
// re-run the workflow, exactly as it would for a single tool call. There is no
// "approve all steps" shortcut by design.

import { PatchError } from "@patch-cat/shared";

export type OnError = "abort" | "continue";

export interface ComposeStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  on_error?: OnError;
  retries?: number;
}

export interface ComposeRequest {
  steps: ComposeStep[];
  on_error?: OnError;
  parallel?: boolean;
}

export interface ComposeStepResult {
  id: string;
  tool: string;
  status: "ok" | "skipped" | "error" | "paused";
  result?: unknown;
  error?: { name: string; message: string };
  attempts: number;
  duration_ms: number;
}

export interface ComposeResponse {
  status: "ok" | "paused" | "partial" | "failed";
  steps: ComposeStepResult[];
  results: Record<string, unknown>;
  paused?: unknown;
}

const STEP_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const REF_PATTERN = /\$([a-zA-Z][a-zA-Z0-9_]*)((?:\.[a-zA-Z0-9_]+)*)/g;

export interface ComposeDeps {
  invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function validateRequest(req: ComposeRequest): void {
  if (!Array.isArray(req.steps) || req.steps.length === 0) {
    throw new PatchError("compose: `steps` must be a non-empty array.");
  }
  if (req.steps.length > 32) {
    throw new PatchError("compose: maximum 32 steps per workflow.");
  }
  const seen = new Set<string>();
  for (const step of req.steps) {
    if (!step.id || !STEP_ID_REGEX.test(step.id)) {
      throw new PatchError(
        `compose: step id "${step.id ?? "(missing)"}" must match ${STEP_ID_REGEX} (alphanumeric + underscore, leading letter).`,
      );
    }
    if (seen.has(step.id)) {
      throw new PatchError(`compose: duplicate step id "${step.id}".`);
    }
    seen.add(step.id);
    if (typeof step.tool !== "string" || step.tool.length === 0) {
      throw new PatchError(`compose: step "${step.id}" is missing required \`tool\`.`);
    }
    if (step.args !== undefined && (typeof step.args !== "object" || step.args === null)) {
      throw new PatchError(`compose: step "${step.id}" \`args\` must be an object.`);
    }
  }

  if (req.parallel) {
    // Parallel mode forbids inter-step references — every step's args are
    // resolved against the *initial* (empty) result map. This keeps the
    // execution model unambiguous: parallel = independent.
    for (const step of req.steps) {
      const refs = collectReferences(step.args ?? {});
      if (refs.length > 0) {
        throw new PatchError(
          `compose: step "${step.id}" references ${refs.join(", ")}, but parallel mode forbids inter-step references. Use sequential mode (parallel: false) or remove the references.`,
        );
      }
    }
  } else {
    // Sequential: a step may only reference earlier steps.
    const earlier = new Set<string>();
    for (const step of req.steps) {
      const refs = collectReferences(step.args ?? {});
      for (const ref of refs) {
        if (!earlier.has(ref)) {
          throw new PatchError(
            `compose: step "${step.id}" references "$${ref}" which is not an earlier step id.`,
          );
        }
      }
      earlier.add(step.id);
    }
  }
}

export async function executeCompose(
  req: ComposeRequest,
  deps: ComposeDeps,
): Promise<ComposeResponse> {
  validateRequest(req);

  const results: Record<string, unknown> = {};
  const stepResults: ComposeStepResult[] = [];
  const defaultOnError: OnError = req.on_error ?? "abort";

  if (req.parallel) {
    const settled = await Promise.allSettled(
      req.steps.map((step) => runOne(step, results, deps, defaultOnError)),
    );
    let pausedAt: ComposeStepResult | undefined;
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const step = req.steps[i];
      if (!step || !outcome) continue;
      if (outcome.status === "fulfilled") {
        const sr = outcome.value;
        stepResults.push(sr);
        if (sr.status === "ok") results[sr.id] = sr.result;
        if (sr.status === "paused" && !pausedAt) pausedAt = sr;
      } else {
        stepResults.push({
          id: step.id,
          tool: step.tool,
          status: "error",
          error: errorToShape(outcome.reason),
          attempts: 1,
          duration_ms: 0,
        });
      }
    }
    return summarize(stepResults, results, pausedAt);
  }

  // Sequential.
  for (const step of req.steps) {
    const sr = await runOne(step, results, deps, defaultOnError);
    stepResults.push(sr);
    if (sr.status === "ok") {
      results[sr.id] = sr.result;
      continue;
    }
    if (sr.status === "paused") {
      return summarize(stepResults, results, sr);
    }
    if (sr.status === "error") {
      const onError = step.on_error ?? defaultOnError;
      if (onError === "abort") {
        return summarize(stepResults, results);
      }
      // continue: fall through, no result recorded for this step.
    }
  }

  return summarize(stepResults, results);
}

async function runOne(
  step: ComposeStep,
  results: Record<string, unknown>,
  deps: ComposeDeps,
  defaultOnError: OnError,
): Promise<ComposeStepResult> {
  const maxAttempts = Math.max(1, Math.min(step.retries ?? 0, 3) + 1);
  const start = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveReferences(step.args ?? {}, results) as Record<string, unknown>;
    } catch (error) {
      return {
        id: step.id,
        tool: step.tool,
        status: "error",
        error: errorToShape(error),
        attempts: attempt,
        duration_ms: Date.now() - start,
      };
    }

    try {
      const value = await deps.invokeTool(step.tool, resolvedArgs);
      if (isConfirmationRequired(value)) {
        return {
          id: step.id,
          tool: step.tool,
          status: "paused",
          result: value,
          attempts: attempt,
          duration_ms: Date.now() - start,
        };
      }
      return {
        id: step.id,
        tool: step.tool,
        status: "ok",
        result: value,
        attempts: attempt,
        duration_ms: Date.now() - start,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) continue;
    }
  }

  // Exhausted retries.
  void defaultOnError; // surface-only flag; abort vs continue is decided by caller
  return {
    id: step.id,
    tool: step.tool,
    status: "error",
    error: errorToShape(lastError),
    attempts: maxAttempts,
    duration_ms: Date.now() - start,
  };
}

function summarize(
  steps: ComposeStepResult[],
  results: Record<string, unknown>,
  paused?: ComposeStepResult,
): ComposeResponse {
  if (paused) {
    return {
      status: "paused",
      steps,
      results,
      paused: paused.result,
    };
  }
  const anyError = steps.some((s) => s.status === "error");
  const allOk = steps.every((s) => s.status === "ok");
  if (allOk) return { status: "ok", steps, results };
  if (anyError && steps.some((s) => s.status === "ok")) {
    return { status: "partial", steps, results };
  }
  return { status: "failed", steps, results };
}

export function collectReferences(value: unknown, acc: Set<string> = new Set()): string[] {
  if (typeof value === "string") {
    REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null = REF_PATTERN.exec(value);
    while (match !== null) {
      const id = match[1];
      if (id) acc.add(id);
      match = REF_PATTERN.exec(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectReferences(v, acc);
    }
  }
  return Array.from(acc);
}

export function resolveReferences(value: unknown, results: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return resolveStringReferences(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, results));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveReferences(v, results);
    }
    return out;
  }
  return value;
}

function resolveStringReferences(input: string, results: Record<string, unknown>): unknown {
  // Whole-string reference: replace with the raw resolved value (preserves
  // type — object/array/number stay themselves rather than becoming JSON).
  const wholeMatch = input.match(/^\$([a-zA-Z][a-zA-Z0-9_]*)((?:\.[a-zA-Z0-9_]+)*)$/);
  if (wholeMatch) {
    const id = wholeMatch[1];
    const path = wholeMatch[2] ?? "";
    if (!id) return input;
    return resolvePath(results, id, path);
  }

  // Embedded reference: stringify each ref in place. Only sensible for string
  // values, e.g. "Hello $step1.name".
  REF_PATTERN.lastIndex = 0;
  return input.replace(REF_PATTERN, (_, id: string, path: string) => {
    const resolved = resolvePath(results, id, path ?? "");
    if (typeof resolved === "string") return resolved;
    return JSON.stringify(resolved);
  });
}

function resolvePath(results: Record<string, unknown>, id: string, path: string): unknown {
  if (!(id in results)) {
    throw new PatchError(`compose: cannot resolve $${id} — step "${id}" has no recorded result.`);
  }
  let cursor: unknown = results[id];
  if (!path) return cursor;
  const segments = path.replace(/^\./, "").split(".").filter(Boolean);
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      throw new PatchError(
        `compose: cannot read .${segment} of $${id}${path} — intermediate value is null/undefined.`,
      );
    }
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
      cursor = cursor[Number(segment)];
      continue;
    }
    if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
      continue;
    }
    throw new PatchError(
      `compose: cannot read .${segment} of $${id}${path} — value is a ${typeof cursor}.`,
    );
  }
  return cursor;
}

function isConfirmationRequired(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const status = (value as Record<string, unknown>).status;
  return status === "confirmation_required" || status === "external_auth_required";
}

function errorToShape(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}
