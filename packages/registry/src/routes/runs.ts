import { RecordRunRequestSchema } from "@patch-cat/shared";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { jsonError } from "../auth.js";
import { getDb } from "../db/client.js";
import { toolRuns, tools } from "../db/schema.js";
import type { AppVariables, Env } from "../env.js";

export const runsRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

runsRouter.post("/v1/tools/:name/runs", async (c) => {
  const name = c.req.param("name");

  const body = await c.req.json().catch(() => null);
  const parsed = RecordRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_body", parsed.error.message);
  }

  const { version, success, error_class, duration_ms } = parsed.data;
  const db = getDb(c.env.DATABASE_URL);

  // Insert run row + bump aggregates. Best effort — fire-and-forget on the client side.
  await db.insert(toolRuns).values({
    toolName: name,
    version,
    success,
    errorClass: error_class ?? null,
    durationMs: duration_ms,
  });

  await db
    .update(tools)
    .set({
      useCount: sql`${tools.useCount} + 1`,
      successCount: sql`${tools.successCount} + ${success ? 1 : 0}`,
    })
    .where(eq(tools.name, name));

  return c.json({ status: "recorded" });
});
