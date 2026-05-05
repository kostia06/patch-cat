-- Phase 4 — self-refactoring proposals.
-- Run this after 0000_init.sql.

CREATE TABLE IF NOT EXISTS "refactor_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name_a" text NOT NULL,
  "tool_version_a" text NOT NULL,
  "tool_name_b" text NOT NULL,
  "tool_version_b" text NOT NULL,
  "similarity_x1000" integer NOT NULL,
  "status" text DEFAULT 'pending_generation' NOT NULL,
  "proposed_manifest_yaml" text,
  "proposed_source_sha256" text,
  "equivalence_failure_reason" text,
  "runner_log_sha256" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "refactor_proposals_pair_idx"
  ON "refactor_proposals" ("tool_name_a","tool_name_b");

CREATE INDEX IF NOT EXISTS "refactor_proposals_status_idx"
  ON "refactor_proposals" ("status");
