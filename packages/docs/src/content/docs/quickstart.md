---
title: Quickstart
description: Install Patch in 30 seconds. Add the npx command to your MCP host's config, restart, and Patch is live.
---

You'll need:

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com)
- An [e2b API key](https://e2b.dev) (free tier is plenty)

## 1. Add Patch to your MCP host

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Cursor

Edit `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`):

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

### Claude Code

```bash
claude mcp add patch-cat --scope user \
  --env ANTHROPIC_API_KEY=sk-ant-... \
  --env E2B_API_KEY=e2b_... \
  -- npx -y @patch-cat/mcp
```

### Windsurf

Same JSON shape as Claude Desktop, in Windsurf's MCP config. Path varies by version; consult Windsurf's docs.

## 2. Restart your host

The host loads MCP servers at startup. After editing config, fully quit and relaunch Claude Desktop (or whichever host you're using).

## 3. Try a task that needs a tool

In the host:

> *"Fetch the top 5 stories from Hacker News and rank them by points."*

The host will call `patch_generate_tool` with that description. Patch:

1. Asks Claude Opus for a Python tool in the manifest format.
2. Runs `py_compile` on the result inside an e2b sandbox.
3. Saves the file to your local toolbox.
4. Notifies the host (via `notifications/tools/list_changed`) that a new tool is available.

The new tool appears in your host's tool list within ~1 second. The host then calls it directly. Patch spins up a sandbox, runs `pip install`, executes the tool, parses the JSON output, returns it.

Quit and reopen the host. Ask the same question again. Patch uses the existing tool — no LLM call, no regeneration. **The toolbox is permanent.**

## What's at the local toolbox path

Resolved via [`env-paths`](https://www.npmjs.com/package/env-paths):

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/patch-cat/` |
| Linux    | `~/.config/patch-cat/` |
| Windows  | `%APPDATA%\patch-cat\` |

Inside:

```
patch-cat/
├── tools/             one .py file per tool, manifest frontmatter + source
├── index.json         tool name → version, file path, last-used timestamp
├── runs/              forensic audit log — one .json per execution
│   └── blobs/         content-addressed stdout/stderr by SHA-256
└── config.json        registry URL, contribute opt-in, etc.
```

## Enabling the registry contribute path

Default behavior: Patch reads from the public registry but doesn't contribute. To opt in:

In your host AI, ask:

> *"Use patch_auth_register to authorize me to contribute tools to the registry."*

The host calls `patch_auth_register({ provider: "github" })`. Patch starts a local OAuth listener, hands back a URL. Click the URL in your browser, complete GitHub OAuth, return. The contribute_token lands in your local config; subsequent tool generations get pushed back to the registry.

You can revoke at any time via the [GitHub OAuth apps page](https://github.com/settings/applications).

## What if I want to inspect what just ran?

Ask the host AI: *"Use patch_list_runs to show me the recent tool executions."*

Each run has a `run_id`. Pass it to `patch_replay` to re-run the exact same source against the same inputs in a fresh sandbox and confirm the output matches. See [Architecture → Replay](/architecture#replay) for what replay actually proves.
