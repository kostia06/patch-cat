import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const contributors = pgTable("contributors", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: integer("github_id").notNull().unique(),
  githubHandle: text("github_handle").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tools = pgTable(
  "tools",
  {
    name: text("name").primaryKey(),
    description: text("description").notNull(),
    latestVersion: text("latest_version").notNull(),
    contributorId: uuid("contributor_id")
      .notNull()
      .references(() => contributors.id, { onDelete: "restrict" }),
    embedding: vector("embedding", { dimensions: 768 }),
    useCount: integer("use_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    embeddingIdx: index("tools_embedding_hnsw_idx").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`,
    ),
  }),
);

export const toolVersions = pgTable(
  "tool_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolName: text("tool_name")
      .notNull()
      .references(() => tools.name, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    manifestYaml: text("manifest_yaml").notNull(),
    capabilitiesJson: text("capabilities_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toolVersionUnique: uniqueIndex("tool_versions_tool_version_idx").on(
      table.toolName,
      table.version,
    ),
  }),
);

export const toolRuns = pgTable(
  "tool_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolName: text("tool_name").notNull(),
    version: text("version").notNull(),
    success: boolean("success").notNull(),
    errorClass: text("error_class"),
    durationMs: integer("duration_ms").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toolNameIdx: index("tool_runs_tool_name_idx").on(table.toolName),
  }),
);

/**
 * Self-refactoring proposals. Created by the nightly Worker cron when it
 * spots a candidate pair (high similarity + both popular). The GHA runner
 * picks up rows in `pending_generation` state, generates the merged source
 * via Anthropic Opus, runs equivalence checks in e2b, and either updates
 * the row to `verified` (with the proposed source) or `equivalence_failed`.
 */
export const refactorProposals = pgTable(
  "refactor_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolNameA: text("tool_name_a").notNull(),
    toolVersionA: text("tool_version_a").notNull(),
    toolNameB: text("tool_name_b").notNull(),
    toolVersionB: text("tool_version_b").notNull(),
    similarity: integer("similarity_x1000").notNull(), // similarity * 1000 as int (0-1000)
    status: text("status").notNull().default("pending_generation"),
    proposedManifestYaml: text("proposed_manifest_yaml"),
    proposedSourceSha256: text("proposed_source_sha256"),
    equivalenceFailureReason: text("equivalence_failure_reason"),
    runnerLogSha256: text("runner_log_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: uniqueIndex("refactor_proposals_pair_idx").on(
      table.toolNameA,
      table.toolNameB,
    ),
    statusIdx: index("refactor_proposals_status_idx").on(table.status),
  }),
);

export type Contributor = typeof contributors.$inferSelect;
export type Tool = typeof tools.$inferSelect;
export type ToolVersion = typeof toolVersions.$inferSelect;
export type ToolRun = typeof toolRuns.$inferSelect;
export type RefactorProposal = typeof refactorProposals.$inferSelect;
