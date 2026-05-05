#!/usr/bin/env node
// scripts/verify-registry.mjs
// 60-second boot smoke for a deployed @patch-cat/registry Worker.
// Each step verifies one boundary — Worker boot, Workers AI binding, Drizzle/Neon,
// pgvector, R2 put, R2 public read, OAuth requireAuth wiring.
//
// Failures print:
//   - which numbered step,
//   - which subsystem the failure points at,
//   - the registry's structured error envelope (if any),
//   - actionable next-step hints.
//
// Usage:
//   node --env-file=.env scripts/verify-registry.mjs --registry-url <url>
//
// Required env vars:
//   PATCH_CONTRIBUTE_TOKEN   Bearer token for an authenticated contributor.
//                            Optional: if missing, write-path tests are skipped.

import { randomBytes } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args["registry-url"] ?? process.env.PATCH_REGISTRY_URL ?? "").replace(/\/$/, "");

if (!baseUrl) {
  fail(
    "Missing --registry-url and PATCH_REGISTRY_URL not in env. Pass the deployed Worker URL:\n  node ... scripts/verify-registry.mjs --registry-url https://patchcat-registry-dev.YOURACCT.workers.dev",
  );
}

const contributeToken = process.env.PATCH_CONTRIBUTE_TOKEN ?? null;
const skipWrites = !contributeToken;

console.log(`registry: ${baseUrl}`);
console.log(`writes:   ${skipWrites ? "SKIPPED (no PATCH_CONTRIBUTE_TOKEN)" : "enabled"}\n`);

const failures = [];
const passes = [];

// ============================================================
// Step 1 — Worker boots and root route works
// ============================================================
await runStep("1", "Worker boot — GET /", async () => {
  const res = await fetch(`${baseUrl}/`);
  expectStatus(res, 200, "Worker is not responding. Check `wrangler tail` and the deployed URL.");
  const body = await res.json();
  if (body.service !== "patch-cat-registry") {
    throw subsystem(
      "wrangler_routing",
      `Root route returned wrong service identifier: ${JSON.stringify(body)}. Worker may be misconfigured.`,
    );
  }
});

// ============================================================
// Step 2 — Health
// ============================================================
await runStep("2", "Health — GET /health", async () => {
  const res = await fetch(`${baseUrl}/health`);
  expectStatus(res, 200, "Health endpoint missing — routing issue.");
});

