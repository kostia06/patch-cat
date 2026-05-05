-- Run this once on a fresh Neon database BEFORE any drizzle migration.
-- pgvector enables the vector(768) column type used by the tools.embedding column.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "contributors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "github_id" integer NOT NULL,
  "github_handle" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contributors_github_id_unique" UNIQUE("github_id")
);

CREATE TABLE IF NOT EXISTS "tools" (
  "name" text PRIMARY KEY NOT NULL,
  "description" text NOT NULL,
  "latest_version" text NOT NULL,
  "contributor_id" uuid NOT NULL,
  "embedding" vector(768),
  "use_count" integer DEFAULT 0 NOT NULL,
  "success_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "version" text NOT NULL,
  "source_sha256" text NOT NULL,
  "manifest_yaml" text NOT NULL,
  "capabilities_json" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tool_name" text NOT NULL,
  "version" text NOT NULL,
  "success" boolean NOT NULL,
  "error_class" text,
  "duration_ms" integer NOT NULL,
  "ran_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "tools"
    ADD CONSTRAINT "tools_contributor_id_contributors_id_fk"
    FOREIGN KEY ("contributor_id") REFERENCES "contributors"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "tool_versions"
    ADD CONSTRAINT "tool_versions_tool_name_tools_name_fk"
    FOREIGN KEY ("tool_name") REFERENCES "tools"("name")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "tools_embedding_hnsw_idx"
  ON "tools" USING hnsw ("embedding" vector_cosine_ops);

CREATE UNIQUE INDEX IF NOT EXISTS "tool_versions_tool_version_idx"
  ON "tool_versions" ("tool_name","version");

CREATE INDEX IF NOT EXISTS "tool_runs_tool_name_idx"
  ON "tool_runs" ("tool_name");
