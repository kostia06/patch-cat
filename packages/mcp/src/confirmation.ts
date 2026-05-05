// Pending-action token store, shared between taint blocking and human_confirm
// flows. Tokens are opaque, single-use, short-TTL. The host AI receives a
// confirmation_required structured response, surfaces it to the user, and
// re-invokes via patch_confirm_action(token) to actually run the call.

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;

export type ConfirmationKind = "tainted_input" | "human_confirm";

export interface PendingConfirmation {
  token: string;
  kind: ConfirmationKind;
  toolName: string;
  args: Record<string, unknown>;
  argsSummary: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConfirmationStore {
  create(input: {
    kind: ConfirmationKind;
    toolName: string;
    args: Record<string, unknown>;
    argsSummary: string;
    reason: string;
  }): PendingConfirmation;
  consume(token: string): PendingConfirmation | null;
  pendingCount(): number;
}

export function createConfirmationStore(
  options: { ttlMs?: number } = {},
): ConfirmationStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const map = new Map<string, PendingConfirmation>();

  function evict(): void {
    const now = Date.now();
    for (const [token, entry] of map.entries()) {
      if (entry.expiresAt <= now) map.delete(token);
    }
  }

  return {
    create(input) {
      evict();
      const now = Date.now();
      const token = randomBytes(24).toString("base64url");
      const entry: PendingConfirmation = {
        token,
        kind: input.kind,
        toolName: input.toolName,
        args: input.args,
        argsSummary: input.argsSummary,
        reason: input.reason,
        createdAt: now,
        expiresAt: now + ttlMs,
      };
      map.set(token, entry);
      return entry;
    },

    consume(token) {
      evict();
      const entry = map.get(token);
      if (!entry) return null;
      map.delete(token);
      if (entry.expiresAt <= Date.now()) return null;
      return entry;
    },

    pendingCount() {
      evict();
      return map.size;
    },
  };
}

export function summarizeArgs(args: Record<string, unknown>, maxLen = 200): string {
  const json = JSON.stringify(args);
  if (json.length <= maxLen) return json;
  return `${json.slice(0, maxLen - 1)}…`;
}
