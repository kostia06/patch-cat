# `@patch-cat/mcp`

> Your AI assistant builds and remembers its own tools.

<p align="center">
  <img src="https://patch-cat.pages.dev/cat/sprite-sheet.png" alt="Patch — pixel-art tuxedo cat in seven poses" width="900" />
</p>

Patch is an MCP server that gives any host AI — Claude Desktop, Cursor, Claude Code, Windsurf — a permanent, growing toolbox of executable Python tools. When the host hits a capability it doesn't have, it calls `patch_generate_tool`. Patch writes a Python tool, sandbox-tests it in [e2b](https://e2b.dev), persists it to disk, and registers it as a first-class MCP tool. From that point on the host can call it natively, in this conversation and every future one.

There's also a public registry: when another Patch user has already contributed a tool that fits your task, Patch pulls it instead of regenerating from scratch — no LLM call, just a fast registry lookup and an immediate sandbox run.

**Status: v0.4.** Production-ready for the local generation loop and registry pulls. Self-refactoring proposals ship in this version. v1.0 cuts after the launch settles.

## Install

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

Drop into Claude Desktop's `claude_desktop_config.json`, Cursor's `~/.cursor/mcp.json`, or run `claude mcp add patch-cat --scope user --env ANTHROPIC_API_KEY=... --env E2B_API_KEY=... -- npx -y @patch-cat/mcp` for Claude Code. Restart the host. Done.

You'll need:

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com)
- An [e2b API key](https://e2b.dev) (free tier is plenty)

Full quickstart with examples for every host: <https://patch-cat.com/quickstart>

## What it does, in three layers

```
host AI  ─────[MCP stdio]─────>  @patch-cat/mcp  ─────[HTTPS]─────>  registry
                                       │
                                       └──[e2b]──> sandbox ──> external APIs
                                            ▲
                                            │ short-lived scoped token
                                            └──[Arcade]── refresh token (never enters sandbox)
```

1. **Host AI to local server (MCP stdio).** Patch exposes a small set of meta-tools (`patch_generate_tool`, `patch_replay`, `patch_list_runs`, `patch_confirm_action`, `patch_auth_register`, `patch_auth_status`) plus every tool already in your local toolbox.
2. **Local server to registry (HTTPS).** Before generating, Patch searches the public registry by description-embedding similarity. If a high-quality match exists, it's pulled. Otherwise Patch generates locally via Claude Opus.
3. **Local server to sandbox (e2b).** Generated Python is *never* run on your machine. Capability scopes from the manifest (`network: false`, etc.) are enforced by sandbox config — not by trusting the generated code.

Architecture overview with the trust-boundary diagram: <https://patch-cat.com/architecture>

## Threat model — what's defended, what's still possible

Patch defends against direct prompt injection (via a cross-vendor quarantine LLM), hidden Unicode injection (NFKC + tag-character + bidi-override stripping), tool description injection (sanitization + quarantine at registry contribute time), tool output injection (taint tracking with confirmation gating), capability escape (sandbox-enforced `allowInternetAccess`), supply-chain attacks via tool updates (immutable versions + reputation gating), and OAuth scope creep (Arcade-mediated scoped tokens).

We're explicitly honest about what's still possible: filesystem capability scopes aren't yet enforced (declared only); the Arcade integration is a stub in v0.4; the taint heuristic is substring-based; the quarantine LLM is a 70B model not infallible; and the host AI's planner sits outside our boundary.

Full threat model with seven attack vectors and the things still open: <https://patch-cat.com/threat-model>

## Replay

Every successful tool execution writes a content-addressed audit blob to `~/.config/patch-cat/runs/<run_id>.json`. The MCP tool `patch_replay({ run_id })` re-runs the recorded inputs against the recorded source in a fresh sandbox and reports `output_match: "yes" | "no" | "na_non_deterministic"`. The "n/a" case is the credibility move — for tools that hit live APIs (search, weather, anything with a clock or random source), output equivalence isn't something replay can prove.

## Contributing a tool

After installing Patch, ask your host AI:

> *"Use patch_auth_register to authorize me to contribute tools to the registry."*

The host calls `patch_auth_register({ provider: "github" })`, Patch starts a localhost OAuth listener, hands back a URL. You click the URL, complete GitHub OAuth, and the contribute_token lands in your local config. Subsequent tool generations get pushed back to the registry under your contributor account.

Default behavior: read-only. Contributing is opt-in.

## Repo layout

This package lives in a monorepo:

- [`@patch-cat/mcp`](https://github.com/patch-cat/patch-cat/tree/main/packages/mcp) — this package, the local server.
- [`@patch-cat/registry`](https://github.com/patch-cat/patch-cat/tree/main/packages/registry) — the hosted Cloudflare Worker.
- [`@patch-cat/shared`](https://github.com/patch-cat/patch-cat/tree/main/packages/shared) — zod schemas + sanitizer.
- [`@patch-cat/docs`](https://github.com/patch-cat/patch-cat/tree/main/packages/docs) — Astro + Starlight docs site at <https://patch-cat.com>.

## License

MIT.
