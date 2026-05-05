import type Anthropic from "@anthropic-ai/sdk";
import { GeneratorError, ManifestParseError, ToolNameCollisionError } from "@patch-cat/shared";
import { type ParsedTool, parseManifest } from "@patch-cat/shared";
import { NOOP_TRACER, type Tracer } from "./observability.js";

export const GENERATOR_MODEL = "claude-opus-4-7";

const SYSTEM_PROMPT = `You are Patch's tool generator. Your job is to write a single, self-contained Python 3.12 tool that an MCP host AI will call.

Output rules — non-negotiable:

1. Output ONLY a single Python file. No prose, no Markdown fences, no explanations before or after.
2. The file MUST begin with YAML frontmatter inside "# ---" markers, where every YAML line is prefixed with "# " (a hash and a space). Empty lines inside frontmatter are written as a bare "#".
3. After the closing "# ---", the file is a normal Python script that:
   - Defines a top-level \`main(...)\` function whose parameters match the manifest \`inputs\`.
   - Reads its arguments from stdin as a single JSON object: \`args = json.loads(sys.stdin.read())\`.
   - Prints exactly one line of JSON to stdout: \`print(json.dumps(main(**args)))\`.
4. The frontmatter must validate against the schema:
   - \`name\`: snake_case, lowercase letters / digits / underscores. Concise and intention-revealing.
   - \`version\`: "1.0.0" for new tools.
   - \`description\`: one sentence describing what the tool does.
   - \`inputs\`: list of objects with name, type (string|number|integer|boolean|array|object), description, required (bool, default true), tainted_ok (bool, default false).
   - \`outputs\`: object with type, optional description.
   - \`capabilities\`: { network: bool, filesystem: "none"|"read-only"|"read-write", human_confirm: bool }. Be honest — if your code uses urllib or requests, set network: true. If it reads files, set filesystem: read-only or read-write.
   - \`runtime\`: { language: python, python_version: "3.12", packages: [pinned versions] }. Pin every package to an exact version (e.g. "requests==2.32.3"). Prefer the standard library when sufficient — leave packages empty.
5. Only set \`tainted_ok: true\` for inputs whose values may legitimately come from untrusted sources (e.g. URLs to fetch, file contents to parse). Identifiers, names, or control-plane inputs should be tainted_ok: false.
6. The script MUST not perform side effects at import time. All work happens inside \`main\`.

Few-shot example #1 — fetch JSON from a URL:

# ---
# name: fetch_json
# version: 1.0.0
# description: Fetch a URL and return the response as parsed JSON.
# inputs:
#   - name: url
#     type: string
#     description: HTTP(S) URL to fetch.
#     tainted_ok: true
# outputs:
#   type: object
#   description: Parsed JSON body.
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


def main(url: str):
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))

Few-shot example #2 — find regex matches in a string:

# ---
# name: regex_findall
# version: 1.0.0
# description: Return all non-overlapping matches of a regex in a string.
# inputs:
#   - name: pattern
#     type: string
#     description: Python regular expression.
#   - name: text
#     type: string
#     description: Text to search.
#     tainted_ok: true
# outputs:
#   type: array
#   description: List of matched substrings.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import json
import re
import sys


def main(pattern: str, text: str):
    return re.findall(pattern, text)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))

Few-shot example #3 — parse CSV from a string:

# ---
# name: parse_csv
# version: 1.0.0
# description: Parse a CSV-formatted string into a list of row objects keyed by header.
# inputs:
#   - name: csv_text
#     type: string
#     description: Raw CSV content with a header row.
#     tainted_ok: true
# outputs:
#   type: array
#   description: List of rows as JSON objects.
# capabilities:
#   network: false
#   filesystem: none
#   human_confirm: false
# runtime:
#   language: python
#   python_version: "3.12"
#   packages: []
# ---

import csv
import io
import json
import sys


def main(csv_text: str):
    reader = csv.DictReader(io.StringIO(csv_text))
    return list(reader)


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    print(json.dumps(main(**args)))

Now: write a single tool that fulfills the user's request below. Output the Python file only. No commentary.`;

export interface GenerateOptions {
  description: string;
  existingNames?: string[];
  nameHint?: string;
}

export interface Generator {
  generate(options: GenerateOptions): Promise<ParsedTool>;
}

export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface CreateGeneratorOptions {
  tracer?: Tracer;
}

export function createGenerator(
  client: AnthropicMessagesClient,
  options: CreateGeneratorOptions = {},
): Generator {
  const tracer = options.tracer ?? NOOP_TRACER;

  return {
    async generate({ description, existingNames = [], nameHint }) {
      const userPrompt = buildUserPrompt(description, existingNames, nameHint);

      const startTime = Date.now();
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: GENERATOR_MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        });
      } catch (error) {
        throw new GeneratorError("Tool generation request failed.", error);
      }

      // Best-effort tracing — fire and forget.
      void tracer.traceGeneration({
        name: "patch_generate_tool",
        model: GENERATOR_MODEL,
        input: {
          description,
          name_hint: nameHint,
          existing_names_count: existingNames.length,
        },
        output: {
          stop_reason: message.stop_reason,
          input_tokens: message.usage?.input_tokens,
          output_tokens: message.usage?.output_tokens,
        },
        startTime,
        endTime: Date.now(),
      });

      const text = extractText(message);
      const cleaned = stripCodeFences(text).trim();

      let parsed: ParsedTool;
      try {
        parsed = parseManifest(cleaned);
      } catch (error) {
        if (error instanceof ManifestParseError) {
          throw error;
        }
        throw new ManifestParseError("Generator returned an unparseable tool file.", error);
      }

      if (existingNames.includes(parsed.manifest.name)) {
        throw new ToolNameCollisionError(parsed.manifest.name);
      }

      const stamped: ParsedTool = {
        manifest: {
          ...parsed.manifest,
          generated_by: GENERATOR_MODEL,
          generated_at: new Date().toISOString(),
        },
        body: parsed.body,
      };

      return stamped;
    },
  };
}

function buildUserPrompt(description: string, existingNames: string[], nameHint?: string): string {
  const lines: string[] = [];
  lines.push("Tool request:", description);
  if (nameHint) {
    lines.push("", `Suggested tool name (use unless it conflicts): ${nameHint}`);
  }
  if (existingNames.length > 0) {
    lines.push(
      "",
      "These tool names are already taken — pick a different one:",
      ...existingNames.map((name) => `- ${name}`),
    );
  }
  return lines.join("\n");
}

function extractText(message: Anthropic.Message): string {
  const textBlocks = message.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (textBlocks.length === 0) {
    throw new GeneratorError("Generator response contained no text content.");
  }
  return textBlocks.map((block) => block.text).join("\n");
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/^```(?:python)?\n([\s\S]*?)\n```\s*$/);
  if (fenced?.[1]) {
    return fenced[1];
  }
  return text;
}
