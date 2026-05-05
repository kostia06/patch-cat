#!/usr/bin/env node
// Live end-to-end verification: real Anthropic + real e2b + real subprocess MCP.
// Usage: node --env-file=.env scripts/verify-e2e.mjs

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN = join(REPO_ROOT, "dist", "index.js");

const required = ["ANTHROPIC_API_KEY", "E2B_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FAIL: ${key} not set. Run with: node --env-file=.env scripts/verify-e2e.mjs`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  E2B_API_KEY: process.env.E2B_API_KEY,
  LOG_LEVEL: "warn",
};

function step(message) {
  process.stdout.write(`${message}\n`);
}

async function spawnSession(toolboxDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...env, PATCH_CAT_TOOLBOX_DIR: toolboxDir },
    stderr: "pipe",
  });

  const client = new Client(
    { name: `verify-e2e-${label}`, version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

async function main() {
  const toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-e2e-"));
  step(`tmp toolbox: ${toolboxDir}`);

  let exitCode = 0;
  try {
    // ============================================================
    // SESSION 1: generate, register, call
    // ============================================================
    step("→ session 1: spawning bin");
    const { client } = await spawnSession(toolboxDir, "s1");

    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount += 1;
      step(`✓ received notifications/tools/list_changed (#${listChangedCount})`);
    });

    const initial = await client.listTools();
    const initialNames = initial.tools.map((t) => t.name).sort();
    const expectedMeta = [
      "patch_auth_register",
      "patch_auth_status",
      "patch_confirm_action",
      "patch_generate_tool",
      "patch_list_runs",
      "patch_list_tools",
      "patch_replay",
      "patch_run_tool",
    ];
    if (JSON.stringify(initialNames) !== JSON.stringify(expectedMeta)) {
      throw new Error(`expected ${expectedMeta.join(",")}, got ${initialNames.join(",")}`);
    }
    step(`✓ initial tool list: 8 meta-tools`);

    step("→ calling patch_generate_tool (real Anthropic call, ~10-30s)…");
    const t0 = Date.now();
    const generated = await client.callTool({
      name: "patch_generate_tool",
      arguments: {
        description:
          "Fetch a URL via HTTP GET and return the response body as a string. " +
          "Takes one input named 'url' (string).",
      },
    });
    step(`✓ patch_generate_tool returned in ${Date.now() - t0}ms`);

    if (generated.isError) {
      const errText = generated.content?.[0]?.text ?? "<no error text>";
      throw new Error(`patch_generate_tool errored: ${errText}`);
    }

    const payload = JSON.parse(generated.content[0].text);
    const toolName = payload.name;
    if (!toolName || payload.status !== "created") {
      throw new Error(`unexpected payload: ${JSON.stringify(payload)}`);
    }
    step(`✓ generated tool: ${toolName} v${payload.version}`);

    // Wait briefly for notification propagation
    await new Promise((r) => setTimeout(r, 200));
    if (listChangedCount < 1) {
      throw new Error("expected ≥1 list_changed notification, got 0");
    }

    const after = await client.listTools();
    const myTool = after.tools.find((t) => t.name === toolName);
    if (!myTool) {
      throw new Error(`generated tool ${toolName} not in tools/list`);
    }
    step(`✓ ${toolName} appears in tools/list`);

    const props = myTool.inputSchema.properties ?? {};
    const argName = Object.keys(props)[0];
    if (!argName) {
      throw new Error(`tool ${toolName} has no input properties`);
    }
    step(`✓ tool input arg: ${argName}`);

    step(`→ calling ${toolName}({${argName}: "https://example.com"}) (real e2b sandbox, ~30-90s)…`);
    const t1 = Date.now();
    const invoked = await client.callTool({
      name: toolName,
      arguments: { [argName]: "https://example.com" },
    });
    step(`✓ tool invocation returned in ${Date.now() - t1}ms`);

    if (invoked.isError) {
      const errText = invoked.content?.[0]?.text ?? "<no error text>";
      throw new Error(`tool invocation errored: ${errText}`);
    }

    const resultText = invoked.content[0].text;
    const result = JSON.parse(resultText);
    const haystack = typeof result === "string" ? result : JSON.stringify(result);
    if (!haystack.includes("Example Domain")) {
      throw new Error(
        `expected 'Example Domain' in output. First 300 chars: ${haystack.slice(0, 300)}`,
      );
    }
    step(`✓ output contains 'Example Domain'`);

    const indexPath = join(toolboxDir, "index.json");
    const indexContent = await readFile(indexPath, "utf8");
    const index = JSON.parse(indexContent);
    if (!index[toolName]) {
      throw new Error(`tool ${toolName} not in ${indexPath}`);
    }
    step(`✓ tool persisted to disk: ${indexPath}`);

    await client.close();
    step("✓ session 1 closed cleanly");

    // ============================================================
    // SESSION 2: verify persistence across restart
    // ============================================================
    step("→ session 2: spawning bin again to verify persistence");
    const { client: client2 } = await spawnSession(toolboxDir, "s2");

    const reloaded = await client2.listTools();
    const reloadedNames = reloaded.tools.map((t) => t.name);
    if (!reloadedNames.includes(toolName)) {
      throw new Error(`tool ${toolName} did not survive restart. Got: ${reloadedNames.join(",")}`);
    }
    step(`✓ ${toolName} persists across restart`);

    // Smoke test: call patch_list_tools to confirm dynamic re-registration
    const listed = await client2.callTool({
      name: "patch_list_tools",
      arguments: {},
    });
    const listedPayload = JSON.parse(listed.content[0].text);
    if (!Array.isArray(listedPayload) || !listedPayload.some((t) => t.name === toolName)) {
      throw new Error("patch_list_tools did not return the persisted tool");
    }
    step(`✓ patch_list_tools returns the persisted tool`);

    await client2.close();
    step("✓ session 2 closed cleanly");

    step("");
    step("══════════════════════════════════════");
    step("  PASSED — Phase 1 verified end-to-end");
    step("══════════════════════════════════════");
  } catch (error) {
    step("");
    step("══════════════════════════════════════");
    step("  FAILED");
    step("══════════════════════════════════════");
    console.error(error);
    exitCode = 1;
  } finally {
    await rm(toolboxDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main();
