import { describe, expect, it } from "vitest";
import {
  combine,
  createTaintTracker,
  findTaintedInputs,
  taintedValue,
  trustedValue,
} from "./taint.js";

describe("TaintTracker", () => {
  it("records output and detects substring matches", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "Anthropic shipped Claude 5 today and the response was overwhelming.");

    const r = tracker.isTainted("Anthropic shipped Claude 5 today");
    expect(r.tainted).toBe(true);
    expect(r.matchedTools).toContain("fetch_url");
  });

  it("returns false for too-short values to avoid false positives", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "hello world this is a long output that exceeds the threshold");

    const r = tracker.isTainted("hello");
    expect(r.tainted).toBe(false);
  });

  it("does not flag trusted user input that doesn't appear in any output", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "long content from the web that the agent fetched once");

    const r = tracker.isTainted("Please summarize this document for me, thanks!");
    expect(r.tainted).toBe(false);
  });

  it("evicts old records past TTL", () => {
    const tracker = createTaintTracker({ recordTtlMs: 10 });
    tracker.recordOutput("fetch_url", "the original output content was long enough");
    expect(tracker.size()).toBe(1);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const r = tracker.isTainted("the original output content was long enough");
        expect(r.tainted).toBe(false);
        resolve();
      }, 30);
    });
  });

  it("evicts past maxOutputs", () => {
    const tracker = createTaintTracker({ maxOutputs: 3 });
    tracker.recordOutput("a", "this is a long output number one for testing");
    tracker.recordOutput("b", "this is a long output number two for testing");
    tracker.recordOutput("c", "this is a long output number three for testing");
    tracker.recordOutput("d", "this is a long output number four for testing");
    expect(tracker.size()).toBe(3);

    const r = tracker.isTainted("this is a long output number one for testing");
    expect(r.tainted).toBe(false);
  });
});

describe("findTaintedInputs", () => {
  it("returns nothing when all inputs are tainted_ok", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "long fetched output here that is over the threshold");
    const violations = findTaintedInputs(
      { url: "long fetched output here that is over the threshold" },
      [{ name: "url", tainted_ok: true }],
      tracker,
    );
    expect(violations).toEqual([]);
  });

  it("returns violations for tainted data going into tainted_ok: false slots", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "long fetched output here that is over the threshold");
    const violations = findTaintedInputs(
      { command: "long fetched output here that is over the threshold" },
      [{ name: "command", tainted_ok: false }],
      tracker,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.inputName).toBe("command");
    expect(violations[0]?.matchedTools).toContain("fetch_url");
  });

  it("does not flag clean inputs into tainted_ok: false slots", () => {
    const tracker = createTaintTracker();
    tracker.recordOutput("fetch_url", "long fetched output here that is over the threshold");
    const violations = findTaintedInputs(
      { command: "ls -la" },
      [{ name: "command", tainted_ok: false }],
      tracker,
    );
    expect(violations).toEqual([]);
  });
});

describe("TaintedValue helpers", () => {
  it("trustedValue creates an untainted wrapper", () => {
    const v = trustedValue("hello");
    expect(v.tainted).toBe(false);
    expect(v.provenance).toEqual([]);
  });

  it("taintedValue creates a tainted wrapper with provenance", () => {
    const v = taintedValue("hello", "fetch_url");
    expect(v.tainted).toBe(true);
    expect(v.provenance).toEqual(["fetch_url"]);
  });

  it("combine taints output if any input is tainted", () => {
    const c = combine(trustedValue("a"), taintedValue("b", "fetch_url"), trustedValue("c"));
    expect(c.tainted).toBe(true);
    expect(c.value).toEqual(["a", "b", "c"]);
    expect(c.provenance).toEqual(["fetch_url"]);
  });

  it("combine stays trusted when all inputs are trusted", () => {
    const c = combine(trustedValue("a"), trustedValue("b"));
    expect(c.tainted).toBe(false);
  });
});