// ============================================================
// Step 3 — Search (validates Workers AI + Neon + pgvector)
// ============================================================
await runStep("3", "Search — GET /v1/tools/search?q=test", async () => {
  const res = await fetch(`${baseUrl}/v1/tools/search?q=test+query&limit=3`);
  if (res.status === 200) {
    const body = await res.json();
    if (!body || !Array.isArray(body.results)) {
      throw subsystem(
        "registry_response_shape",
        `Search returned 200 but body.results is missing or not an array: ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return; // empty results OK on a fresh registry
  }

  const envelope = await safeJson(res);
  const code = envelope?.error?.code ?? `http_${res.status}`;
  const msg = envelope?.error?.message ?? `(no message)`;

  switch (code) {
    case "ai_embed_failed":
      throw subsystem(
        "workers_ai",
        `${msg}\n  Likely: AI binding not configured in wrangler.toml, or model "@cf/baai/bge-base-en-v1.5" name changed.\n  Verify: wrangler.toml [ai] binding="AI" and confirm the model id at https://developers.cloudflare.com/workers-ai/models/`,
      );
    case "db_search_failed":
      throw subsystem(
        "pgvector_or_neon",
        `${msg}\n  Likely causes:\n    - DATABASE_URL secret not set / wrong\n    - Neon project paused (free-tier suspends after inactivity — wake it via the dashboard)\n    - pgvector extension not installed: run \`CREATE EXTENSION IF NOT EXISTS vector;\` against the DB\n    - HNSW index missing: re-run drizzle/0000_init.sql\n    - vector(768) column type mismatch with embedded query`,
      );
    case "invalid_query":
      throw subsystem("smoke_bug", `Smoke sent an invalid query — bug in this script: ${msg}`);
    default:
      throw subsystem(
        "search_unknown",
        `Unexpected error code "${code}": ${msg}\n  Run \`wrangler tail\` while re-running this step to see the Worker's stderr.`,
      );
  }
});

// ============================================================
// Step 4 — Auth boundary (POST without bearer should 401)
// ============================================================
await runStep("4", "Auth gate — POST /v1/tools without bearer (expect 401)", async () => {
  const res = await fetch(`${baseUrl}/v1/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: {}, source: "" }),
  });

  if (res.status === 200) {
    throw subsystem(
      "auth_bypass_critical",
      `POST /v1/tools without auth returned 200 — the requireAuth middleware is NOT wired. This is a critical security regression. Check packages/registry/src/routes/contribute.ts and confirm requireAuth is in the chain.`,
    );
  }

  if (res.status !== 401) {
    const envelope = await safeJson(res);
    throw subsystem(
      "auth_unexpected",
      `Expected 401 from unauthed POST, got ${res.status}. Envelope: ${JSON.stringify(envelope)}`,
    );
  }
});

// ============================================================
// Step 5 — Authed contribute (validates R2 put + AI embed + DB inserts)
// ============================================================
let smokeToolName, smokeToolSha, smokeToolSourceUrl;

if (skipWrites) {
  console.log(`5  Authed contribute — SKIPPED (no PATCH_CONTRIBUTE_TOKEN)`);
} else {
  await runStep(
    "5",
    "Authed contribute — POST /v1/tools (R2 + AI + DB)",
    async () => {
      const suffix = randomBytes(3).toString("hex");
      smokeToolName = `smoke_test_${suffix}`;

      const manifest = {
        name: smokeToolName,
        version: "1.0.0",
        description: `Synthetic smoke-test tool created by verify-registry.mjs at ${new Date().toISOString()}.`,
        inputs: [
          {
            name: "x",
            type: "string",
            description: "Throwaway input.",
            required: true,
            tainted_ok: false,
          },
        ],
        outputs: { type: "string", description: "Echoes the input." },
        capabilities: { network: false, filesystem: "none", human_confirm: false },
        runtime: { language: "python", python_version: "3.12", packages: [] },
        generated_by: "verify-registry.mjs",
        generated_at: new Date().toISOString(),
      };

      const source = serializeSmokeSource(manifest);

      const res = await fetch(`${baseUrl}/v1/tools`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${contributeToken}`,
        },
        body: JSON.stringify({ manifest, source }),
      });

      if (res.status === 200) {
        const body = await res.json();
        if (!body.source_sha256 || body.source_sha256.length !== 64) {
          throw subsystem(
            "registry_response_shape",
            `Contribute returned 200 but source_sha256 missing/malformed: ${JSON.stringify(body)}`,
          );
        }
        smokeToolSha = body.source_sha256;
        return;
      }

      const envelope = await safeJson(res);
      const code = envelope?.error?.code ?? `http_${res.status}`;
      const msg = envelope?.error?.message ?? "(no message)";

      switch (code) {
        case "missing_token":
        case "invalid_token":
          throw subsystem(
            "contribute_token",
            `${msg}\n  Token is missing/invalid/expired. Re-run patch_auth_register from your MCP host to mint a new one and update PATCH_CONTRIBUTE_TOKEN.`,
          );
        case "r2_put_failed":
          throw subsystem(
            "r2",
            `${msg}\n  Likely causes:\n    - R2 bucket binding not configured: wrangler.toml [[r2_buckets]] binding="PATCH_TOOLS_BUCKET" and bucket_name correct\n    - Bucket doesn't exist: \`wrangler r2 bucket create patchcat-tools-dev\`\n    - Worker IAM missing PutObject\n    - Bucket name typo between wrangler.toml env sections`,
          );
        case "ai_embed_failed":
          throw subsystem(
            "workers_ai",
            `${msg}\n  Workers AI binding likely missing in wrangler.toml. See [ai] block.`,
          );
        case "db_insert_tool_failed":
        case "db_update_tool_failed":
          throw subsystem(
            "neon_or_pgvector_insert",
            `${msg}\n  Likely causes:\n    - vector(768) column expects a 768-dim array; embedDescription returned wrong shape\n    - DATABASE_URL points at the wrong DB (no schema applied)\n    - contributors row referenced by contributor_id does not exist (token mismatch?)\n    - Drizzle's vector serialization may need explicit \`::vector\` cast — log the SQL via wrangler tail`,
          );
        case "db_insert_version_failed":
          throw subsystem(
            "neon_versions_insert",
            `${msg}\n  tool_versions row insert failed. Most likely the unique index (tool_name, version) constraint is misconfigured.`,
          );
        case "name_taken":
          throw subsystem(
            "contributor_collision",
            `${msg}\n  This shouldn't happen on a randomized smoke name — the contributor in the bearer token differs from the tool's prior owner. Check that PATCH_CONTRIBUTE_TOKEN belongs to the same contributor across runs.`,
          );
        default:
          throw subsystem(
            "contribute_unknown",
            `Unexpected error code "${code}": ${msg}\n  Run \`wrangler tail\` and re-run this step.`,
          );
      }
    },
  );
}

