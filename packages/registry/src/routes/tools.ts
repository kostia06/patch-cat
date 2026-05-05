import { type RegistryToolVersion, ToolManifestSchema } from "@patch-cat/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import yaml from "js-yaml";
import { type AppContext, jsonError } from "../auth.js";
import { getDb } from "../db/client.js";
import { contributors, toolVersions, tools } from "../db/schema.js";
import type { AppVariables, Env } from "../env.js";
import { R2Storage } from "../storage.js";

export const toolsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

toolsRouter.get("/v1/tools/:name", async (c) => {
  return getToolVersion(c, c.req.param("name"), null);
});

toolsRouter.get("/v1/tools/:name/:version", async (c) => {
  return getToolVersion(c, c.req.param("name"), c.req.param("version"));
});

async function getToolVersion(
  c: AppContext,
  name: string,
  requestedVersion: string | null,
): Promise<Response> {
  const db = getDb(c.env.DATABASE_URL);

  let tool;
  try {
    [tool] = await db
      .select({
        name: tools.name,
        description: tools.description,
        latestVersion: tools.latestVersion,
        contributorId: tools.contributorId,
      })
      .from(tools)
      .where(eq(tools.name, name))
      .limit(1);
  } catch (error) {
    return jsonError(
      c,
      500,
      "db_select_tool_failed",
      `tools.select failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!tool) {
    return jsonError(c, 404, "tool_not_found", `Tool "${name}" not found.`);
  }

  const targetVersion = requestedVersion ?? tool.latestVersion;

  const [version] = await db
    .select()
    .from(toolVersions)
    .where(and(eq(toolVersions.toolName, name), eq(toolVersions.version, targetVersion)))
    .orderBy(desc(toolVersions.createdAt))
    .limit(1);

  if (!version) {
    return jsonError(
      c,
      404,
      "version_not_found",
      `Version "${targetVersion}" not found for tool "${name}".`,
    );
  }

  const [contributor] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, tool.contributorId))
    .limit(1);

  if (!contributor) {
    return jsonError(c, 500, "contributor_missing", "Contributor row missing for this tool.");
  }

  let manifest: RegistryToolVersion["manifest"];
  try {
    const parsed = yaml.load(version.manifestYaml, { schema: yaml.JSON_SCHEMA });
    const validated = ToolManifestSchema.safeParse(parsed);
    if (!validated.success) {
      return jsonError(
        c,
        500,
        "manifest_invalid",
        `Stored manifest failed validation: ${validated.error.message}`,
      );
    }
    manifest = validated.data;
  } catch (error) {
    return jsonError(
      c,
      500,
      "manifest_unparseable",
      error instanceof Error ? error.message : "Unknown error parsing manifest.",
    );
  }

  const storage = new R2Storage(c.env.PATCH_TOOLS_BUCKET, c.env.PUBLIC_R2_HOST);

  const response: RegistryToolVersion = {
    name: tool.name,
    version: version.version,
    description: tool.description,
    source_sha256: version.sourceSha256,
    source_url: storage.publicUrl(version.sourceSha256),
    manifest,
    contributor: { github_handle: contributor.githubHandle },
    created_at: new Date(version.createdAt).toISOString(),
  };

  // Tool versions are immutable. Cache aggressively at the edge.
  c.header("Cache-Control", "public, max-age=300");
  return c.json(response);
}
