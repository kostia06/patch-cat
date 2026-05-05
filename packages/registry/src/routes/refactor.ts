// Refactor proposals endpoints.
//
// GET  /v1/refactor/proposals?status=pending_generation|verified|equivalence_failed
// GET  /v1/refactor/proposals/:id
// POST /v1/refactor/proposals/:id/result   — auth required (the GHA runner)
//
// The GHA runner reads pending proposals, generates merged source, runs
// equivalence checks in e2b, and POSTs the result back. Rows are never
// deleted; failed equivalence checks remain visible for transparency.

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { jsonError, requireAuth } from "../auth.js";
import { getDb } from "../db/client.js";
import { type RefactorProposal, refactorProposals } from "../db/schema.js";
import type { AppVariables, Env } from "../env.js";

const StatusSchema = z.enum([
  "pending_generation",
  "generating",
  "verified",
  "equivalence_failed",
  "accepted",
  "rejected",
]);

const ResultSchema = z.object({
  status: StatusSchema,
  proposed_manifest_yaml: z.string().optional(),
  proposed_source_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  equivalence_failure_reason: z.string().optional(),
  runner_log_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const refactorRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

refactorRouter.get("/v1/refactor/proposals", async (c) => {
  const status = c.req.query("status");
  const parsed = status ? StatusSchema.safeParse(status) : null;
  if (parsed && !parsed.success) {
    return jsonError(c, 400, "invalid_status", parsed.error.message);
  }

  const db = getDb(c.env.DATABASE_URL);
  let rows: RefactorProposal[];
  try {
    rows = parsed
      ? await db.select().from(refactorProposals).where(eq(refactorProposals.status, parsed.data))
      : await db.select().from(refactorProposals);
  } catch (error) {
    return jsonError(
      c,
      500,
      "db_select_proposals_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  return c.json({ proposals: rows.map(serializeProposal) });
});

refactorRouter.get("/v1/refactor/proposals/:id", async (c) => {
  const id = c.req.param("id");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) {
    return jsonError(c, 400, "invalid_id", "id must be a uuid.");
  }

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select()
    .from(refactorProposals)
    .where(eq(refactorProposals.id, id))
    .limit(1);

  if (!row) {
    return jsonError(c, 404, "proposal_not_found", `No proposal with id ${id}.`);
  }
  return c.json(serializeProposal(row));
});

refactorRouter.post("/v1/refactor/proposals/:id/result", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) {
    return jsonError(c, 400, "invalid_id", "id must be a uuid.");
  }

  const body = await c.req.json().catch(() => null);
  const parsed = ResultSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_body", parsed.error.message);
  }

  const db = getDb(c.env.DATABASE_URL);
  try {
    const [updated] = await db
      .update(refactorProposals)
      .set({
        status: parsed.data.status,
        proposedManifestYaml: parsed.data.proposed_manifest_yaml ?? null,
        proposedSourceSha256: parsed.data.proposed_source_sha256 ?? null,
        equivalenceFailureReason: parsed.data.equivalence_failure_reason ?? null,
        runnerLogSha256: parsed.data.runner_log_sha256 ?? null,
        updatedAt: new Date(),
      })
      .where(eq(refactorProposals.id, id))
      .returning();

    if (!updated) {
      return jsonError(c, 404, "proposal_not_found", `No proposal with id ${id}.`);
    }
    return c.json(serializeProposal(updated));
  } catch (error) {
    return jsonError(
      c,
      500,
      "db_update_proposal_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
});

function serializeProposal(row: RefactorProposal) {
  return {
    id: row.id,
    tool_a: { name: row.toolNameA, version: row.toolVersionA },
    tool_b: { name: row.toolNameB, version: row.toolVersionB },
    similarity: row.similarity / 1000,
    status: row.status,
    proposed_manifest_yaml: row.proposedManifestYaml,
    proposed_source_sha256: row.proposedSourceSha256,
    equivalence_failure_reason: row.equivalenceFailureReason,
    runner_log_sha256: row.runnerLogSha256,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}