// ============================================================
// Step 6 — Read back the contributed tool (validates DB read + manifest YAML round-trip)
// ============================================================
if (!skipWrites && smokeToolName) {
  await runStep(
    "6",
    `Read back — GET /v1/tools/${smokeToolName}`,
    async () => {
      const res = await fetch(`${baseUrl}/v1/tools/${smokeToolName}`);
      if (res.status === 200) {
        const body = await res.json();
        if (body.name !== smokeToolName) {
          throw subsystem(
            "registry_response_shape",
            `GET returned wrong name: ${body.name} vs ${smokeToolName}`,
          );
        }
        if (!body.source_url) {
          throw subsystem(
            "registry_response_shape",
            `GET response missing source_url. Body: ${JSON.stringify(body).slice(0, 300)}`,
          );
        }
        if (body.source_sha256 !== smokeToolSha) {
          throw subsystem(
            "sha256_drift",
            `Source SHA-256 from GET (${body.source_sha256.slice(0, 12)}…) does not match POST response (${smokeToolSha.slice(0, 12)}…).`,
          );
        }
        smokeToolSourceUrl = body.source_url;
        return;
      }

      const envelope = await safeJson(res);
      const code = envelope?.error?.code ?? `http_${res.status}`;
      const msg = envelope?.error?.message ?? "(no message)";

      switch (code) {
        case "tool_not_found":
          throw subsystem(
            "db_read_consistency",
            `Tool was just contributed but GET says not_found. Likely Neon read replica lag (rare with neon-http) or the contribute path silently rolled back.`,
          );
        case "manifest_invalid":
        case "manifest_unparseable":
          throw subsystem(
            "yaml_roundtrip",
            `${msg}\n  The manifest stored as YAML doesn't round-trip back through parseManifest. Check serializeManifest's YAML.dump options.`,
          );
        case "db_select_tool_failed":
          throw subsystem(
            "neon_read",
            `${msg}\n  DATABASE_URL access issue or schema missing.`,
          );
        default:
          throw subsystem(
            "tool_get_unknown",
            `Unexpected error code "${code}": ${msg}`,
          );
      }
    },
  );
}

// ============================================================
// Step 7 — Fetch source from R2 public URL
// ============================================================
if (!skipWrites && smokeToolSourceUrl) {
  await runStep("7", `R2 public read — GET ${truncate(smokeToolSourceUrl, 60)}`, async () => {
    const res = await fetch(smokeToolSourceUrl);
    if (res.status !== 200) {
      throw subsystem(
        "r2_public_access",
        `R2 returned ${res.status} for ${smokeToolSourceUrl}.\n  Likely causes:\n    - Bucket public access NOT enabled in Cloudflare dashboard\n    - PUBLIC_R2_HOST in wrangler.toml [vars] points at the wrong host\n    - r2.dev URL changed\n    - CORS misconfigured (less common for direct fetch)`,
      );
    }
    const body = await res.text();
    if (!body.startsWith("# ---")) {
      throw subsystem(
        "r2_content_drift",
        `R2 returned 200 but body doesn't start with frontmatter delimiter. First 100 chars: ${body.slice(0, 100)}`,
      );
    }
  });
}

// ============================================================
// Summary
// ============================================================

console.log(`\n══════════════════════════════════════`);
if (failures.length === 0) {
  console.log(`  PASSED — ${passes.length} steps green`);
  if (skipWrites) {
    console.log(`  (writes skipped — set PATCH_CONTRIBUTE_TOKEN to exercise R2 + DB writes)`);
  }
  console.log(`══════════════════════════════════════`);
  process.exit(0);
} else {
  console.log(`  FAILED — ${failures.length} step(s)`);
  console.log(`══════════════════════════════════════\n`);
  for (const f of failures) {
    console.log(`Step ${f.step}: ${f.title}`);
    console.log(`  subsystem: ${f.subsystem}`);
    console.log(`  ${f.message.split("\n").join("\n  ")}\n`);
  }
  process.exit(1);
}

// ============================================================
// Helpers
// ============================================================

async function runStep(num, title, fn) {
  process.stdout.write(`${num.padEnd(3)}${title} ... `);
  try {
    await fn();
    console.log("✓");
    passes.push({ step: num, title });
  } catch (error) {
    console.log("✗");
    failures.push({
      step: num,
      title,
      subsystem: error.subsystem ?? "uncategorized",
      message: error.message,
    });
  }
}

function expectStatus(res, expected, hint) {
  if (res.status !== expected) {
    throw subsystem(
      "http_unexpected",
      `Expected ${expected}, got ${res.status} ${res.statusText}.\n  ${hint}`,
    );
  }
}

function subsystem(name, message) {
  const err = new Error(message);
  err.subsystem = name;
  return err;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      out[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function serializeSmokeSource(manifest) {
  const lines = [
    "# ---",
    `# name: ${manifest.name}`,
    `# version: ${manifest.version}`,
    `# description: ${manifest.description}`,
    `# inputs:`,
    `#   - name: x`,
    `#     type: string`,
    `#     description: Throwaway input.`,
    `#     tainted_ok: false`,
    `# outputs:`,
    `#   type: string`,
    `#   description: Echoes the input.`,
    `# capabilities:`,
    `#   network: false`,
    `#   filesystem: none`,
    `#   human_confirm: false`,
    `# runtime:`,
    `#   language: python`,
    `#   python_version: "3.12"`,
    `#   packages: []`,
    `# generated_by: ${manifest.generated_by}`,
    `# generated_at: ${manifest.generated_at}`,
    "# ---",
    "",
    "import json, sys",
    "",
    "def main(x: str):",
    "    return x",
    "",
    'if __name__ == "__main__":',
    "    args = json.loads(sys.stdin.read())",
    "    print(json.dumps(main(**args)))",
    "",
  ];
  return lines.join("\n");
}
