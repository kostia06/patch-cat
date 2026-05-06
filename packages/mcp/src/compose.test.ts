import { describe, expect, it, vi } from "vitest";
import {
  collectReferences,
  executeCompose,
  resolveReferences,
  validateRequest,
} from "./compose.js";

describe("collectReferences", () => {
  it("finds references in nested structures", () => {
    const refs = collectReferences({
      a: "$step1",
      b: ["$step2.foo", "literal", "embedded $step3.bar string"],
      c: { nested: "$step4" },
    });
    expect(refs.sort()).toEqual(["step1", "step2", "step3", "step4"]);
  });

  it("returns empty for ref-less values", () => {
    expect(collectReferences({ a: "literal", b: 42, c: true })).toEqual([]);
  });
});

describe("resolveReferences", () => {
  const results = {
    step1: { name: "Alice", scores: [10, 20, 30] },
    step2: "raw text output",
    step3: 42,
  };

  it("replaces a whole-string reference with the raw value (preserves type)", () => {
    expect(resolveReferences("$step1", results)).toEqual({ name: "Alice", scores: [10, 20, 30] });
    expect(resolveReferences("$step3", results)).toBe(42);
  });

  it("walks dotted paths into objects and arrays", () => {
    expect(resolveReferences("$step1.name", results)).toBe("Alice");
    expect(resolveReferences("$step1.scores.1", results)).toBe(20);
  });

  it("stringifies embedded references inside larger strings", () => {
    expect(resolveReferences("Hello $step1.name, you have $step3 points", results)).toBe(
      "Hello Alice, you have 42 points",
    );
  });

  it("recurses into nested objects and arrays", () => {
    const resolved = resolveReferences(
      { greeting: "Hello $step1.name", scores: ["$step1.scores.0", "$step3"] },
      results,
    );
    expect(resolved).toEqual({
      greeting: "Hello Alice",
      scores: [10, 42],
    });
  });

  it("throws when a referenced step is missing", () => {
    expect(() => resolveReferences("$missing", results)).toThrow(/cannot resolve \$missing/);
  });

  it("throws on out-of-bounds path traversal", () => {
    expect(() => resolveReferences("$step3.foo", results)).toThrow(/cannot read .foo/);
  });
});

describe("validateRequest", () => {
  it("rejects empty steps", () => {
    expect(() => validateRequest({ steps: [] })).toThrow(/non-empty array/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      validateRequest({
        steps: [
          { id: "a", tool: "x", args: {} },
          { id: "a", tool: "y", args: {} },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });

  it("rejects forward references in sequential mode", () => {
    expect(() =>
      validateRequest({
        steps: [
          { id: "first", tool: "x", args: { value: "$second" } },
          { id: "second", tool: "y", args: {} },
        ],
      }),
    ).toThrow(/not an earlier step id/);
  });

  it("rejects any inter-step reference in parallel mode", () => {
    expect(() =>
      validateRequest({
        parallel: true,
        steps: [
          { id: "a", tool: "x", args: { v: "$b" } },
          { id: "b", tool: "y", args: {} },
        ],
      }),
    ).toThrow(/parallel mode forbids inter-step references/);
  });
});

describe("executeCompose — sequential", () => {
  it("runs steps in order and threads results", async () => {
    const invokeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "double") return { value: (args.value as number) * 2 };
      if (name === "stringify") return `result=${(args.value as { value: number }).value}`;
      throw new Error(`unknown tool ${name}`);
    });

    const response = await executeCompose(
      {
        steps: [
          { id: "a", tool: "double", args: { value: 5 } },
          { id: "b", tool: "stringify", args: { value: "$a" } },
        ],
      },
      { invokeTool },
    );

    expect(response.status).toBe("ok");
    expect(response.results).toEqual({
      a: { value: 10 },
      b: "result=10",
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenNthCalledWith(2, "stringify", { value: { value: 10 } });
  });

  it("aborts on error by default", async () => {
    const invokeTool = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(3);

    const response = await executeCompose(
      {
        steps: [
          { id: "a", tool: "x", args: {} },
          { id: "b", tool: "y", args: {} },
          { id: "c", tool: "z", args: {} },
        ],
      },
      { invokeTool },
    );

    expect(response.status).toBe("partial");
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(response.steps[1]?.status).toBe("error");
    expect(response.steps[2]).toBeUndefined();
  });

  it("continues past errors when on_error: continue", async () => {
    const invokeTool = vi
      .fn()
      .mockResolvedValueOnce("ok1")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok3");

    const response = await executeCompose(
      {
        on_error: "continue",
        steps: [
          { id: "a", tool: "x", args: {} },
          { id: "b", tool: "y", args: {} },
          { id: "c", tool: "z", args: {} },
        ],
      },
      { invokeTool },
    );

    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(response.status).toBe("partial");
    expect(response.results).toEqual({ a: "ok1", c: "ok3" });
  });

  it("retries failing steps up to step.retries", async () => {
    const invokeTool = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("finally");

    const response = await executeCompose(
      {
        steps: [{ id: "a", tool: "x", args: {}, retries: 2 }],
      },
      { invokeTool },
    );

    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(response.status).toBe("ok");
    expect(response.results.a).toBe("finally");
  });

  it("pauses the workflow on confirmation_required", async () => {
    const pauseValue = {
      status: "confirmation_required",
      kind: "tainted_input",
      tool: "z",
      confirmation_token: "tok-123",
    };
    const invokeTool = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce(pauseValue);

    const response = await executeCompose(
      {
        steps: [
          { id: "a", tool: "x", args: {} },
          { id: "b", tool: "y", args: {} },
          { id: "c", tool: "z", args: {} },
        ],
      },
      { invokeTool },
    );

    expect(response.status).toBe("paused");
    expect(response.paused).toEqual(pauseValue);
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(response.steps).toHaveLength(2);
  });
});

describe("executeCompose — parallel", () => {
  it("runs all steps concurrently", async () => {
    const order: string[] = [];
    const invokeTool = vi.fn(async (name: string) => {
      await new Promise((r) => setTimeout(r, name === "slow" ? 20 : 5));
      order.push(name);
      return name;
    });

    const response = await executeCompose(
      {
        parallel: true,
        steps: [
          { id: "a", tool: "fast", args: {} },
          { id: "b", tool: "slow", args: {} },
          { id: "c", tool: "fast", args: {} },
        ],
      },
      { invokeTool },
    );

    expect(response.status).toBe("ok");
    expect(invokeTool).toHaveBeenCalledTimes(3);
    expect(order[order.length - 1]).toBe("slow");
  });
});
