// Server-level security tests — exercise the full MCP roundtrip for the
// taint → confirmation_required → patch_confirm_action retry flow, the
// human_confirm flow, and the external_auth flow.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseManifest, type ToolManifest } from "@patch-cat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArcadeClient } from "./arcade.js";
import { type AnthropicMessagesClient, createGenerator } from "./generator.js";
import { NOOP_REGISTRY_CLIENT } from "./registry-client.js";
import {
  type CommandResult,
  createSandboxRunner,
  type SandboxFactory,
  type SandboxLike,
} from "./sandbox.js";
import { createPatchServer } from "./server.js";
import { createToolbox } from "./toolbox.js";

function silentLogger() {
  return {
    info: () => {},
    error: () => {},
    warn: () => {},
    fatal: () => {},
    debug: () => {},
    trace: () => {},
    child() {
      return silentLogger();
    },
    level: "silent",
  };
}

function makeAnthropicMessage(text: string): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    content: [{ type: "text", text, citations: [] }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

function makeStubAnthropic(text: string): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(makeAnthropicMessage(text)),
    },
  };
}

function makeStubSandboxFactory(stdoutByCommand: (cmd: string) => string = () => '"OK"'): SandboxFactory {
  const sandbox: SandboxLike = {
    files: { async write() {} },
    commands: {
      async run(cmd): Promise<CommandResult> {
        return { stdout: stdoutByCommand(cmd), stderr: "", exitCode: 0 };
      },
    },
    async kill() {},
  };
  return { create: vi.fn().mockResolvedValue(sandbox) };
}

const TAINT_AWARE_TOOL = `# ---
# name: shell_exec
# version: 1.0.0
# description: Run a shell command on the local machine.
# inputs:
#   - name: command
#     type: string
#     description: Shell command to execute.
#     tainted_ok: false
# outputs:
#   type: string
#   description: stdout.
# capabilities:
#   network: false
#   filesystem: read-write
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json, sys, subprocess

def main(command: str):
    return subprocess.check_output(command, shell=True, text=True)

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

const HITL_TOOL = `# ---
# name: send_email
# version: 1.0.0
# description: Send an email.
# inputs:
#   - name: to
#     type: string
#     description: Recipient.
#     tainted_ok: false
# outputs:
#   type: string
#   description: status.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: true
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json, sys

def main(to: str):
    return f"sent to {to}"

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

const EXTERNAL_AUTH_TOOL = `# ---
# name: read_inbox
# version: 1.0.0
# description: Read the user's recent emails via Gmail.
# inputs:
#   - name: limit
#     type: integer
#     description: Number of emails.
#     tainted_ok: false
# outputs:
#   type: array
#   description: Email summaries.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# external_auth:
#   - gmail.read
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json, sys, os

def main(limit: int = 5):
    token = os.environ.get("PATCH_ACCESS_TOKEN")
    return [{"token_present": bool(token), "limit": limit}]

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

const FETCH_URL_MANIFEST: ToolManifest = {
  name: "fetch_url",
  version: "1.0.0",
  description: "Fetch a URL.",
  inputs: [
    {
      name: "url",
      type: "string",
      description: "URL.",
      required: true,
      tainted_ok: true,
    },
  ],
  outputs: { type: "string" },
  capabilities: { network: true, filesystem: "none", human_confirm: false },
  runtime: { language: "python", python_version: "3.12", packages: [] },
  external_auth: [],
};

const FETCH_URL_BODY = `import json, sys
def main(url: str):
    return "<html>page about deploying production secrets</html>"
if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

