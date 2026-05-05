import { eq } from "drizzle-orm";
import { Hono } from "hono";
import yaml from "js-yaml";
import {
  ContributeToolRequestSchema,
  parseManifest,
  sanitizeUntrusted,
  type ContributeToolResponse,
  type StrippedSpan,
  type ToolManifest,
} from "@patch-cat/shared";
import type { AppVariables, Env } from "../env.js";
import { jsonError, requireAuth, type AppContext } from "../auth.js";
import { getDb } from "../db/client.js";
import { toolVersions, tools } from "../db/schema.js";
import { embedDescription } from "../embeddings.js";
import { flagsIndicateInjection, runQuarantine } from "../quarantine-engine.js";
import { R2Storage } from "../storage.js";

export const contributeRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

contributeRouter.post("/v1/tools", requireAuth, async (c) => {
  const session = c.get("session");
  if (!session) {
    return jsonError(c, 401, "unauthenticated", "Session missing after auth middleware.");
  }

  const body = await c.req.json().catch(() => null);
  const parsed = ContributeToolRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_body", parsed.error.message);
  }

  const { manifest, source } = parsed.data;

  // Re-parse the source's frontmatter and confirm it matches the supplied manifest.
  let reparsed: ReturnType<typeof parseManifest>;
  try {
    reparsed = parseManifest(source);
  } catch (error) {
    return jsonError(
      c,
      400,
      "source_unparseable",
      `Source frontmatter could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (reparsed.manifest.name !== manifest.name || reparsed.manifest.version !== manifest.version) {
    return jsonError(
      c,
      400,
      "manifest_mismatch",
      "Manifest body does not match the manifest declared in source frontmatter.",
    );
  }

  // ============================================================
  // Phase 3 — sanitize human-visible fields. Reject on any stripped span.
  // ============================================================
  const sanitizationCheck = checkSanitization(manifest);
  if (sanitizationCheck) {
    return jsonError(
      c,
      400,
      "manifest_unsafe_unicode",
      sanitizationCheck,
    );
  }

  // ============================================================
  // Phase 3 — quarantine LLM scans the description for instruction-injection.
  // If flagged, contribution is refused with a clear error explaining why.
  // ============================================================
  const quarantine = await runQuarantine(c.env.AI, manifest.description, {
    gatewayName: c.env.AI_GATEWAY_NAME,
  });
  if (flagsIndicateInjection(quarantine.flags)) {
    return jsonError(
      c,
      400,
      "description_flagged_by_quarantine",
      `Tool description was flagged by the quarantine LLM as containing instruction-injection content: ${quarantine.flags.join(
        ", ",
      )}. Tool descriptions must describe what the tool DOES, not give instructions to AI agents that might call it. Quarantine summary: ${quarantine.summary}`,
    );
  }

  return persistContribution(c, manifest, source, session.contributorId);
});

function checkSanitization(manifest: ToolManifest): string | null {
  const offenders: Array<{ field: string; spans: StrippedSpan[] }> = [];

  const fields: Array<[string, string]> = [
    ["name", manifest.name],
    ["description", manifest.description],
  ];
  for (const input of manifest.inputs) {
    fields.push([`inputs[${input.name}].description`, input.description]);
  }

  for (const [field, value] of fields) {
    const result = sanitizeUntrusted(value);
    const dangerous = result.stripped.filter(
      (s) => s.category !== "homoglyph", // homoglyph is a flag, not an immediate reject
    );
    if (dangerous.length > 0) {
      offenders.push({ field, spans: dangerous });
    }
  }

  if (offenders.length === 0) return null;

  const summary = offenders
    .map(
      (o) =>
        `${o.field}: ${o.spans.length} character(s) stripped — categories: ${Array.from(
          new Set(o.spans.map((s) => s.category)),
        ).join(", ")}`,
    )
    .join("; ");
  return `Manifest contains characters that were stripped during sanitization (likely hidden injection payload). Clean and resubmit. Details: ${summary}`;
}

async function persistContribution(
  c: AppContext,
  manifest: typeof ContributeToolRequestSchema._type.manifest,
  source: string,
  contributorId: string,
): Promise<Response> {
  const db = getDb(c.env.DATABASE_URL);

  const [existingTool] = await db.select().from(tools).where(eq(tools.name, manifest.name)).limit(1);

  if (existingTool && existingTool.contributorId !== contributorId) {
    return jsonError(
      c,
      409,
      "name_taken",
      `Tool name "${manifest.name}" is owned by another contributor.`,
    );
  }

  const storage = new R2Storage(c.env.PATCH_TOOLS_BUCKET, c.env.PUBLIC_R2_HOST);

  let stored;
  try {
    stored = await storage.putSource(source);
  } catch (error) {
    return jsonError(c, 500, "r2_put_failed", describeError("R2 putObject", error));
  }

  const manifestYaml = yaml.dump(manifest, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
    schema: yaml.JSON_SCHEMA,
  });
  const capabilitiesJson = JSON.stringify(manifest.capabilities);

  let embedding;
  try {
    embedding = await embedDescription(c.env.AI, manifest.description, {
      gatewayName: c.env.AI_GATEWAY_NAME,
    });
  } catch (error) {
    return jsonError(c, 500, "ai_embed_failed", describeError("Workers AI embed", error));
  }

  try {
    if (!existingTool) {
      await db.insert(tools).values({
        name: manifest.name,
        description: manifest.description,
        latestVersion: manifest.version,
        contributorId,
        embedding,
      });
    } else {
      await db
        .update(tools)
        .set({
          description: manifest.description,
          latestVersion: manifest.version,
          embedding,
        })
        .where(eq(tools.name, manifest.name));
    }
  } catch (error) {
    return jsonError(
      c,
      500,
      existingTool ? "db_update_tool_failed" : "db_insert_tool_failed",
      describeError(existingTool ? "tools.update" : "tools.insert", error),
    );
  }

  try {
    await db
      .insert(toolVersions)
      .values({
        toolName: manifest.name,
        version: manifest.version,
        sourceSha256: stored.sha256,
        manifestYaml,
        capabilitiesJson,
      })
      .onConflictDoNothing({ target: [toolVersions.toolName, toolVersions.version] });
  } catch (error) {
    return jsonError(
      c,
      500,
      "db_insert_version_failed",
      describeError("tool_versions.insert", error),
    );
  }

  const response: ContributeToolResponse = {
    name: manifest.name,
    version: manifest.version,
    source_sha256: stored.sha256,
    status: stored.existed ? "exists" : "created",
  };
  return c.json(response);
}

function describeError(subsystem: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${subsystem} failed: ${message}`;
}
