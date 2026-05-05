# Pre-seeding the registry

Patch's first impression is its registry. An empty registry on day one means every user falls through to local generation (slower, more expensive, and nondeterministic across users). This document describes how to seed the registry with **15–20 hand-reviewed tools** under the official `patch-cat` contributor account before launch.

The pre-seed pipeline is deliberately **review-gated**: nothing is contributed without explicit `y/N` per tool. Treat the seed corpus like a curated launch — quality bar matters more than speed.

## Prerequisites

1. The registry is deployed (locally via `wrangler dev` or to your Cloudflare account).
2. `@patch-cat/mcp` is built (`pnpm build`).
3. You have valid `ANTHROPIC_API_KEY` + `E2B_API_KEY` in `.env` at the repo root.
4. You've completed GitHub OAuth as the official `patch-cat` account and saved the resulting session token.

## Step 1 — Get the official contributor token

Run `@patch-cat/mcp` connected to a host AI (Claude Code or Claude Desktop), call `patch_auth_register`, and complete OAuth as the dedicated `patch-cat` GitHub account (not your personal account). The MCP server saves the token to:

```
~/Library/Application Support/patch-cat/config.json   # macOS
~/.config/patch-cat/config.json                       # Linux
%APPDATA%\patch-cat\config.json                       # Windows
```

Look at `registry.contribute_token` in that file. Copy it to a temporary env var:

```bash
export PATCH_CONTRIBUTE_TOKEN=$(jq -r .registry.contribute_token "$XDG_CONFIG_HOME/patch-cat/config.json")
```

Or paste the value directly into `.env` for the duration of the seeding session.

## Step 2 — Run the pre-seed script

```bash
node --env-file=.env scripts/preseed.mjs \
  --registry-url https://registry.patch-cat.com \
  --tools-file scripts/seed-tools.json
```

The script walks `scripts/seed-tools.json` one entry at a time. For each:

1. Generates the tool via the real MCP server (real Anthropic Opus + e2b syntax check).
2. Prints the manifest + source code in full.
3. Prompts: `Contribute "<name>"? [y/N/q]`
   - `y` — POST to `/v1/tools` with the contribute token
   - `N` (default) — skip; nothing sent to registry
   - `q` — abort the entire run

At the end, you get a summary: generated / approved / contributed / skipped / failed.

## What to look for in review

Hard rejects:

- Tool calls a service that requires an API key the user must supply (unless declared as an input)
- Tool reads/writes filesystem outside the input path it was given
- Manifest declares `network: false` but the body imports `requests`/`urllib`
- Tool's `main()` does work at import time
- Pinned packages with no version (`requests` rather than `requests==2.32.3`)
- Source contains comments, docstrings, or stray prints unrelated to the function

Soft rejects (regenerate with a tweaked description):

- The argument names are non-obvious (`u` instead of `url`, `t` instead of `text`)
- The output shape is awkward (a list of tuples instead of objects)
- Edge cases mishandled (no timeout on HTTP calls; no pagination on search)

## Editing the seed list

`scripts/seed-tools.json` is the source of truth. Each entry has a `description` (what the tool does, in the first person) and a `name_hint` (snake_case suggestion the LLM is encouraged but not forced to use).

Add tools, remove tools, edit descriptions and re-run the script — already-contributed tools (matched by name) will return `status: "exists"` from the registry, and you can choose to skip them in the review step.

## After contribution

Verify the registry has them:

```bash
curl 'https://registry.patch-cat.com/v1/tools/search?q=fetch+a+url&limit=20' | jq .
```

Run the two-machine e2e against a fresh toolbox to confirm pulls work:

```bash
node --env-file=.env scripts/e2e-two-machine.mjs --registry-url https://registry.patch-cat.com
```

Document any seed tools that hit edge cases (e.g. `extract_youtube_transcript` requires a Python package that may not be available in e2b's default sandbox) in a follow-up issue. They can be regenerated and re-contributed later.

## Re-running the seed on a fresh registry

The seed list is deterministic in *intent* (same descriptions every run) but the LLM-generated source is not. Regenerating produces slightly different code each time. If you want bit-exact reproducibility for the launch corpus, **save the contributed `.py` files to disk** during the first run and re-upload them via a deterministic script — but for v0.2 the canonical source of truth is the registry itself. The seed list defines what to seed, not what the source must look like.
