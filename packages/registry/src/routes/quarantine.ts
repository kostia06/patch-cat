// Quarantine LLM endpoint.
// Untrusted text is summarized by Workers AI Llama 3.3 70B. The model is
// instructed to treat input as data, never as directives, and to flag
// injection attempts. Input text is NOT persisted.

import { Hono } from "hono";
import { z } from "zod";
import { jsonError } from "../auth.js";
import type { AppVariables, Env } from "../env.js";
import { runQuarantine } from "../quarantine-engine.js";

const MAX_INPUT_LEN = 50_000;

const RequestSchema = z.object({
  text: z.string().min(1).max(MAX_INPUT_LEN),
});

export const quarantineRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

quarantineRouter.post("/v1/quarantine/summarize", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, "invalid_body", parsed.error.message);
  }

  const result = await runQuarantine(c.env.AI, parsed.data.text, {
    gatewayName: c.env.AI_GATEWAY_NAME,
  });
  return c.json(result);
});
