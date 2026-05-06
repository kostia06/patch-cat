import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnthropicMessagesClient, createGenerator } from "./generator.js";
import {
  type CommandResult,
  type SandboxFactory,
  type SandboxLike,
  createSandboxRunner,
} from "./sandbox.js";
import { createPatchServer } from "./server.js";
import { createToolbox } from "./toolbox.js";

const SAMPLE_TOOL = `# ---
# name: hn_top
# version: 1.0.0
# description: Fetch top Hacker News stories ranked by points.
# inputs:
#   - name: limit
#     type: integer
#     description: Number of stories to return.
#     required: false
#     default: 5
# outputs:
#   type: array
#   description: Top stories.
# capabilities:
#   network: true
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages:
#     - requests==2.32.3
# ---

import json, sys, requests

def main(limit: int = 5):
    return [{"title": "fake", "score": 100}]

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

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

function makeStubSandboxFactory(): SandboxFactory {
  const sandbox: SandboxLike = {
    files: {
      async write(_path: string, _content: string) {},
    },
    commands: {
      async run(cmd: string): Promise<CommandResult> {
        if (cmd.includes("py_compile")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("pip install")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return {
          stdout: '[{"title": "fake", "score": 100}]\n',
          stderr: "",
          exitCode: 0,
        };
      },
    },
    async kill() {},
  };
  return {
    create: vi.fn().mockResolvedValue(sandbox),
  };
}

describe("integration", () => {
  let toolboxDir: string;
  let client: Client;
  let listChangedCount: number;

  beforeEach(async () => {
    toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-int-"));
    listChangedCount = 0;

    const toolbox = createToolbox(toolboxDir);
    const anthropic = makeStubAnthropic(SAMPLE_TOOL);
    const generator = createGenerator(anthropic);
    const sandbox = createSandboxRunner(makeStubSandboxFactory());

    const logger = {
      info: () => {},
      error: () => {},
      warn: () => {},
      fatal: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
      level: "silent",
      // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    } as any;

    const server = createPatchServer({
      toolbox,
      generator,
      sandbox,
      logger,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });

    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount += 1;
    });

    await Promise.all([server.mcp.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(toolboxDir, { recursive: true, force: true });
  });

  it("lists meta-tools on a fresh toolbox", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "patch_auth_register",
      "patch_auth_status",
      "patch_compose",
      "patch_confirm_action",
      "patch_generate_tool",
      "patch_list_runs",
      "patch_list_tools",
      "patch_replay",
      "patch_run_tool",
    ]);
  });

  it("generates a tool, sends list_changed, and exposes the new tool", async () => {
    const generated = await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "Fetch top HN stories." },
    });

    const content = (generated.content as Array<{ type: string; text?: string }>)[0];
    expect(content?.type).toBe("text");
    const payload = JSON.parse(content?.text ?? "{}");
    expect(payload.name).toBe("hn_top");
    expect(payload.status).toBe("created");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listChangedCount).toBeGreaterThanOrEqual(1);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("hn_top");

    const invoked = await client.callTool({
      name: "hn_top",
      arguments: { limit: 3 },
    });
    const invokedContent = (invoked.content as Array<{ type: string; text?: string }>)[0];
    const result = JSON.parse(invokedContent?.text ?? "[]");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].title).toBe("fake");
  });

  it("persists tools across server restarts", async () => {
    await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "Fetch top HN stories." },
    });
    await client.close();

    const toolbox = createToolbox(toolboxDir);
    const list = await toolbox.listTools();
    expect(list.map((t) => t.name)).toContain("hn_top");
  });
});
