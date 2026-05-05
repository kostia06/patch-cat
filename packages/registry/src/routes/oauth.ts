import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE, jsonError } from "../auth.js";
import { getDb } from "../db/client.js";
import { contributors } from "../db/schema.js";
import type { AppVariables, Env } from "../env.js";
import { generateRandomState, signSession } from "../jwt.js";

const STATE_COOKIE = "oauth_state";
const REDIRECT_COOKIE = "oauth_downstream";
const STATE_TTL_SECONDS = 600;

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id: number;
  login: string;
}

export const oauthRouter = new Hono<{ Bindings: Env; Variables: AppVariables }>();

oauthRouter.get("/auth/github/start", (c) => {
  const state = generateRandomState();

  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: !c.req.url.startsWith("http://localhost"),
    maxAge: STATE_TTL_SECONDS,
    path: "/auth",
  });

  const downstream = c.req.query("redirect");
  if (downstream && isAllowedDownstream(downstream)) {
    setCookie(c, REDIRECT_COOKIE, downstream, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !c.req.url.startsWith("http://localhost"),
      maxAge: STATE_TTL_SECONDS,
      path: "/auth",
    });
  }

  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: c.env.OAUTH_REDIRECT_URI,
    state,
    scope: "read:user",
    allow_signup: "true",
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

oauthRouter.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, STATE_COOKIE);

  if (!code) return jsonError(c, 400, "missing_code", "OAuth callback missing code parameter.");
  if (!state || !cookieState || state !== cookieState) {
    return jsonError(c, 400, "invalid_state", "OAuth state mismatch — possible CSRF.");
  }
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });

  const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "patch-cat-registry",
    },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenResp.ok) {
    return jsonError(
      c,
      400,
      "github_token_failed",
      `GitHub token exchange failed: ${tokenResp.status}`,
    );
  }

  const tokenJson = (await tokenResp.json()) as GithubTokenResponse;
  if (!tokenJson.access_token) {
    return jsonError(
      c,
      400,
      "github_token_missing",
      tokenJson.error_description ?? "No access_token in GitHub response.",
    );
  }

  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "patch-cat-registry",
    },
  });

  if (!userResp.ok) {
    return jsonError(c, 400, "github_user_failed", `GitHub /user failed: ${userResp.status}`);
  }

  const user = (await userResp.json()) as GithubUserResponse;
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    return jsonError(c, 400, "github_user_invalid", "Unexpected GitHub /user payload.");
  }

  const db = getDb(c.env.DATABASE_URL);
  let [existing] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.githubId, user.id))
    .limit(1);

  if (!existing) {
    const inserted = await db
      .insert(contributors)
      .values({ githubId: user.id, githubHandle: user.login })
      .returning();
    existing = inserted[0];
  } else if (existing.githubHandle !== user.login) {
    await db
      .update(contributors)
      .set({ githubHandle: user.login })
      .where(eq(contributors.id, existing.id));
    existing.githubHandle = user.login;
  }

  if (!existing) {
    return jsonError(c, 500, "contributor_upsert_failed", "Failed to upsert contributor row.");
  }

  const sessionToken = await signSession(c.env.SESSION_SECRET, {
    contributorId: existing.id,
    githubHandle: existing.githubHandle,
  });

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: !c.req.url.startsWith("http://localhost"),
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  const downstream = getCookie(c, REDIRECT_COOKIE);
  deleteCookie(c, REDIRECT_COOKIE, { path: "/auth" });

  if (downstream) {
    const url = new URL(downstream);
    url.searchParams.set("token", sessionToken);
    return c.redirect(url.toString());
  }

  return c.json({
    status: "authorized",
    handle: existing.githubHandle,
    token: sessionToken,
  });
});

function isAllowedDownstream(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") return true;
    return false;
  } catch {
    return false;
  }
}
