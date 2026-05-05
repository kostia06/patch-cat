import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolNameCollisionError, ToolNotFoundError } from "@patch-cat/shared";
import type { ToolManifest } from "@patch-cat/shared";
import { createToolbox } from "./toolbox.js";

function makeManifest(name: string, version = "1.0.0"): ToolManifest {
  return {
    name,
    version,
    description: `Test tool ${name}`,
    inputs: [
      {
        name: "x",
        type: "string",
        description: "input",
        required: true,
        tainted_ok: false,
      },
    ],
    outputs: { type: "string" },
    capabilities: { network: false, filesystem: "none", human_confirm: false },
    runtime: { language: "python", python_version: "3.12", packages: [] },
    generated_by: "claude-opus-4-7",
    generated_at: "2026-05-04T00:00:00Z",
  };
}

const TOOL_BODY = `import json, sys

def main(x: str):
    return x.upper()

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

describe("toolbox", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchcat-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty index on first read", async () => {
    const tb = createToolbox(dir);
    const index = await tb.loadIndex();
    expect(index).toEqual({});
  });

  it("saves a tool and lists it", async () => {
    const tb = createToolbox(dir);
    const manifest = makeManifest("upper_case");
    const entry = await tb.saveTool(manifest, TOOL_BODY);
    expect(entry.name).toBe("upper_case");
    expect(entry.version).toBe("1.0.0");

    const list = await tb.listTools();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("upper_case");
  });

  it("retrieves a saved tool by name", async () => {
    const tb = createToolbox(dir);
    const manifest = makeManifest("echo");
    await tb.saveTool(manifest, TOOL_BODY);

    const fetched = await tb.getTool("echo");
    expect(fetched).not.toBeNull();
    expect(fetched?.manifest.name).toBe("echo");
    expect(fetched?.body.trim()).toBe(TOOL_BODY.trim());
  });

  it("returns null for unknown tool", async () => {
    const tb = createToolbox(dir);
    const fetched = await tb.getTool("nope");
    expect(fetched).toBeNull();
  });

  it("throws on name collision", async () => {
    const tb = createToolbox(dir);
    await tb.saveTool(makeManifest("dup"), TOOL_BODY);
    await expect(tb.saveTool(makeManifest("dup", "2.0.0"), TOOL_BODY)).rejects.toThrow(
      ToolNameCollisionError,
    );
  });

  it("removes a tool", async () => {
    const tb = createToolbox(dir);
    await tb.saveTool(makeManifest("removable"), TOOL_BODY);
    await tb.removeTool("removable");
    const list = await tb.listTools();
    expect(list).toHaveLength(0);
    const fetched = await tb.getTool("removable");
    expect(fetched).toBeNull();
  });

  it("throws when removing missing tool", async () => {
    const tb = createToolbox(dir);
    await expect(tb.removeTool("ghost")).rejects.toThrow(ToolNotFoundError);
  });

  it("persists index across instances", async () => {
    const a = createToolbox(dir);
    await a.saveTool(makeManifest("persisted"), TOOL_BODY);

    const b = createToolbox(dir);
    const list = await b.listTools();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("persisted");
  });

  it("updates lastUsedAt when marked used", async () => {
    const tb = createToolbox(dir);
    await tb.saveTool(makeManifest("metered"), TOOL_BODY);
    await tb.markUsed("metered");

    const list = await tb.listTools();
    expect(list[0]?.lastUsedAt).not.toBeNull();
  });

  it("creates expected directory layout on init", async () => {
    const tb = createToolbox(dir);
    await tb.init();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "tools"))).toBe(true);
    expect(existsSync(join(dir, "runs"))).toBe(true);
    expect(existsSync(join(dir, "index.json"))).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });
});
