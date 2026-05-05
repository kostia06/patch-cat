export interface Env {
  DATABASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  PUBLIC_R2_HOST: string;
  OAUTH_REDIRECT_URI: string;
  /**
   * Name of the Cloudflare AI Gateway (created in dashboard) to route Workers
   * AI calls through. When unset, calls go direct without observability.
   */
  AI_GATEWAY_NAME?: string;
  AI: Ai;
  PATCH_TOOLS_BUCKET: R2Bucket;
}

export interface SessionVars {
  contributorId: string;
  githubHandle: string;
}

export interface AppVariables {
  session?: SessionVars;
}
