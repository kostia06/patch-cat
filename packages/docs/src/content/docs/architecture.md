---
title: Architecture
description: How Patch generates, stores, runs, and ships tools — and where every trust boundary sits.
sidebar:
  order: 3
---

Patch is three things stitched together: a **local MCP server**, a **community registry**, and a **sandboxed runtime**. Each has a clear job; the seams between them are the parts you should care about.

## The local MCP server (`@patch-cat/mcp`)

Runs as a child process of your AI host (Claude Desktop, Cursor, Claude Code, Windsurf), communicating over MCP's stdio transport. Lives in your terminal, doesn't phone home unless you opt in.

**Responsibilities:**

- Exposes a small set of meta-tools (`patch_generate_tool`, `patch_run_tool`, `patch_list_tools`, `patch_compose`, `patch_confirm_action`, `patch_list_runs`, `patch_replay`, `patch_auth_register`, `patch_auth_status`).
- Dynamically registers each tool in your local toolbox as a first-class MCP tool. When a new tool is generated or pulled, it sends `notifications/tools/list_changed` so the host refreshes its tool list within ~1 second.
- Calls Claude Opus to generate Python tools, then sandbox-tests them in e2b before saving.
- Routes invocations through the security stack: sanitizer → quarantine → taint check → confirmation gate → sandbox.
- Writes a forensic audit blob for every successful execution.

**State:**

The toolbox persists at `env-paths('patch-cat')`:

```
patch-cat/
├── tools/         one .py per tool, manifest frontmatter + body
├── index.json     name → {version, file path, last-used timestamp}
├── runs/          one .json per execution
│   └── blobs/     content-addressed stdout/stderr by SHA-256
└── config.json    registry URL, contribute opt-in, auth tokens
```

## The hosted registry (`@patch-cat/registry`)

A Cloudflare Worker fronted by Hono, backed by Neon Postgres + R2 + Workers AI.

**Responsibilities:**

- Stores tool source as immutable, content-addressed R2 blobs (`tools/{sha256}.py`).
- Indexes tool metadata in `tools` + `tool_versions` Postgres tables; semantic search via pgvector HNSW on description embeddings.
- GitHub OAuth for contributor identity. Bearer-token-protected `POST /v1/tools` for contributions.
- Quarantine LLM endpoint (`POST /v1/quarantine/summarize`) that any client can hit to summarize untrusted text.
- Self-refactoring proposals via a nightly Worker cron + a daily GitHub Actions runner.

**Trust boundary:** the registry serves as the *coordination* layer, not as a trust anchor for code execution. The local MCP server still re-validates every manifest schema, every Unicode payload, and every contributor reputation signal before pulling a tool.

## The sandboxed runtime (e2b)

Every Python tool runs in an [e2b](https://e2b.dev) sandbox. The sandbox is created with `allowInternetAccess` derived from the tool's manifest:

- `network: false` → sandbox boots with no internet access. e2b enforces at the provider layer; the manifest declaration matches the runtime constraint by construction.
- `network: true` → default sandbox.
- `browser: true` → Playwright + headless Chromium are installed at sandbox boot (~15s cold-start tax). Forces `network: true` — you can't browse without egress. Stays inside the e2b boundary; same trust dependency as any other tool.

The sandbox receives:

- The tool source at `/tmp/tool.py`
- The args JSON at `/tmp/args.json`
- An optional `PATCH_ACCESS_TOKEN` env (Arcade-minted, scoped, short-lived) for tools with `external_auth`

The sandbox runs `python /tmp/tool.py < /tmp/args.json`. Output is JSON on the last line of stdout. Sandbox is destroyed after every invocation — no shared state.

**What's NOT enforced today:** filesystem capability scopes (`read-only`, `read-write`, `none`) are advertised by the manifest but e2b's SDK doesn't expose a documented filesystem isolation knob. Honest gap; v0.4.x.

## Trust boundaries

<img src="/architecture-diagram.svg" alt="Patch architecture trust-boundary diagram" style="width: 100%; max-width: 900px; margin: 24px 0;" />

Every solid line crossing into a new box is a trust boundary that Patch validates:

- **Host AI → Patch local:** MCP request schema; tool name allowlist; argument types from manifest.
- **Patch local → Registry:** TLS + bearer-token auth on contribute; SHA-256 verification on fetched source against recorded hash.
- **Patch local → e2b:** capability flags pinned at sandbox-create time, not negotiable later.
- **Patch local → Arcade:** scope strings explicit in manifest; tokens never enter the sandbox process env keys (the *value* is injected; the *refresh token* stays at Arcade).

## Replay

`patch_replay({ run_id })` reads an audit blob and re-runs the recorded inputs against the recorded source in a fresh sandbox. It reports three things honestly:

| Field | Possible values | Meaning |
|-------|----------------|---------|
| `source_match` | `true` / `false` | Local copy of the tool's source matches the recorded SHA-256. |
| `sandbox_match` | object | Capabilities + `allowInternetAccess` match what was used. |
| `output_match` | `"yes"` / `"no"` / `"na_non_deterministic"` | What replay actually proves about the output. |

The `na_non_deterministic` case is what most replay systems gloss over. If a tool was declared `network: true` and replay produces a different output, that's *expected* — the external world (HTTP responses, wall-clock, search results) isn't part of the audit blob. Replay confirms the tool RAN as recorded; it cannot guarantee output equivalence for tools that depend on external state.

A `"no"` verdict for a `network: false` tool, on the other hand, is a real finding worth investigating: clock-dependent code, unseeded randomness, or a non-deterministic dependency.

This is documented in detail in the [threat model](/threat-model).

## Composition

`patch_compose({ steps, on_error?, parallel? })` runs a multi-step workflow built from existing tools. Each step is `{ id, tool, args }`; later steps reference earlier results via `$step_id` or `$step_id.path.to.field`. Sequential mode (default) lets a step consume any earlier step's output; parallel mode runs everything concurrently with no inter-step references.

The point: composition does not bypass any defense. Every step still flows through sanitizer → quarantine → taint check → confirmation gate → sandbox. If any step returns `confirmation_required` (e.g. tainted input or `human_confirm`), the whole workflow pauses and surfaces the confirmation token — the host AI must collect explicit user approval before resuming. There is no "approve all steps" shortcut by design.

This makes the registry compounding: once `fetch_url`, `extract_html_text`, and `summarize_text` exist, the host AI doesn't need to generate `summarize_url`. It composes them.

## Stack lock

The stack choices are fixed:

- TypeScript + Node 20+ for the local server
- `@modelcontextprotocol/sdk` for protocol
- `@anthropic-ai/sdk`, model `claude-opus-4-7`, for tool generation
- `@e2b/code-interpreter` for sandboxing
- Cloudflare Workers + Hono + Drizzle + Neon + R2 for the registry
- Workers AI Llama 3.3 70B for the quarantine LLM
- Arcade.dev for OAuth-mediated external auth

The docs site stack (Astro + Starlight) is the only stack choice deliberately outside the lock; documented in the registry README.
