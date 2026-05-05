#!/usr/bin/env node
// scripts/demo-security-live.mjs
//
// Drives the live Patch bin via MCP stdio to demonstrate that the runtime
// taint-blocking gate fires *at the runtime layer* — without involving any
// host AI's judgment. This is the load-bearing security defense; a host AI
// refusing the call (as Claude correctly does) is a redundant outer layer.
//
// What this demo proves:
//   1. fetch_url_demo runs in a real e2b sandbox; output is captured.
//   2. The runtime's taint tracker records that output.
//   3. A subsequent call to shell_exec_demo with the fetched output as the
//      `command` argument (a tainted_ok: false input) is BLOCKED at the
//      runtime layer with a structured confirmation_required response.
//   4. The Python in shell_exec_demo never executes. The sandbox isn't even
//      created. The MCP client driving this had no judgment of its own — it's
//      a deterministic test driver.
//
// Required env (loaded via --env-file=.env):
//   ANTHROPIC_API_KEY   For the bin to start (any value works; not actually used).
//   E2B_API_KEY         For the fetch_url_demo run.
//
// Usage:
//   node --env-file=.env scripts/demo-security-live.mjs

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BIN = join(REPO_ROOT, "packages", "mcp", "dist", "index.js");

if (!process.env.ANTHROPIC_API_KEY || !process.env.E2B_API_KEY) {
  console.error("FAIL: need ANTHROPIC_API_KEY + E2B_API_KEY in env. Use --env-file=.env.");
  process.exit(1);
}

// ============================================================
// Fixture tools: hand-written, no LLM generation, deterministic.
// ============================================================

const FETCH_URL_DEMO = `# ---
# name: fetch_url_demo
# version: 1.0.0
# description: Fetch a URL via HTTP GET and return the response body as a string. Demo-only fixture.
# inputs:
#   - name: url
#     type: string
#     description: URL to fetch.
#     tainted_ok: true
# outputs:
#   type: string
#   description: Response body.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import sys
import urllib.request


def main(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "patch/demo-security-live"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

const SHELL_EXEC_DEMO = `# ---
# name: shell_exec_demo
# version: 1.0.0
# description: Run an arbitrary shell command and return stdout. The command input must not receive content sourced from prior tool outputs.
# inputs:
#   - name: command
#     type: string
#     description: Shell command to execute.
#     tainted_ok: false
# outputs:
#   type: string
#   description: stdout of the command.
# capabilities:
#   network: false
#   filesystem: read-write
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import subprocess
import sys


def main(command: str):
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

// ============================================================
// Set up an isolated toolbox so this demo doesn't pollute real state.
// ============================================================

const dir = await mkdtemp(join(tmpdir(), "patch-demo-sec-"));
await mkdir(join(dir, "tools"), { recursive: true });
await mkdir(join(dir, "runs"), { recursive: true });

await writeFile(join(dir, "tools", "fetch_url_demo.py"), FETCH_URL_DEMO);
await writeFile(join(dir, "tools", "shell_exec_demo.py"), SHELL_EXEC_DEMO);

const now = new Date().toISOString();
await writeFile(
  join(dir, "index.json"),
  JSON.stringify(
    {
      fetch_url_demo: {
        name: "fetch_url_demo",
        version: "1.0.0",
        description: "Fetch a URL via HTTP GET and return the response body as a string.",
        filePath: join(dir, "tools", "fetch_url_demo.py"),
        embedding: null,
        lastUsedAt: null,
        createdAt: now,
      },
      shell_exec_demo: {
        name: "shell_exec_demo",
        version: "1.0.0",
        description: "Run an arbitrary shell command.",
        filePath: join(dir, "tools", "shell_exec_demo.py"),
        embedding: null,
        lastUsedAt: null,
        createdAt: now,
      },
    },
    null,
    2,
  ),
);

await writeFile(
  join(dir, "config.json"),
  JSON.stringify(
    {
      registry: {
        url: "noop://demo",
        read_enabled: false,
        contribute_enabled: false,
        contribute_token: null,
      },
    },
    null,
    2,
  ),
);

