import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RegistryToolEntry, ToolManifest } from "@patch-cat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnthropicMessagesClient, createGenerator } from "./generator.js";
import type { RegistryClient } from "./registry-client.js";
import {
  type CommandResult,
  type SandboxFactory,
  type SandboxLike,
  createSandboxRunner,
} from "./sandbox.js";
import { createPatchServer } from "./server.js";
import { createToolbox } from "./toolbox.js";

const REGISTRY_TOOL_SOURCE = `# ---
# name: fetch_url_registry
# version: 1.0.0
# description: Fetch the body of a URL — pulled from the registry.
# inputs:
#   - name: url
#     type: string
#     description: URL to fetch.
#     tainted_ok: true
# outputs:
#   type: string
#   description: Response body text.
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

def main(url: str):
    return requests.get(url).text

if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

const REGISTRY_MANIFEST: ToolManifest = {
  name: "fetch_url_registry",
  version: "1.0.0",
  description: "Fetch the body of a URL — pulled from the registry.",
  inputs: [
    {
      name: "url",
      type: "string",
      description: "URL to fetch.",
      required: true,
      tainted_ok: true,
    },
  ],
  outputs: { type: "string", description: "Response body text." },
  capabilities: { network: true, filesystem: "none", human_confirm: false },
  runtime: { language: "python", python_version: "3.12", packages: ["requests==2.32.3"] },
};

const SAMPLE_GENERATED_TOOL = `# ---
# name: novel_thing
# version: 1.0.0
# description: A novel tool generated locally because the registry had nothing close.
# inputs:
#   - name: input_text
#     type: string
#     description: Some text.
# outputs:
#   type: string
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json, sys

def main(input_text: str):
    return input_text.upper()

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
    files: { async write() {} },
    commands: {
      async run(): Promise<CommandResult> {
        return { stdout: '"ok"', stderr: "", exitCode: 0 };
      },
    },
    async kill() {},
  };
  return { create: vi.fn().mockResolvedValue(sandbox) };
}

interface MockRegistryOptions {
  searchResults?: RegistryToolEntry[];
  fetchManifest?: ToolManifest;
  fetchSource?: string;
}

function makeMockRegistry(options: MockRegistryOptions = {}): RegistryClient & {
  searchSpy: ReturnType<typeof vi.fn>;
  fetchSpy: ReturnType<typeof vi.fn>;
  contributeSpy: ReturnType<typeof vi.fn>;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const searchSpy = vi.fn().mockResolvedValue(options.searchResults ?? []);
  const fetchSpy = vi.fn().mockResolvedValue({
    manifest: options.fetchManifest ?? REGISTRY_MANIFEST,
    source: options.fetchSource ?? REGISTRY_TOOL_SOURCE,
  });
  const contributeSpy = vi.fn().mockResolvedValue({
    name: "x",
    version: "1.0.0",
    source_sha256: "a".repeat(64),
    status: "created",
  });
  const runSpy = vi.fn().mockResolvedValue(undefined);

  return {
    baseUrl: "mock://registry",
    searchTools: searchSpy,
    fetchTool: fetchSpy,
    contributeTool: contributeSpy,
    recordRun: runSpy,
    searchSpy,
    fetchSpy,
    contributeSpy,
    runSpy,
  };
}

