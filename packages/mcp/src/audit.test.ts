import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_SCHEMA_VERSION, createAuditWriter, sha256 } from "./audit.js";

describe("AuditWriter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchcat-audit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function baseInput() {
    return {
      toolName: "fetch_url",
      toolVersion: "1.0.0",
      toolSource: "# ---\n# name: fetch_url\n# ---\nimport json, sys\ndef main(url): return ''",
      capabilities: { network: true, filesystem: "none" as const, human_confirm: false },
      packagesInstalled: ["requests==2.32.3"],
      allowInternetAccess: true,
      envsKeys: [],
      trigger: {
        host_app: "claude-desktop",
        mcp_client_name: "claude-desktop",
        user_prompt_hash: null,
      },
      inputs: { url: "https://example.com" },
      output: "<html>...</html>",
      stdout: '"<html>...</html>"\n',
      stderr: "",
      exitCode: 0,
      durationMs: 743,
    };
  }

  it("writes a blob and round-trips it", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    const blob = await writer.recordRun(baseInput());

    expect(blob.schema_version).toBe(AUDIT_SCHEMA_VERSION);
    expect(blob.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(blob.tool.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blob.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(blob.stderr_sha256).toMatch(/^[0-9a-f]{64}$/);

    const reread = await writer.loadBlob(blob.run_id);
    expect(reread).toEqual(blob);
  });

  it("content-addresses stdout/stderr by sha256 (dedupes equal payloads)", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    const a = await writer.recordRun(baseInput());
    const b = await writer.recordRun(baseInput());

    expect(a.run_id).not.toBe(b.run_id);
    expect(a.stdout_sha256).toBe(b.stdout_sha256);

    const stdoutContent = await writer.loadBlobByContent("stdout", a.stdout_sha256);
    expect(stdoutContent).toBe(baseInput().stdout);
  });

  it("returns null for unknown run_id", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    expect(await writer.loadBlob("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("never logs env values, only keys", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    const input = baseInput();
    input.envsKeys = ["PATCH_ACCESS_TOKEN", "OTHER_SECRET"];
    const blob = await writer.recordRun(input);

    expect(blob.sandbox.envs_keys).toEqual(["PATCH_ACCESS_TOKEN", "OTHER_SECRET"]);
    const json = JSON.stringify(blob);
    expect(json).not.toContain("very-secret");
  });

  it("includes capability assertions describing what was enforced", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    const input = baseInput();
    input.capabilities = { network: false, filesystem: "read-only", human_confirm: false };
    input.allowInternetAccess = false;
    const blob = await writer.recordRun(input);

    expect(
      blob.capability_assertions.some(
        (s) => s.includes("network: false") && s.includes("enforced"),
      ),
    ).toBe(true);
    expect(blob.capability_assertions.some((s) => s.includes("filesystem"))).toBe(true);
  });

  it("writes blob to <toolboxDir>/runs/<run_id>.json on disk", async () => {
    const writer = createAuditWriter({ toolboxDir: dir });
    const blob = await writer.recordRun(baseInput());
    const blobPath = join(dir, "runs", `${blob.run_id}.json`);
    expect(existsSync(blobPath)).toBe(true);
    const fileContent = await readFile(blobPath, "utf8");
    expect(JSON.parse(fileContent)).toEqual(blob);
  });
});

describe("sha256 helper", () => {
  it("produces deterministic 64-char hex", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});
