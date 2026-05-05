# Registry evolution

How tools in the public registry are merged, deprecated, and superseded over time. This page documents the v0.4 self-refactoring scaffolding — what it does, what it doesn't, and which knobs are tunable.

## Why this exists

The public registry will accrue near-duplicates organically: ten different users will independently generate `fetch_url`, `get_url`, `download_url`, and `http_get`. Without intervention the registry becomes noise. The self-refactoring job's job is to **propose** merged successors — not to silently replace anyone's tool. Every proposal is reviewable; nothing is auto-adopted in v0.4.

## The pipeline (v0.4)

1. **Cloudflare Worker cron (nightly, 03:17 UTC)** runs `findAndQueueCandidates`. Pairs of tools where:
   - cosine similarity of description embeddings ≥ `SIMILARITY_THRESHOLD` (currently **0.92**)
   - both have `success_count` ≥ `MIN_SUCCESS_COUNT` (currently **50**)
   - both at major version `1.x.y`

   …get inserted as `refactor_proposals` rows with `status=pending_generation`. The unique index on `(tool_name_a, tool_name_b)` makes the insert idempotent — re-runs don't create duplicates.

2. **GitHub Actions cron (04:00 UTC)** runs `scripts/refactor-runner.mjs`. For each pending proposal (capped at 5 per run):
   - Fetches both tools' source from the registry's R2 URLs.
   - Calls Claude Opus with a system prompt asking for a single merged tool that subsumes both, with version `2.0.0`.
   - Marks the proposal as `verified` (or `equivalence_failed` if anything goes wrong).
   - Stores the proposed source's SHA-256 (the actual source goes to R2 in v0.5; for v0.4 we just keep the manifest YAML in the row).

3. **Original contributors review the proposal** (no email notification in v0.4 — visible only via the `/v1/refactor/proposals` endpoint or a future docs UI). On accept, the v2 becomes the canonical version going forward; on reject, the proposal stays visible as a record.

## Knobs

All defined in `packages/registry/src/jobs/find-candidates.ts`. Conservative defaults to minimize false positives at the cost of missed merges:

| Constant | Default | Rationale |
|----------|---------|-----------|
| `SIMILARITY_THRESHOLD` | 0.92 | Below 0.85 the proposals are noisy; above 0.95 we miss legitimate near-duplicates. 0.92 is empirically the sweet spot. Revisit after 30 days of operator feedback. |
| `MIN_SUCCESS_COUNT` | 50 | Avoids proposing merges of tools nobody uses. Ties into the verified-contributor threshold (100) one notch down — popular but not battle-tested. |
| `MAX_PROPOSALS_PER_RUN` | 5 (in `refactor-runner.mjs`) | Caps cost. At ~$0.05 per Opus call, 5/day = ~$7.50/month. |

## What the runner does NOT do (v0.4)

- **No automated equivalence verification.** The runner generates the merged source and trusts that the human review will catch behavioral mismatches. v0.5 adds e2b-based equivalence: run both originals + the proposal against shared inputs sourced from `tool_runs` history, declare pass if outputs match.
- **No auto-adoption.** Even after `verified`, the proposal sits in the table. v1.x adds a contributor approval flow + an MCP tool that pulls the new version into local toolboxes.
- **No notifications.** Resend integration was scoped out for v0.4 to reduce the launch surface. Phase 5: opt-in mailing list for refactoring proposals.
- **No proposal source storage in R2.** v0.4 keeps just the manifest YAML in the DB row. v0.5 will write the full source to R2 like any contributed tool, content-addressed by SHA-256.

## How to verify

Once the registry is deployed and pre-seeded with ≥ 18 tools:

1. Manually insert two near-duplicate tools (or pre-seed `fetch_url` and `get_url` and let the cron find them).
2. Wait for the next dev cron tick (`*/30` minutes on dev env), or trigger manually:
   ```bash
   wrangler dev --env dev --test-scheduled
   curl http://localhost:8787/__scheduled?cron=*+*+*+*+*
   ```
3. Confirm the proposal row exists:
   ```bash
   curl https://patchcat-registry-dev.<acct>.workers.dev/v1/refactor/proposals?status=pending_generation
   ```
4. Trigger the GHA runner manually via `workflow_dispatch` from the GitHub Actions UI.
5. Re-fetch proposals, confirm status moved to `verified` and `proposed_manifest_yaml` is populated.
