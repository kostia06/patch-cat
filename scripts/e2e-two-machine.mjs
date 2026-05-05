#!/usr/bin/env node
// scripts/e2e-two-machine.mjs
// Two-machine e2e: simulate machine A (generates + contributes) and machine B
// (empty toolbox, pulls from registry).
//
// Prerequisites:
//   - registry running locally: cd packages/registry && pnpm dev
//   - .env populated with ANTHROPIC_API_KEY, E2B_API_KEY
//   - PATCH_CONTRIBUTE_TOKEN set in env (obtain by completing OAuth manually first)
//
// Usage:
//   node --env-file=.env scripts/e2e-two-machine.mjs --registry-url http://localhost:8787

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "dist", "index.js");

const args = parseArgs(process.argv.slice(2));
const registryUrl = args["registry-url"] ?? process.env.PATCH_REGISTRY_URL ?? "http://localhost:8787";
const contributeToken = process.env.PATCH_CONTRIBUTE_TOKEN;
const description = args.description ?? "Fetch a URL and return the body as a string. Input: 'url' (string).";

if (!process.env.ANTHROPIC_API_KEY || !process.env.E2B_API_KEY) {
  fail("ANTHROPIC_API_KEY and E2B_API_KEY must be set in env");
}
if (!contributeToken) {
  fail("PATCH_CONTRIBUTE_TOKEN must be set in env (run patch_auth_register first)");
}

console.log(`registry: ${registryUrl}`);
console.log(`description: ${description}`);

const dirA = await mkdtemp(join(tmpdir(), "patchcat-machineA-"));
const dirB = await mkdtemp(join(tmpdir(), "patchcat-machineB-"));
console.log(`machine A toolbox: ${dirA}`);
console.log(`machine B toolbox: ${dirB}`);

await writeConfig(dirA, {
  registry: {
    url: registryUrl,
    read_enabled: false,
    contribute_enabled: true,
    contribute_token: contributeToken,
  },
});
await writeConfig(dirB, {
  registry: {
    url: registryUrl,
    read_enabled: true,
    contribute_enabled: false,
    contribute_token: null,
  },
});

let exitCode = 0;
let machineA, machineB;

try {
  // ============================================================
  // MACHINE A: generate + contribute
  // ============================================================
  console.log("\n━━━ MACHINE A: generate + contribute ━━━");
  machineA = await spawnMcp(dirA, "machineA");

  const t0 = Date.now();
  const generated = await machineA.callTool({
    name: "patch_generate_tool",
    arguments: { description },
  });
  if (generated.isError) fail(`machine A generate failed: ${generated.content[0].text}`);
  const generatedPayload = JSON.parse(generated.content[0].text);
  console.log(
    `✓ machine A generated ${generatedPayload.name} v${generatedPayload.version} in ${Date.now() - t0}ms (source: ${generatedPayload.source})`,
  );

  if (generatedPayload.source !== "generated") {
    fail(`expected source=generated on machine A, got ${generatedPayload.source}`);
  }

  // Wait for the async contribute fire-and-forget to land.
  console.log("→ waiting 3s for async contribute to land in registry...");
  await sleep(3000);

  // Verify it's now in the registry
  const search = await fetch(
    `${registryUrl.replace(/\/$/, "")}/v1/tools/search?q=${encodeURIComponent(description.slice(0, 80))}&limit=10`,
  );
  if (!search.ok) fail(`registry search failed: ${search.status}`);
  const searchBody = await search.json();
  const found = searchBody.results.find((r) => r.name === generatedPayload.name);
  if (!found) {
    fail(`tool ${generatedPayload.name} not found in registry search after contribute`);
  }
  console.log(
    `✓ ${generatedPayload.name} appears in registry search (similarity=${found.similarity?.toFixed(3)})`,
  );

  await machineA.close();
  console.log("✓ machine A session closed");

  // ============================================================
  // MACHINE B: search + pull
  // ============================================================
  console.log("\n━━━ MACHINE B: search + pull ━━━");
  machineB = await spawnMcp(dirB, "machineB");

  const t1 = Date.now();
  const pulled = await machineB.callTool({
    name: "patch_generate_tool",
    arguments: { description },
  });
  if (pulled.isError) fail(`machine B generate failed: ${pulled.content[0].text}`);
  const pulledPayload = JSON.parse(pulled.content[0].text);
  console.log(
    `✓ machine B got ${pulledPayload.name} v${pulledPayload.version} in ${Date.now() - t1}ms (source: ${pulledPayload.source})`,
  );

  if (pulledPayload.source !== "registry") {
    fail(
      `expected machine B to PULL from registry, got source=${pulledPayload.source}. Check similarity threshold.`,
    );
  }

  if (pulledPayload.name !== generatedPayload.name) {
    fail(
      `machine B pulled ${pulledPayload.name}, but machine A contributed ${generatedPayload.name}`,
    );
  }

  // Run the pulled tool to confirm it actually works
  console.log(`→ machine B invoking ${pulledPayload.name}...`);
  const tools = await machineB.listTools();
  const tool = tools.tools.find((t) => t.name === pulledPayload.name);
  const argName = Object.keys(tool?.inputSchema?.properties ?? {})[0];
  const invoked = await machineB.callTool({
    name: pulledPayload.name,
    arguments: { [argName]: "https://example.com" },
  });
  if (invoked.isError) fail(`pulled tool failed: ${invoked.content[0].text}`);
  const result = JSON.parse(invoked.content[0].text);
  const haystack = typeof result === "string" ? result : JSON.stringify(result);
  if (!haystack.includes("Example Domain")) {
    fail(`pulled tool ran but output didn't contain 'Example Domain'`);
  }
  console.log(`✓ pulled tool ran successfully`);

  console.log("\n══════════════════════════════════════");
  console.log("  PASSED — two-machine flow works end-to-end");
  console.log("══════════════════════════════════════");
} catch (error) {
  console.log("\n══════════════════════════════════════");
  console.log("  FAILED");
  console.log("══════════════════════════════════════");
  console.error(error);
  exitCode = 1;
} finally {
  await machineA?.close().catch(() => {});
  await machineB?.close().catch(() => {});
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}

process.exit(exitCode);

async function spawnMcp(toolboxDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: {
      ...process.env,
      PATCH_CAT_TOOLBOX_DIR: toolboxDir,
      LOG_LEVEL: "warn",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `e2e-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function writeConfig(dir, config) {
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