describe("registry integration: search-first generate_tool", () => {
  let toolboxDir: string;
  let client: Client;
  let mock: ReturnType<typeof makeMockRegistry>;

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

  async function spawnServer(
    registry: ReturnType<typeof makeMockRegistry>,
    contribute_enabled: boolean,
    contribute_token: string | null,
    anthropicResponse = SAMPLE_GENERATED_TOOL,
  ) {
    const toolbox = createToolbox(toolboxDir);
    const generator = createGenerator(makeStubAnthropic(anthropicResponse));
    const sandbox = createSandboxRunner(makeStubSandboxFactory());

    const server = createPatchServer({
      toolbox,
      generator,
      sandbox,
      logger: silentLogger() as never,
      registry,
      config: {
        registry: {
          url: "mock://registry",
          read_enabled: true,
          contribute_enabled,
          contribute_token,
        },
      },
      skipSyntaxCheck: true,
    });
    await server.start();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.mcp.connect(serverTransport), c.connect(clientTransport)]);
    return c;
  }

  beforeEach(async () => {
    toolboxDir = await mkdtemp(join(tmpdir(), "patchcat-reg-"));
    mock = makeMockRegistry();
  });

  afterEach(async () => {
    await client?.close();
    await rm(toolboxDir, { recursive: true, force: true });
  });

  it("pulls from registry when top match meets thresholds", async () => {
    mock = makeMockRegistry({
      searchResults: [
        {
          name: "fetch_url_registry",
          description: "Fetch a URL.",
          latest_version: "1.0.0",
          contributor: { github_handle: "patch-cat" },
          use_count: 100,
          success_count: 95,
          success_rate: 0.95,
          similarity: 0.93,
          created_at: "2026-05-04T00:00:00Z",
        },
      ],
    });

    client = await spawnServer(mock, false, null);
    const result = await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "Fetch a URL." },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(payload.source).toBe("registry");
    expect(payload.status).toBe("pulled");
    expect(payload.name).toBe("fetch_url_registry");
    expect(mock.searchSpy).toHaveBeenCalledOnce();
    expect(mock.fetchSpy).toHaveBeenCalledWith("fetch_url_registry", "1.0.0");
  });

  it("falls through to generation when similarity is below threshold", async () => {
    mock = makeMockRegistry({
      searchResults: [
        {
          name: "fetch_url_registry",
          description: "Fetch a URL.",
          latest_version: "1.0.0",
          contributor: { github_handle: "patch-cat" },
          use_count: 100,
          success_count: 95,
          success_rate: 0.95,
          similarity: 0.6, // below 0.85 threshold
          created_at: "2026-05-04T00:00:00Z",
        },
      ],
    });

    client = await spawnServer(mock, false, null);
    const result = await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "do something niche" },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(payload.source).toBe("generated");
    expect(payload.status).toBe("created");
    expect(mock.fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to generation when success_rate is below threshold", async () => {
    mock = makeMockRegistry({
      searchResults: [
        {
          name: "fetch_url_registry",
          description: "Fetch a URL.",
          latest_version: "1.0.0",
          contributor: { github_handle: "patch-cat" },
          use_count: 100,
          success_count: 30,
          success_rate: 0.3, // below 0.7 threshold
          similarity: 0.95,
          created_at: "2026-05-04T00:00:00Z",
        },
      ],
    });

    client = await spawnServer(mock, false, null);
    const result = await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "fetch" },
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(payload.source).toBe("generated");
    expect(mock.fetchSpy).not.toHaveBeenCalled();
  });

  it("contributes generated tool when contribute_enabled and token are set", async () => {
    mock = makeMockRegistry({ searchResults: [] });

    client = await spawnServer(mock, true, "test-contribute-token");
    await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "novel thing" },
    });

    // Async fire-and-forget — let the microtask drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.contributeSpy).toHaveBeenCalledOnce();
  });

  it("does not contribute when contribute_enabled is false", async () => {
    mock = makeMockRegistry({ searchResults: [] });

    client = await spawnServer(mock, false, "test-contribute-token");
    await client.callTool({
      name: "patch_generate_tool",
      arguments: { description: "novel thing" },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mock.contributeSpy).not.toHaveBeenCalled();
  });

  it("auth_status reflects current config", async () => {
    mock = makeMockRegistry();
    client = await spawnServer(mock, true, "tok");
    const result = await client.callTool({
      name: "patch_auth_status",
      arguments: {},
    });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.contribute_enabled).toBe(true);
    expect(payload.has_contribute_token).toBe(true);
    expect(payload.read_enabled).toBe(true);
  });
});
