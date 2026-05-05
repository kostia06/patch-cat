#!/usr/bin/env node
// scripts/auth-bootstrap.mjs
// One-shot helper: point the local Patch toolbox at a registry URL, drive
// patch_auth_register over MCP stdio, capture the token, and write it to .env
// as PATCH_CONTRIBUTE_TOKEN. Used to bootstrap the contribute_token without
// requiring a Claude Code session restart.
//
// Usage:
//   node --env-file=.env scripts/auth-bootstrap.mjs \
//     --registry-url https://patchcat-registry-dev.<acct>.workers.dev
//
// The user must complete the GitHub OAuth flow in their browser when prompted.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import envPaths from "env-paths";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "dist", "index.js");
const ENV_FILE = join(REPO_ROOT, ".env");

const args = parseArgs(process.argv.slice(2));
const registryUrl = args["registry-url"];
if (!registryUrl) {
  fail("Missing --registry-url <url>");
}

const required = ["ANTHROPIC_API_KEY", "E2B_API_KEY"];
for (const key of required) {
  if (!process.env[key]) fail(`${key} not set in env`);
}

// 1. Resolve toolbox dir + write a config that points at the registry
const toolboxDir = envPaths("patch-cat", { suffix: "" }).config;
await mkdir(toolboxDir, { recursive: true });
const configPath = join(toolboxDir, "config.json");

const existingConfig = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
const newConfig = {
  ...existingConfig,
  registry: {
    ...(existingConfig.registry ?? {}),
    url: registryUrl,
    read_enabled: true,
    contribute_enabled: existingConfig.registry?.contribute_enabled ?? false,
    contribute_token: existingConfig.registry?.contribute_token ?? null,
  },
};
await writeFile(configPath, `${JSON.stringify(newConfig, null, 2)}\n`, "utf8");
console.log(`✓ pointed local toolbox config at ${registryUrl}`);
console.log(`  ${configPath}`);

// 2. Spawn MCP and connect — forward subprocess stderr to ours so the auth URL
// (written directly to stderr by the server) is visible.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  env: {
    ...process.env,
    LOG_LEVEL: "info",
  },
  stderr: "pipe",
});

if (transport.stderr) {
  transport.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
}
const client = new Client(
  { name: "auth-bootstrap", version: "0.0.1" },
  { capabilities: { logging: {} } },
);

let printedAuthUrl = false;
client.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
  const data = note.params?.data;
  const text = typeof data === "string" ? data : "";
  if (text.includes("Open this URL")) {
    console.log("\n" + "═".repeat(72));
    console.log(text);
    console.log("═".repeat(72));
    console.log("Waiting for OAuth callback (up to 5 minutes)...\n");
    printedAuthUrl = true;
  }
});

await client.connect(transport);
console.log("✓ MCP client connected");
console.log("→ calling patch_auth_register({ provider: 'github' })");

const result = await client.callTool(
  {
    name: "patch_auth_register",
    arguments: { provider: "github" },
  },
  undefined,
  { timeout: 5 * 60 * 1000 },
);

if (result.isError) {
  console.error("FAIL:", result.content[0].text);
  await client.close();
  process.exit(1);
}

const payload = JSON.parse(result.content[0].text);
console.log(`✓ ${payload.message}`);

// 3. Read the token from config.json (auth_register wrote it there)
const updated = JSON.parse(await readFile(configPath, "utf8"));
const token = updated.registry?.contribute_token;
if (!token) {
  console.error("FAIL: no contribute_token in config.json after auth");
  await client.close();
  process.exit(1);
}
console.log(`✓ token written to config.json (${token.length} chars)`);

// 4. Mirror to .env as PATCH_CONTRIBUTE_TOKEN
let envContent = existsSync(ENV_FILE) ? await readFile(ENV_FILE, "utf8") : "";
const tokenLine = `PATCH_CONTRIBUTE_TOKEN='${token}'`;
if (/^PATCH_CONTRIBUTE_TOKEN=/m.test(envContent)) {
  envContent = envContent.replace(/^PATCH_CONTRIBUTE_TOKEN=.*$/m, tokenLine);
} else {
  envContent = envContent.replace(/\n*$/, "\n") + `${tokenLine}\n`;
}
await writeFile(ENV_FILE, envContent, "utf8");
console.log(`✓ mirrored to .env as PATCH_CONTRIBUTE_TOKEN`);

await client.close();
console.log("\nDone — ready to run pnpm verify:registry --registry-url " + registryUrl);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      out[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