describe("security: taint -> confirmation_required -> retry", () => {
  let toolboxDir: string;
  let client: Client;

  beforeEach(async () => {
    toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-sec-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(toolboxDir, { recursive: true, force: true });
  });

  async function spawnServer(extraTool?: { manifest: ToolManifest; body: string }) {
    const toolbox = createToolbox(toolboxDir);
    await toolbox.init();
    // Pre-load fetch_url so we have a tainted_ok-true tool whose output flows.
    await toolbox.saveTool(FETCH_URL_MANIFEST, FETCH_URL_BODY);
    if (extraTool) await toolbox.saveTool(extraTool.manifest, extraTool.body);

    const generator = createGenerator(makeStubAnthropic(""));
    // Mock sandbox: track which tool is being run by inspecting the source file
    // written before run. On first run (fetch_url body), return long-enough
    // content for taint tracking. On second run (shell_exec body), return OK.
    let lastWrittenSource = "";
    const sandbox: SandboxLike = {
      files: {
        async write(path, content) {
          if (path === "/tmp/tool.py") lastWrittenSource = content;
        },
      },
      commands: {
        async run(): Promise<CommandResult> {
          if (lastWrittenSource.includes("page about deploying production secrets")) {
            return {
              stdout: JSON.stringify(
                "<html>page about deploying production secrets — be careful with these</html>",
              ),
              stderr: "",
              exitCode: 0,
            };
          }
          return { stdout: '"OK"', stderr: "", exitCode: 0 };
        },
      },
      async kill() {},
    };
    const sandboxFactory: SandboxFactory = {
      create: vi.fn().mockResolvedValue(sandbox),
    };
    const sandboxRunner = createSandboxRunner(sandboxFactory);

    const server = createPatchServer({
      toolbox,
      generator,
      sandbox: sandboxRunner,
      logger: silentLogger() as never,
      registry: NOOP_REGISTRY_CLIENT,
      config: {
        registry: {
          url: "noop://disabled",
          read_enabled: false,
          contribute_enabled: false,
          contribute_token: null,
        },
      },
      skipSyntaxCheck: true,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "sec-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it("blocks tainted output flowing into a tainted_ok:false input, then runs after confirm", async () => {
    const c = await spawnServer({
      manifest: parseTool(TAINT_AWARE_TOOL).manifest,
      body: parseTool(TAINT_AWARE_TOOL).body,
    });

    // Step 1 — call fetch_url, which is tainted_ok: true; output is recorded as tainted source.
    const fetched = await c.callTool({
      name: "fetch_url",
      arguments: { url: "https://example.com" },
    });
    const fetchedText = (fetched.content as Array<{ text: string }>)[0].text;
    const fetchedOutput = JSON.parse(fetchedText);
    expect(fetchedOutput).toContain("production secrets");

    // Step 2 — pass the tainted output to shell_exec.command (tainted_ok: false).
    const blocked = await c.callTool({
      name: "shell_exec",
      arguments: { command: fetchedOutput },
    });
    const blockedText = (blocked.content as Array<{ text: string }>)[0].text;
    const blockedPayload = JSON.parse(blockedText);

    expect(blockedPayload.status).toBe("confirmation_required");
    expect(blockedPayload.kind).toBe("tainted_input");
    expect(blockedPayload.confirmation_token).toBeTruthy();
    expect(blockedPayload.tainted_inputs[0].inputName).toBe("command");
    expect(blockedPayload.tainted_inputs[0].matchedTools).toContain("fetch_url");

    // Step 3 — host AI surfaces to user, user approves, host calls patch_confirm_action.
    const confirmed = await c.callTool({
      name: "patch_confirm_action",
      arguments: { confirmation_token: blockedPayload.confirmation_token },
    });
    const confirmedText = (confirmed.content as Array<{ text: string }>)[0].text;
    const confirmedPayload = JSON.parse(confirmedText);
    // Sandbox stub returns "OK" for non-fetch_url commands.
    expect(confirmedPayload).toBe("OK");
  });

  it("rejects a stale or invalid confirmation_token", async () => {
    const c = await spawnServer();
    const result = await c.callTool({
      name: "patch_confirm_action",
      arguments: { confirmation_token: "bogus-token-not-real" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("security: human_confirm capability", () => {
  let toolboxDir: string;
  let client: Client;

  beforeEach(async () => {
    toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-sec-hitl-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(toolboxDir, { recursive: true, force: true });
  });

  it("blocks tools with human_confirm:true until confirmed", async () => {
    const toolbox = createToolbox(toolboxDir);
    await toolbox.init();
    const parsed = parseTool(HITL_TOOL);
    await toolbox.saveTool(parsed.manifest, parsed.body);

    const generator = createGenerator(makeStubAnthropic(""));
    const sandbox = createSandboxRunner(makeStubSandboxFactory(() => '"sent"'));
    const server = createPatchServer({
      toolbox,
      generator,
      sandbox,
      logger: silentLogger() as never,
      registry: NOOP_REGISTRY_CLIENT,
      skipSyntaxCheck: true,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "hitl-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const blocked = await client.callTool({
      name: "send_email",
      arguments: { to: "alice@example.com" },
    });
    const blockedPayload = JSON.parse((blocked.content as Array<{ text: string }>)[0].text);
    expect(blockedPayload.status).toBe("confirmation_required");
    expect(blockedPayload.kind).toBe("human_confirm");

    const confirmed = await client.callTool({
      name: "patch_confirm_action",
      arguments: { confirmation_token: blockedPayload.confirmation_token },
    });
    const confirmedPayload = JSON.parse((confirmed.content as Array<{ text: string }>)[0].text);
    expect(confirmedPayload).toBe("sent");
  });
});

describe("security: external_auth via Arcade", () => {
  let toolboxDir: string;
  let client: Client;

  beforeEach(async () => {
    toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-sec-arcade-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(toolboxDir, { recursive: true, force: true });
  });

  it("returns external_auth_required when Arcade has no auth yet", async () => {
    const toolbox = createToolbox(toolboxDir);
    await toolbox.init();
    const parsed = parseTool(EXTERNAL_AUTH_TOOL);
    await toolbox.saveTool(parsed.manifest, parsed.body);

    const arcade: ArcadeClient = {
      enabled: true,
      async authorize(scopes) {
        return {
          status: "auth_required",
          authUrl: `https://arcade.example/authorize?scopes=${scopes.join(",")}`,
          scopes,
        };
      },
    };

    const server = createPatchServer({
      toolbox,
      generator: createGenerator(makeStubAnthropic("")),
      sandbox: createSandboxRunner(makeStubSandboxFactory()),
      logger: silentLogger() as never,
      arcade,
      skipSyntaxCheck: true,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "arcade-test", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "read_inbox",
      arguments: { limit: 3 },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(payload.status).toBe("external_auth_required");
    expect(payload.providers).toContain("gmail");
    expect(payload.auth_url).toContain("arcade.example");
  });

  it("injects PATCH_ACCESS_TOKEN env when Arcade returns ready", async () => {
    const toolbox = createToolbox(toolboxDir);
    await toolbox.init();
    const parsed = parseTool(EXTERNAL_AUTH_TOOL);
    await toolbox.saveTool(parsed.manifest, parsed.body);

    const arcade: ArcadeClient = {
      enabled: true,
      async authorize(scopes) {
        return {
          status: "ready",
          token: {
            token: "arcade-scoped-token-abc123",
            scopes,
            expiresAt: Date.now() + 60_000,
          },
        };
      },
    };

    let observedEnvs: Record<string, string> | undefined;
    const sandboxFactory: SandboxFactory = {
      create: vi.fn().mockImplementation(async (options) => {
        observedEnvs = options?.envs;
        return {
          files: { async write() {} },
          commands: {
            async run() {
              return {
                stdout: '[{"token_present": true, "limit": 3}]',
                stderr: "",
                exitCode: 0,
              };
            },
          },
          async kill() {},
        };
      }),
    };

    const server = createPatchServer({
      toolbox,
      generator: createGenerator(makeStubAnthropic("")),
      sandbox: createSandboxRunner(sandboxFactory),
      logger: silentLogger() as never,
      arcade,
      skipSyntaxCheck: true,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "arcade-test-2", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([
      server.mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "read_inbox",
      arguments: { limit: 3 },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(payload).toEqual([{ token_present: true, limit: 3 }]);
    expect(observedEnvs?.PATCH_ACCESS_TOKEN).toBe("arcade-scoped-token-abc123");
  });
});

function parseTool(source: string): { manifest: ToolManifest; body: string } {
  return parseManifest(source);
}
