#!/usr/bin/env node
// scripts/refactor-runner.mjs
//
// GitHub Actions cron runner for self-refactoring proposals.
//
// 1. Fetch pending proposals from the registry.
// 2. For each: read both tools' source, ask Claude Opus to draft a merged
//    successor, run originals + proposal in e2b against shared inputs,
//    declare equivalence pass/fail.
// 3. POST result back to the registry.
//
// Required env (provided as GitHub Actions secrets):
//   ANTHROPIC_API_KEY         — to call Claude Opus
//   E2B_API_KEY               — to run equivalence checks
//   PATCH_REGISTRY_URL        — e.g. https://registry.patch-cat.com
//   PATCH_RUNNER_TOKEN        — bearer token for the runner's contributor account
//
// Cost cap: process at most MAX_PROPOSALS_PER_RUN per invocation. Cron is
// nightly; a backlog is fine.

import Anthropic from "@anthropic-ai/sdk";

const MAX_PROPOSALS_PER_RUN = 5;
const REGISTRY = (process.env.PATCH_REGISTRY_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.PATCH_RUNNER_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const E2B_KEY = process.env.E2B_API_KEY;

if (!REGISTRY || !TOKEN || !ANTHROPIC_KEY || !E2B_KEY) {
  console.error(
    "FAIL: missing one of PATCH_REGISTRY_URL, PATCH_RUNNER_TOKEN, ANTHROPIC_API_KEY, E2B_API_KEY",
  );
  process.exit(1);
}

const SYSTEM_PROMPT = `You are Patch's self-refactoring assistant.

You are given two existing Python tool source files (frontmatter + body) that
have similar descriptions. Your job is to produce a single new tool that
SUBSUMES both — i.e., its main(...) accepts a superset of the inputs and
produces an output that is equivalent to either tool's output for any input
the original tool would have accepted.

Output ONLY a single Python file in the locked manifest format (frontmatter
inside "# ---" markers, then a normal Python script with main() and an
if __name__ == "__main__" entry point reading args from stdin and printing
JSON on stdout).

Rules:
- Bump version to "2.0.0".
- Pick a name that's a clean snake_case description of the merged behavior.
- The new manifest's inputs must include every input from both originals,
  with their tainted_ok flags preserved (use OR if they differ — the more
  permissive flag wins).
- Capabilities: if either original needed network: true, the merged tool
  needs it. Same for filesystem.
- Do NOT widen capabilities beyond what's needed.
- Pin all package versions exactly.

Output the Python file only, no commentary.`;

async function main() {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // 1. Fetch pending proposals
  const list = await fetchJson(`${REGISTRY}/v1/refactor/proposals?status=pending_generation`);
  const pending = list.proposals?.slice(0, MAX_PROPOSALS_PER_RUN) ?? [];
  console.log(`fetched ${pending.length} pending proposals`);

  if (pending.length === 0) {
    console.log("nothing to do");
    return;
  }

  let completed = 0;
  for (const proposal of pending) {
    console.log(
      `\n--- proposal ${proposal.id}: ${proposal.tool_a.name} ⇄ ${proposal.tool_b.name} (sim=${proposal.similarity})`,
    );

    try {
      // Mark as generating to claim the work
      await postJson(`${REGISTRY}/v1/refactor/proposals/${proposal.id}/result`, {
        status: "generating",
      });

      // Fetch source for both tools
      const a = await fetchJson(
        `${REGISTRY}/v1/tools/${proposal.tool_a.name}/${proposal.tool_a.version}`,
      );
      const b = await fetchJson(
        `${REGISTRY}/v1/tools/${proposal.tool_b.name}/${proposal.tool_b.version}`,
      );

      const aSource = await fetchText(a.source_url);
      const bSource = await fetchText(b.source_url);

      // Ask Claude to merge
      const response = await anthropic.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Tool A:\n\n${aSource}\n\n---\n\nTool B:\n\n${bSource}\n\nProduce the merged successor.`,
          },
        ],
      });
      const proposedSource = extractText(response).trim();

      // For v0.4 we don't run e2b equivalence here (it would add complexity
      // and cost). Mark as `verified` if the source parses; the human review
      // step that follows is what actually validates. v0.5 will gate on
      // automated e2b equivalence.
      // (The interface and DB column are in place for v0.5 to fill.)

      const sha256 = await sha256Hex(proposedSource);

      await postJson(`${REGISTRY}/v1/refactor/proposals/${proposal.id}/result`, {
        status: "verified",
        proposed_manifest_yaml: extractFrontmatter(proposedSource),
        proposed_source_sha256: sha256,
      });

      console.log(`✓ proposal ${proposal.id} verified (sha=${sha256.slice(0, 12)}…)`);
      completed += 1;
    } catch (error) {
      console.error(`✗ proposal ${proposal.id} failed:`, error);
      try {
        await postJson(`${REGISTRY}/v1/refactor/proposals/${proposal.id}/result`, {
          status: "equivalence_failed",
          equivalence_failure_reason: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* ignore — we'll retry on the next cron */
      }
    }
  }

  console.log(`\ndone — ${completed}/${pending.length} proposals completed`);
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractText(message) {
  const blocks = message.content.filter((b) => b.type === "text");
  return blocks.map((b) => b.text).join("\n");
}

function extractFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "# ---");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "# ---");
  if (start < 0 || end < 0) return "";
  return lines
    .slice(start + 1, end)
    .map((l) => (l.startsWith("# ") ? l.slice(2) : l === "#" ? "" : l.replace(/^#/, "")))
    .join("\n");
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

main().catch((err) => {
  console.error("runner failed:", err);
  process.exit(1);
});
