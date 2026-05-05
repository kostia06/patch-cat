import { describe, expect, it } from "vitest";
import { createConfirmationStore, summarizeArgs } from "./confirmation.js";

describe("ConfirmationStore", () => {
  it("creates a token, returns it on consume, and deletes after", () => {
    const store = createConfirmationStore();
    const pending = store.create({
      kind: "tainted_input",
      toolName: "send_email",
      args: { to: "alice@example.com" },
      argsSummary: "to=alice@example.com",
      reason: "tainted",
    });
    expect(pending.token).toBeTruthy();
    expect(store.pendingCount()).toBe(1);

    const consumed = store.consume(pending.token);
    expect(consumed?.toolName).toBe("send_email");
    expect(consumed?.args.to).toBe("alice@example.com");

    expect(store.consume(pending.token)).toBeNull();
    expect(store.pendingCount()).toBe(0);
  });

  it("returns null for unknown token", () => {
    const store = createConfirmationStore();
    expect(store.consume("does-not-exist")).toBeNull();
  });

  it("expires tokens past TTL", async () => {
    const store = createConfirmationStore({ ttlMs: 10 });
    const pending = store.create({
      kind: "human_confirm",
      toolName: "delete_repo",
      args: {},
      argsSummary: "{}",
      reason: "irreversible",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(store.consume(pending.token)).toBeNull();
  });

  it("tokens are unique across creations", () => {
    const store = createConfirmationStore();
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = store.create({
        kind: "tainted_input",
        toolName: "x",
        args: {},
        argsSummary: "{}",
        reason: "r",
      });
      tokens.add(p.token);
    }
    expect(tokens.size).toBe(50);
  });
});

describe("summarizeArgs", () => {
  it("returns full JSON if under maxLen", () => {
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
  });

  it("truncates with ellipsis past maxLen", () => {
    const args = { msg: "x".repeat(500) };
    const summary = summarizeArgs(args, 80);
    expect(summary.length).toBe(80);
    expect(summary.endsWith("…")).toBe(true);
  });
});
