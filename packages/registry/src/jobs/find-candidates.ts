// Nightly candidate-finder. Looks for pairs of tools where:
//   1. Cosine similarity of description embeddings ≥ SIMILARITY_THRESHOLD
//   2. Both have success_count ≥ MIN_SUCCESS_COUNT
//   3. Both at major version 1 (semver "1.x.y")
// For each candidate pair we don't already have a proposal for, insert a row
// into refactor_proposals with status=pending_generation. The GHA runner
// picks these up and generates merged proposals.

import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Tunable thresholds. Documented in docs/registry-evolution.md.
 * Phase 4 picks these conservatively so v0.4 surfaces few false positives;
 * Phase 5 may relax based on observed proposal acceptance rates.
 */
export const SIMILARITY_THRESHOLD = 0.92;
export const MIN_SUCCESS_COUNT = 50;

interface CandidateRow extends Record<string, unknown> {
  name_a: string;
  version_a: string;
  name_b: string;
  version_b: string;
  similarity: number;
}

export interface CandidateFinderResult {
  inspected_pairs: number;
  inserted: number;
}

export async function findAndQueueCandidates(db: Db): Promise<CandidateFinderResult> {
  // Pairwise self-join on tools, restricted to v1.x and popular tools, ranked
  // by cosine distance. We hard-cap the candidate set per run so a runaway
  // index can't fan out the GHA runner queue.
  const result = await db.execute<CandidateRow>(sql`
    SELECT
      a.name AS name_a,
      a.latest_version AS version_a,
      b.name AS name_b,
      b.latest_version AS version_b,
      1 - (a.embedding <=> b.embedding) AS similarity
    FROM tools a
    JOIN tools b
      ON a.name < b.name
     AND a.embedding IS NOT NULL
     AND b.embedding IS NOT NULL
    WHERE a.success_count >= ${MIN_SUCCESS_COUNT}
      AND b.success_count >= ${MIN_SUCCESS_COUNT}
      AND a.latest_version LIKE '1.%'
      AND b.latest_version LIKE '1.%'
      AND (1 - (a.embedding <=> b.embedding)) >= ${SIMILARITY_THRESHOLD}
    ORDER BY (1 - (a.embedding <=> b.embedding)) DESC
    LIMIT 50
  `);

  const candidates = result.rows;
  let inserted = 0;

  for (const row of candidates) {
    const sim = Math.min(1000, Math.max(0, Math.round(Number(row.similarity) * 1000)));
    const insertResult = await db.execute(sql`
      INSERT INTO refactor_proposals (
        tool_name_a, tool_version_a, tool_name_b, tool_version_b, similarity_x1000, status
      ) VALUES (
        ${row.name_a}, ${row.version_a}, ${row.name_b}, ${row.version_b}, ${sim}, 'pending_generation'
      )
      ON CONFLICT (tool_name_a, tool_name_b) DO NOTHING
      RETURNING id
    `);
    if (insertResult.rows.length > 0) inserted += 1;
  }

  return { inspected_pairs: candidates.length, inserted };
}
