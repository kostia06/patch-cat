import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  SearchToolsRequestSchema,
  VERIFIED_CONTRIBUTOR_THRESHOLD,
  type RegistryToolEntry,
} from "@patch-cat/shared";
import type { AppVariables, Env } from "../env.js";
import { getDb } from "../db/client.js";
import { embedDescription } from "../embeddings.js";
import { jsonError } from "../auth.js";

interface SearchRow extends Record<string, unknown> {
  name: string;
  description: string;
  latest_version: string;
  github_handle: string;
  use_count: number;
  success_count: number;
  similarity: number;
  contributor_total_use: number;
  created_at: string;
}

export const searchRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

searchRouter.get("/v1/tools/search", async (c) => {
  const parsed = SearchToolsRequestSchema.safeParse({
    q: c.req.query("q"),
    limit: c.req.query("limit"),
    include_unverified: c.req.query("include_unverified"),
  });
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_query", parsed.error.message);
  }

  const { q, limit, include_unverified } = parsed.data;
  // Fetch a few extra rows so unverified-filtering doesn't shrink the result
  // below the requested limit too often.
  const fetchLimit = include_unverified ? limit : Math.min(limit * 3, 50);

  let queryVec: number[];
  try {
    queryVec = await embedDescription(c.env.AI, q, { gatewayName: c.env.AI_GATEWAY_NAME });
  } catch (error) {
    return jsonError(
      c,
      500,
      "ai_embed_failed",
      `Workers AI embed failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const db = getDb(c.env.DATABASE_URL);
  const vectorLiteral = `[${queryVec.join(",")}]`;

  let rows;
  try {
    rows = await db.execute<SearchRow>(sql`
      SELECT
        t.name,
        t.description,
        t.latest_version,
        c.github_handle,
        t.use_count,
        t.success_count,
        1 - (t.embedding <=> ${vectorLiteral}::vector) AS similarity,
        (SELECT COALESCE(SUM(use_count), 0) FROM tools WHERE contributor_id = t.contributor_id) AS contributor_total_use,
        t.created_at
      FROM tools t
      JOIN contributors c ON c.id = t.contributor_id
      WHERE t.embedding IS NOT NULL
      ORDER BY t.embedding <=> ${vectorLiteral}::vector
      LIMIT ${fetchLimit}
    `);
  } catch (error) {
    return jsonError(
      c,
      500,
      "db_search_failed",
      `pgvector search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const allResults: RegistryToolEntry[] = rows.rows.map((row) => {
    const totalUse = Number(row.contributor_total_use) || 0;
    return {
      name: row.name,
      description: row.description,
      latest_version: row.latest_version,
      contributor: { github_handle: row.github_handle },
      use_count: Number(row.use_count) || 0,
      success_count: Number(row.success_count) || 0,
      success_rate:
        Number(row.use_count) > 0 ? Number(row.success_count) / Number(row.use_count) : null,
      similarity: clampSimilarity(Number(row.similarity)),
      verified: totalUse >= VERIFIED_CONTRIBUTOR_THRESHOLD,
      created_at: new Date(row.created_at).toISOString(),
    };
  });

  const filtered = include_unverified
    ? allResults
    : allResults.filter((r) => r.verified === true);
  const results = filtered.slice(0, limit);

  // Edge cache for 30s — search is read-only and tolerant of staleness.
  c.header("Cache-Control", "public, max-age=30");

  return c.json({ results });
});

function clampSimilarity(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
