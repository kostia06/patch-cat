import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { getDb } from "./db/client.js";
import type { AppVariables, Env } from "./env.js";
import { findAndQueueCandidates } from "./jobs/find-candidates.js";
import { contributeRouter } from "./routes/contribute.js";
import { oauthRouter } from "./routes/oauth.js";
import { quarantineRouter } from "./routes/quarantine.js";
import { refactorRouter } from "./routes/refactor.js";
import { runsRouter } from "./routes/runs.js";
import { searchRouter } from "./routes/search.js";
import { toolsRouter } from "./routes/tools.js";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", honoLogger());
app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

app.get("/", (c) =>
  c.json({
    service: "patch-cat-registry",
    version: "0.2.0",
    docs: "https://github.com/patch-cat/patch-cat",
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/", oauthRouter);
app.route("/", searchRouter);
app.route("/", toolsRouter);
app.route("/", runsRouter);
app.route("/", contributeRouter);
app.route("/", quarantineRouter);
app.route("/", refactorRouter);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    },
    500,
  );
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: `${c.req.method} ${c.req.path} is not a known endpoint.`,
      },
    },
    404,
  ),
);

/**
 * Scheduled (cron) handler. Wrangler invokes this when a `triggers.crons`
 * entry fires. Currently only runs the candidate finder. Behavioral
 * verification of candidates happens in the GHA runner, not here.
 */
async function scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  console.log(`[cron] tick ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
  try {
    const db = getDb(env.DATABASE_URL);
    const result = await findAndQueueCandidates(db);
    console.log(
      `[cron] candidate finder: inspected=${result.inspected_pairs} inserted=${result.inserted}`,
    );
  } catch (error) {
    console.error("[cron] candidate finder failed:", error);
  }
}

export default { fetch: app.fetch, scheduled };