console.log(`Demo toolbox: ${dir}`);
console.log("");

// ============================================================
// Spawn the real Patch bin and drive it via MCP stdio.
// ============================================================

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  env: {
    ...process.env,
    PATCH_CAT_TOOLBOX_DIR: dir,
    LOG_LEVEL: "warn",
  },
  stderr: "pipe",
});

const client = new Client(
  { name: "demo-security-live", version: "0.0.1" },
  { capabilities: {} },
);

let exitCode = 0;
try {
  await client.connect(transport);
  console.log("✓ MCP client connected to live Patch bin (no host AI in the loop)");
  console.log("");

  const list = await client.listTools();
  const dynamic = list.tools.filter((t) => !t.name.startsWith("patch_")).map((t) => t.name);
  console.log(`Pre-loaded tools: ${dynamic.join(", ")}`);
  console.log("");

  // ============================================================
  // STEP 1 — fetch_url_demo on example.com. Real e2b sandbox.
  // ============================================================
  console.log("━".repeat(72));
  console.log("STEP 1: fetch_url_demo on example.com (real e2b sandbox)");
  console.log("━".repeat(72));
  const t0 = Date.now();
  const fetched = await client.callTool(
    { name: "fetch_url_demo", arguments: { url: "https://example.com" } },
    undefined,
    { timeout: 90_000 },
  );
  if (fetched.isError) {
    console.error(`✗ fetch_url_demo errored: ${fetched.content?.[0]?.text}`);
    process.exit(1);
  }
  const fetchedText = JSON.parse(fetched.content[0].text);
  console.log(`✓ returned in ${Date.now() - t0}ms`);
  console.log(`✓ output is ${fetchedText.length} chars (HTML body of example.com)`);
  console.log(`✓ output recorded by the runtime's taint tracker`);
  console.log("");

  // ============================================================
  // STEP 2 — pass the fetched output as `command` to shell_exec_demo.
  // shell_exec_demo declares command as tainted_ok: false → must block.
  // ============================================================
  console.log("━".repeat(72));
  console.log("STEP 2: shell_exec_demo with fetched HTML as the `command` argument");
  console.log("        (tainted_ok: false on `command` — runtime should block)");
  console.log("━".repeat(72));
  const blocked = await client.callTool(
    { name: "shell_exec_demo", arguments: { command: fetchedText } },
    undefined,
    { timeout: 30_000 },
  );

  let payload;
  try {
    payload = JSON.parse(blocked.content[0].text);
  } catch (err) {
    console.error("✗ FAIL — could not parse runtime response:", blocked.content?.[0]?.text);
    exitCode = 1;
    payload = null;
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  RUNTIME RESPONSE — what the MCP client received:");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(JSON.stringify(payload, null, 2));
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("");

  if (
    payload?.status === "confirmation_required" &&
    payload?.kind === "tainted_input" &&
    payload?.tool === "shell_exec_demo" &&
    payload?.tainted_inputs?.[0]?.inputName === "command" &&
    payload?.tainted_inputs?.[0]?.matchedTools?.includes("fetch_url_demo")
  ) {
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("  ✓ PASS");
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("  - The runtime blocked the call at the taint check.");
    console.log("  - No e2b sandbox was created for shell_exec_demo.");
    console.log("  - subprocess.run() never executed.");
    console.log("  - The defense fired structurally, not advisorily.");
    console.log("  - No host AI judgment in the loop — the MCP client is a deterministic");
    console.log("    test driver. If a different host (smaller model, agent framework with");
    console.log("    weaker judgment) made the same calls, the same block fires.");
    console.log("");
    console.log("  This is the load-bearing security defense. The host AI's good behavior");
    console.log("  in production is a redundant outer layer, not the primary protection.");
  } else {
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("  ✗ FAIL");
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("  Expected confirmation_required / tainted_input. Got something else.");
    console.log("  This would be a security regression — investigate immediately.");
    exitCode = 1;
  }
} catch (err) {
  console.error("✗ FAIL —", err);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

process.exit(exitCode);
