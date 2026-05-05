import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AppVariables, Env } from "./env.js";
import { verifySession } from "./jwt.js";

export const SESSION_COOKIE = "patchcat_session";

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export function jsonError(c: AppContext, status: 400 | 401 | 403 | 404 | 409 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function extractToken(c: AppContext): string | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;

  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return null;
}

export async function requireAuth(c: AppContext, next: Next): Promise<Response | void> {
  const token = extractToken(c);
  if (!token) {
    return jsonError(c, 401, "missing_token", "Authentication required.");
  }

  const session = await verifySession(c.env.SESSION_SECRET, token);
  if (!session) {
    return jsonError(c, 401, "invalid_token", "Session token is invalid or expired.");
  }

  c.set("session", {
    contributorId: session.contributorId,
    githubHandle: session.githubHandle,
  });

  await next();
}
