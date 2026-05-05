#!/usr/bin/env node
// scripts/preseed.mjs
// Generate seed tools locally, hand-review each one, then contribute approved
// tools to the registry under the configured contributor account.
//
// Usage:
//   node --env-file=.env scripts/preseed.mjs \
//     --registry-url <url> \
//     --tools-file scripts/seed-tools.json
//
// Required env vars (loaded from .env):
//   ANTHROPIC_API_KEY       For tool generation.
//   E2B_API_KEY             For sandbox-based syntax check.
//   PATCH_CONTRIBUTE_TOKEN  Session JWT for the official contributor account.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import yaml from "js-yaml";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "dist", "index.js");

const args = parseArgs(process.argv.slice(2));
const registryUrl =
  args["registry-url"] ?? process.env.PATCH_REGISTRY_URL ?? "http://localhost:8787";
const toolsFile = args["tools-file"] ?? join(REPO_ROOT, "scripts", "seed-tools.json");
const contributeToken = process.env.PATCH_CONTRIBUTE_TOKEN;

const required = ["ANTHROPIC_API_KEY", "E2B_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FAIL: ${key} not set. Run with: node --env-file=.env scripts/preseed.mjs`);
    process.exit(1);
  }
}

if (!contributeToken) {
  console.error("WARN: PATCH_CONTRIBUTE_TOKEN not set — review-only mode (no contributions).");
}

console.log(`registry: ${registryUrl}`);
console.log(`tools file: ${toolsFile}`);
console.log("");

const seeds = JSON.parse(await readFile(toolsFile, "utf8"));
if (!Array.isArray(seeds) || seeds.length === 0) {
  console.error(`No seeds in ${toolsFile}`);
  process.exit(1);
}

const toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-preseed-"));
console.log(`scratch toolbox: ${toolboxDir}\n`);

// Disable registry reads so generation always happens locally.
await writeFile(
  join(toolboxDir, "config.json"),
  JSON.stringify(
    {
      registry: {
        url: registryUrl,
        read_enabled: false,
        contribute_enabled: false,
        contribute_token: null,
      },
    },
    null,
    2,
  ),
);

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

const client = new Client({ name: "preseed", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);
console.log("✓ MCP client connected\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const summary = { generated: 0, approved: 0, contributed: 0, skipped: 0, failed: 0 };

try {
  for (const seed of seeds) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`SEED: ${seed.name_hint ?? "(no hint)"}`);
    console.log(`DESC: ${seed.description}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    let generated;
    try {
      console.log(`→ generating + syntax-checking...`);
      const t0 = Date.now();
      const result = await client.callTool({
        name: "patch_generate_tool",
        arguments: { description: seed.description, name_hint: seed.name_hint },
      });
      if (result.isError) {
        const text = result.content?.[0]?.text ?? "<no detail>";
        console.error(`✗ generation errored: ${text}`);
        summary.failed += 1;
        continue;
      }
      generated = JSON.parse(result.content[0].text);
      summary.generated += 1;
      console.log(`✓ generated ${generated.name} v${generated.version} in ${Date.now() - t0}ms`);
    } catch (error) {
      console.error(`✗ generation threw:`, error);
      summary.failed += 1;
      continue;
    }

    const sourcePath = join(toolboxDir, "tools", `${generated.name}.py`);
    const source = await readFile(sourcePath, "utf8");

    console.log(`\n--- ${generated.name}.py (${source.length} chars) ---`);
    console.log(source);
    console.log(`--- end ${generated.name}.py ---\n`);

    const answer = (await rl.question(`Contribute "${generated.name}"? [y/N/q] `))
      .trim()
      .toLowerCase();
    if (answer === "q") {
      console.log("Aborting.");
      break;
    }
    if (answer !== "y") {
      console.log(`✗ skipped ${generated.name}`);
      summary.skipped += 1;
      continue;
    }
    summary.approved += 1;

    if (!contributeToken) {
      console.log(`⚠  approved but PATCH_CONTRIBUTE_TOKEN not set — would have contributed.`);
      continue;
    }

    const manifest = await loadManifestFromIndex(toolboxDir, generated.name);
    if (!manifest) {
      console.error(`✗ failed to read manifest for ${generated.name}`);
      summary.failed += 1;
      continue;
    }

    try {
      const resp = await fetch(`${registryUrl.replace(/\/$/, "")}/v1/tools`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${contributeToken}`,
        },
        body: JSON.stringify({ manifest, source }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`✗ contribute failed (${resp.status}): ${text}`);
        summary.failed += 1;
        continue;
      }
      const body = await resp.json();
      console.log(
        `✓ contributed ${body.name}@${body.version} (${body.status}, sha256=${body.source_sha256.slice(0, 12)}…)`,
      );
      summary.contributed += 1;
    } catch (error) {
      console.error(`✗ contribute threw:`, error);
      summary.failed += 1;
    }
  }
} finally {
  rl.close();
  await client.close();
  await rm(toolboxDir, { recursive: true, force: true });
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Summary:`);
console.log(`  generated:   ${summary.generated}`);
console.log(`  approved:    ${summary.approved}`);
console.log(`  contributed: ${summary.contributed}`);
console.log(`  skipped:     ${summary.skipped}`);
console.log(`  failed:      ${summary.failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(summary.failed > 0 ? 1 : 0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function loadManifestFromIndex(dir, name) {
  const indexPath = join(dir, "index.json");
  const raw = await readFile(indexPath, "utf8");
  const index = JSON.parse(raw);
  if (!index[name]) return null;

  // Reload the .py file and parse the frontmatter inline (avoids cross-package imports).
  const sourcePath = join(dir, "tools", `${name}.py`);
  const source = await readFile(sourcePath, "utf8");
  return parseFrontmatter(source);
}

function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "# ---");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "# ---");
  if (start < 0 || end < 0) return null;

  const yamlLines = lines.slice(start + 1, end).map((l) => {
    if (l.startsWith("# ")) return l.slice(2);
    if (l === "#") return "";
    if (l.startsWith("#")) return l.slice(1);
    return l;
  });
  return parseYamlSimple(yamlLines.join("\n"));
}

function parseYamlSimple(text) {
  return yaml.load(text, { schema: yaml.JSON_SCHEMA });
}
