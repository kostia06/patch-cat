# Launch artifacts

Drafts of every external-facing piece of copy for the v1.0 launch. **Nothing in this file is meant to be auto-published** — every submission is operator-driven. Treat this as the canonical text; tweak the voice to taste, then post.

Order of operations on launch day:

1. Confirm patch-cat.com is live (Cloudflare Pages deploy, DNS propagated).
2. Confirm `npm publish --provenance` succeeded for `@patch-cat/mcp@1.0.0`.
3. Submit to Smithery + Glama (manual UI).
4. Publish blog post to `/blog/launching-patch` (already in repo at `packages/docs/src/pages/blog/launching-patch.md`).
5. Submit HN post (text below). Be present in the thread for 4 hours.
6. ~30 min after HN goes live, post the Twitter thread.

---

## Hacker News submission

**Title** (declarative, no hype, ≤80 chars):

```
Show HN: Patch – an MCP server that lets AI assistants build their own tools
```

Alternates if the first lands flat:

- *Patch: AI assistants that build and remember their own tools*
- *Show HN: Self-extending toolbox for Claude/Cursor/Windsurf via MCP*
- *Show HN: Patch – AI agents grow their own Python toolbox over time*

**URL field:** `https://patch-cat.com/blog/launching-patch`

(Not the GitHub. The blog post has more context, the threat model is one click away, and HN's algorithm rewards engaging text content over README-style repos.)

**First comment from the author** (post immediately after submitting):

```
Author here. Quick context HN doesn't get from the title:

Patch is an MCP server. The host AI (Claude Desktop, Cursor, Claude Code,
Windsurf) calls patch_generate_tool when it needs a capability it doesn't
have. Patch generates a Python tool, sandbox-tests it in e2b, persists it
to your local toolbox, and registers it dynamically. Restart your host;
the tool is still there. Asking the same task tomorrow doesn't regenerate.

There's a public registry — when another Patch user has already
contributed a similar tool, you pull instead of regenerate. No LLM call.

The post has the architecture and threat model. The threat model has the
section everyone else skips: what's still possible. I'd rather lose people
on the read-the-honest-version than win them on a half-truth.

Install:
  npx -y @patch-cat/mcp
  (drop into your host's MCP config, restart)

Repo: https://github.com/patch-cat/patch-cat
Threat model: https://patch-cat.com/threat-model

Happy to dig into any of: how capabilities are enforced (e2b sandbox config,
not LLM promises), how the cross-vendor quarantine LLM works, why the
self-refactoring runner skips e2b equivalence verification in v0.4 and what
that means for v0.5.
```

**Engagement playbook:**

- Reply to every top-level comment for the first 4 hours. Engineering questions get engineering answers; skepticism gets honest replies, not defensiveness.
- If someone says "this is just RAG for tools" — agree, point out where it isn't (capability enforcement, taint tracking, immutable versions).
- If someone says "the host AI can already write Python" — agree, that's the point; the question is whether it should re-write the same Python every time.
- **If someone says "but the host AI's judgment is what's stopping the bad case in your demo"** — say "yes, and that's why we don't take credit for it. The demo I'd believe is the runtime test that drives `invokeTool` directly through an MCP client with no host in the loop. It's at `packages/mcp/src/security-integration.test.ts` and it passes today. That's the load-bearing defense; the host AI refusing is a redundant layer."
- If someone finds a security issue in the comments, **redirect to security@patch-cat.com**. Don't debug in public.

---

## Twitter / X thread

Post times: ~30 min after HN goes live, Tuesday morning Eastern.

**Tweet 1** (with the 90-second demo video as native upload — record/edit before launch day):

```
The capability layer for AI assistants.

Patch is an MCP server that lets your host AI (Claude Desktop, Cursor,
Claude Code, Windsurf) build a permanent toolbox of Python tools — and
pull from a community registry shaped by every Patch user.

[demo video here]
```

**Reply 2:**

```
Repo + the part nobody else writes (the "what's still possible" section
of the threat model):

→ https://github.com/patch-cat/patch-cat
→ https://patch-cat.com/threat-model
```

**Reply 3:**

```
Install in 30 seconds — npx command + JSON snippet → quickstart at
https://patch-cat.com/quickstart

You'll need an Anthropic API key + e2b API key. Free tiers cover most
use; you can read from the registry without contributing anything back.
```

**Reply 4** (the technical depth tweet — for the engineering audience):

```
A few design choices that mattered:

1. Capability scopes enforced by sandbox config, not by trusting the
   generated Python (network: false → e2b allowInternetAccess: false).
2. Quarantine LLM is on a different vendor (Llama on Cloudflare Workers AI)
   so a single-vendor jailbreak doesn't break the whole chain.
3. Taint blocking is enforced at the runtime layer, not by hoping the
   host AI notices. We don't take credit for Claude's good judgment;
   the runtime test drives invokeTool directly with no host in the loop.
4. Replay is honest: outputs match yes / no / n/a-because-non-deterministic.

We sweated #3 and #4 specifically because most "audit trails" and
"taint tracking" gloss over what they can't actually prove.
```

**Optional reply 5** (only if the response is good — don't add this one
defensively):

```
What's NOT in v1: filesystem capability enforcement (e2b SDK doesn't
expose a knob yet), full Arcade integration for OAuth-mediated tools,
auto-execution of accepted refactoring proposals. Documented honestly
in the threat model. v1.1 starts on those.
```

**Tagging policy:** only tag accounts that genuinely fit the post. Anthropic
devrel + e2b + Cloudflare devrel + Arcade + Simon Willison fit; spamming
tags hurts more than it helps.

---

## Smithery submission

Submit via <https://smithery.ai/submit> using `smithery.yaml` in the repo
root. The yaml file is the source of truth — DO NOT retype it in the form;
paste the full file contents.

**Listing description** (≤200 chars):

```
An MCP server that lets your AI assistant generate, sandbox, and reuse
Python tools — with a community registry of pre-built tools.
```

**Long description (Markdown supported):**

```markdown
Patch turns your AI host (Claude Desktop, Cursor, Claude Code, Windsurf)
into an assistant with a permanent Python toolbox. When the host hits a
capability it doesn't have, Patch:

1. Searches the public registry for an existing tool that fits.
2. If a high-quality match exists, pulls it; otherwise generates one
   locally via Claude Opus.
3. Sandbox-tests every tool in e2b before persisting.
4. Saves to your local toolbox; subsequent calls are no-LLM.

**Defenses:** Unicode injection sanitizer, cross-vendor quarantine LLM
(Llama 3.3 on Cloudflare for cross-vendor isolation from Anthropic),
taint tracking with confirmation gating, capability enforcement at the
sandbox layer, OAuth-mediated external auth via Arcade.

**Forensic audit:** every run produces a content-addressed audit blob;
the patch_replay MCP tool reproduces past runs with honest output_match
reporting (yes / no / n/a-due-to-non-determinism).

Full threat model: <https://patch-cat.com/threat-model>
```

**Categories:** Developer Tools, Code Execution, Registry, Security

**Screenshots:** the lineage HTML rendered in dark mode + the demo video first frame.

---

## Glama submission

Submit via <https://glama.ai/mcp/submit>. Glama's form takes name +
description + npx command + GitHub URL — content is similar to Smithery,
just pasted into their fields. Use the same long description as above.

---

## Anthropic's official MCP directory

Check `https://modelcontextprotocol.io` for the latest submission flow
on launch day. As of this writing, public submissions are open via PR to
the `modelcontextprotocol/servers` repo's README. Add a row to the
"Community" section pointing to `@patch-cat/mcp` with a one-line
description and the GitHub URL.

---

## Email outreach (if your launch needs the air-cover)

**Anthropic devrel** (alex@anthropic.com or wherever):

```
Hi —

Shipping an MCP server today called Patch. Lets the host AI (Claude
Desktop in particular) build and persist its own Python tools, with
a hosted community registry. Threat model is the part I'd love your
team to look at — cross-vendor quarantine LLM via Workers AI, capability
enforcement at the sandbox config layer, taint tracking with confirmation
gating.

Repo: https://github.com/patch-cat/patch-cat
Threat model: https://patch-cat.com/threat-model

If a member of the devrel team has 5 min to skim, I'd appreciate a sanity
check on the MCP integration patterns specifically — patch_replay returning
output_match: na_non_deterministic for tools that hit live APIs is the kind
of design that I think you'd appreciate but want to confirm reads correctly
to other host implementers.

No pressure to reply.
```

**e2b devrel:**

```
Hi —

Built an MCP server (Patch) that uses e2b as the sandbox boundary.
Capability scopes from the manifest map to sandbox.create({
allowInternetAccess: false }) when the tool declares network: false.

The thing I'd love feedback on if you have 5 min: filesystem capability
enforcement. The manifest has 'filesystem: read-only' but I couldn't find
a documented SDK knob for it in @e2b/code-interpreter. Currently honest
about this as a v0.4.x gap. Is there a path I missed?

Repo: https://github.com/patch-cat/patch-cat
Section: https://patch-cat.com/threat-model#whats-still-possible
```

---

## v1.0 cut

After the launch traffic settles (a few days post-launch with no breaking
issues), tag and publish:

```bash
# Bump packages/mcp/package.json version to 1.0.0
git commit -am "release @patch-cat/mcp v1.0.0"
git tag v1.0.0
git push origin main v1.0.0
# GitHub Actions release workflow handles npm publish --provenance
```

Update <https://patch-cat.com> to add the v1.0 stability commitments line:
*"From v1.0, the manifest contract and registry API follow semver; breaking
changes ship behind a major version bump only."*
