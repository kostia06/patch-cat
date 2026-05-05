import type Anthropic from "@anthropic-ai/sdk";
import { GeneratorError, ManifestParseError, ToolNameCollisionError } from "@patch-cat/shared";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicMessagesClient, createGenerator } from "./generator.js";

const VALID_RESPONSE = `# ---
# name: hn_top_stories
# version: 1.0.0
# description: Fetch the top stories from Hacker News and return them ranked by points.
# inputs:
#   - name: limit
#     type: integer
#     description: Number of stories to return.
#     required: false
#     default: 5
# outputs:
#   type: array
#   description: Top stories sorted by points.
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

import json
import sys
import requests


def main(limit: int = 5):
    ids = requests.get("https://hacker-news.firebaseio.com/v0/topstories.json").json()
    stories = []
    for story_id in ids[:limit * 2]:
        item = requests.get(f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json").json()
        if item:
            stories.append(item)
    stories.sort(key=lambda s: s.get("score", 0), reverse=True)
    return stories[:limit]


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))
`;

function makeMessage(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    content: [{ type: "text", text, citations: [] }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

function makeClient(message: Anthropic.Message): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(message),
    },
  };
}

describe("generator", () => {
  it("parses a well-formed response and stamps generated_by/at", async () => {
    const client = makeClient(makeMessage(VALID_RESPONSE));
    const generator = createGenerator(client);
    const tool = await generator.generate({ description: "Top HN stories" });

    expect(tool.manifest.name).toBe("hn_top_stories");
    expect(tool.manifest.generated_by).toBe("claude-opus-4-7");
    expect(tool.manifest.generated_at).toBeDefined();
    expect(tool.body).toContain("def main");
  });

  it("strips markdown code fences from response", async () => {
    const fenced = `\`\`\`python\n${VALID_RESPONSE}\n\`\`\``;
    const client = makeClient(makeMessage(fenced));
    const generator = createGenerator(client);
    const tool = await generator.generate({ description: "Top HN stories" });
    expect(tool.manifest.name).toBe("hn_top_stories");
  });

  it("throws ManifestParseError on malformed response", async () => {
    const client = makeClient(makeMessage("not a tool, just prose"));
    const generator = createGenerator(client);
    await expect(generator.generate({ description: "anything" })).rejects.toThrow(
      ManifestParseError,
    );
  });

  it("throws ToolNameCollisionError when name is already taken", async () => {
    const client = makeClient(makeMessage(VALID_RESPONSE));
    const generator = createGenerator(client);
    await expect(
      generator.generate({
        description: "Top HN stories",
        existingNames: ["hn_top_stories"],
      }),
    ).rejects.toThrow(ToolNameCollisionError);
  });

  it("throws GeneratorError on SDK failure", async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("network down")),
      },
    };
    const generator = createGenerator(client);
    await expect(generator.generate({ description: "x" })).rejects.toThrow(GeneratorError);
  });

  it("throws GeneratorError when response has no text blocks", async () => {
    const empty = makeMessage("");
    empty.content = [];
    const client = makeClient(empty);
    const generator = createGenerator(client);
    await expect(generator.generate({ description: "x" })).rejects.toThrow(GeneratorError);
  });

  it("includes existing names in user prompt", async () => {
    const create = vi.fn().mockResolvedValue(makeMessage(VALID_RESPONSE));
    const client: AnthropicMessagesClient = { messages: { create } };
    const generator = createGenerator(client);
    await generator.generate({
      description: "fetch json",
      existingNames: ["fetch_json", "parse_csv"],
    });

    const call = create.mock.calls[0]?.[0];
    expect(call.messages[0].content).toContain("fetch_json");
    expect(call.messages[0].content).toContain("parse_csv");
  });
});
