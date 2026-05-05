---
layout: ../../layouts/BlogPost.astro
title: "Patch — letting AI assistants grow capabilities and share them"
description: A small, opinionated MCP server that gives any AI host a permanent, growing toolbox of executable Python tools. Written down honestly, including what it doesn't do.
pubDate: "2026-05-04"
author: "Patch maintainers"
---

Last week I asked Claude Desktop to fetch the top five Hacker News stories and rank them by points. Claude can write Python that does this trivially — it can also call MCP tools that handle it natively if they exist. They didn't. So Claude's reply was: *"I don't have a tool for that. I could write you the code if you want."*

This was the third time that month I'd asked for the same thing in a different shape, gotten the same offer back, and copy-pasted Python that I'd then have to maintain. The fourth time, I built **Patch**. Patch is an MCP server that, when the host AI hits a capability it doesn't have, generates a Python tool, sandbox-tests it in [e2b](https://e2b.dev), persists it to the user's local toolbox, and registers it with the host so it can be called natively from then on. Restart the host. Tool's still there. Ask the same task tomorrow. No regeneration.

That's the half-page version. The interesting parts are the parts that don't fit on a half page: how it knows the generated code is safe, what stops a contributor from poisoning the registry, what happens when a tool's output contains a prompt injection that tries to take over your agent, and what the system can prove when something goes wrong. The rest of this post is about those parts — and what's still possible despite them.

## The problem this is for

Every AI assistant starts from zero on every task that needs a tool. That's the inefficiency. The host AI is excellent at one-shot reasoning over text, less excellent at long chains of structured work — and the unstructured solution to that gap is "here's some Python." Which is fine, except: the Python is ephemeral, the next task starts from zero, and ten different prompts produce ten variants of `fetch_url` that don't compose.

What changes if you let the assistant build and *keep* tools? A few things. The toolbox grows along the user's actual workflow, so the next time you want HN top stories you reach for `hn_top_stories` and the host calls it directly — no LLM call, no regeneration, ~600ms wall-clock. Multiply that across the long tail of "I keep doing this small thing with subtly different shapes," and the difference between a one-shot agent and an agent with memory of its own capabilities is the difference between asking a contractor for help and hiring an in-house engineer.

What stops this from becoming a security disaster: the rest of this post.

## How Patch is put together

Three pieces, glued at well-defined seams:

1. **`@patch-cat/mcp`** — a local Node CLI that speaks MCP over stdio. It's what the host AI talks to. It generates Python, calls e2b to sandbox-run it, writes audit trails to disk, and exposes both the generated tools and a small set of meta-tools (`patch_generate_tool`, `patch_replay`, etc.) over the protocol.
2. **The hosted registry** — a Cloudflare Worker fronted by Hono, backed by Neon Postgres + R2 + Workers AI. Indexes contributed tools by description embedding (via `bge-base-en-v1.5`); semantic search at the edge in 30ms; immutable content-addressed source blobs in R2.
3. **The sandboxed runtime** — e2b. We never run generated Python on your local machine. Capability scopes from the manifest (`network: false`, etc.) are enforced by the sandbox config at create time, not by trusting the generated code.

The generated tool is a single Python file with YAML frontmatter inside `# ---` markers (so the file's still valid Python). The frontmatter declares inputs, outputs, capabilities, and pinned package versions. The body has a `main(...)` function and an entry point that reads JSON args from stdin and prints JSON to stdout. That's the whole contract.

When you ask the host AI to do something it can't, it calls `patch_generate_tool` with a description. Patch:

1. Embeds the description, searches the registry. If a high-quality match exists (cosine similarity > 0.85, success rate > 0.7, contributor verified), it pulls the tool, registers it, sends `notifications/tools/list_changed`. The host's tool list refreshes within ~1 second. No LLM call.
2. Otherwise it asks Claude Opus for a Python tool in the manifest format, runs `py_compile` in a sandbox, persists, registers, notifies. ~5 seconds for the LLM call, ~1 second for the sandbox.
3. Optionally — if you've opted in via `patch_auth_register` — it pushes the new tool back to the registry.

Trust boundaries: the host AI sits outside Patch. The local server validates every MCP request schema. The registry validates every contributed manifest, sanitizes every human-visible field, and runs the description through a second LLM (deliberately on a different vendor — Llama 3.3 70B on Cloudflare Workers AI) to flag instruction-injection. The e2b sandbox is its own isolation boundary. Each of these has a job and a clear interface; none is asked to validate something the next layer should.

## Why the security story matters

Two things tend to happen when you give an AI agent the ability to run code: someone tries to make the agent do something the user didn't ask for, and someone tries to use the agent to attack the user. The first is prompt injection — visible or hidden. The second is supply-chain attacks through the tool corpus.

Patch's defenses are layered, not stacked. Cross-vendor matters: if a single-vendor jailbreak breaks Anthropic's model, the quarantine layer (Llama on Cloudflare) is unaffected. Capability matters: a tool that declares `network: false` *cannot* make outbound requests, regardless of what its Python wants — because the sandbox boots with `allowInternetAccess: false`. Reputation matters: tools from new contributors are tagged unverified and filtered from default search until that contributor crosses a use-count threshold. Audit matters: every execution writes a content-addressed blob you can replay later — and replay reports honestly when it can't prove output equivalence (because the tool hits a live API and the world changed).

The full [threat model](/threat-model) enumerates seven attack vectors, the defense for each, and the section every other security write-up skips: **what's still possible**.

## What's still possible

Filesystem capability scopes are not yet enforced — declared only. Patch's Arcade integration is wired through but uses a stub auth flow until v0.4.x. The taint heuristic is substring-based, so a host AI that paraphrases tool output before passing it on can route around it. The quarantine LLM is a 70B model — capable but not infallible; subtle prompt injection can pass through. The pipeline trusts e2b's sandbox isolation and Anthropic's API not being MITM'd. None of this is reassuring if you're looking for "Patch makes prompt injection impossible." It doesn't. It makes a class of common attacks expensive, makes another class detectable, and is honest about a third class still being open.

That honesty *is* the credibility. If you've read security marketing for an AI tool that didn't have this section, you know how thin it usually feels.

## Install in 30 seconds

```json
{
  "mcpServers": {
    "patch-cat": {
      "command": "npx",
      "args": ["-y", "@patch-cat/mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "E2B_API_KEY": "e2b_..."
      }
    }
  }
}
```

Drop into Claude Desktop's `claude_desktop_config.json`, Cursor's `~/.cursor/mcp.json`, or run `claude mcp add patch-cat ...` for Claude Code. Restart. Ask your AI to do something it doesn't have a tool for. Watch the tool appear, then run.

[Quickstart](/quickstart) · [Threat model](/threat-model) · [Architecture](/architecture) · [GitHub](https://github.com/patch-cat/patch-cat)

The project is at v0.4 with a v1.0 cut planned once the launch settles. If you want to contribute a tool, set `contribute_enabled: true` in your config — your tool generator output gets pushed back to the public registry, where every other Patch user benefits from it. If you find a security issue, **security@patch-cat.com**.
