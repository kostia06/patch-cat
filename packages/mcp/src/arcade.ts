// Arcade.dev integration — surface area only for v0.3.
//
// Tools that declare `external_auth: ["gmail.read", "slack.send_message", ...]`
// in their manifest get short-lived scoped access tokens minted via Arcade
// before invocation. The runtime injects the token as `PATCH_ACCESS_TOKEN` env
// var into the sandbox. The user's refresh token NEVER enters the sandbox.
//
// First-time auth: Arcade returns an authorization URL the user must visit.
// We surface this via the same confirmation_required flow used for HITL and
// taint blocking — the host AI shows the URL, the user authorizes, then
// retries via patch_confirm_action.
//
// **Concrete Arcade SDK wiring is intentionally a stub in v0.3.** This module
// defines the contract (interface + manifest field + runtime hook); the
// production implementation that maps scope strings to actual Arcade tool
// IDs and handles the polling/refresh logic is a v0.3.x follow-up because:
//   1. Arcade's runtime API surface is still moving (per their changelogs at
//      time of writing) and we'd rather adapt to a stable shape.
//   2. Real verification needs an Arcade account configured with each
//      provider (Gmail, Slack, etc.) which is operator setup, not code.
// THREAT_MODEL.md documents this honestly.

import type { Logger } from "pino";

export interface MintedToken {
  token: string;
  scopes: string[];
  expiresAt: number;
}

export interface ArcadeAuthRequired {
  status: "auth_required";
  authUrl: string;
  scopes: string[];
}

export interface ArcadeAuthResolved {
  status: "ready";
  token: MintedToken;
}

export type ArcadeAuthResult = ArcadeAuthRequired | ArcadeAuthResolved;

export interface ArcadeClient {
  /**
   * Returns either a minted token ready for sandbox injection, or an
   * authorization URL the user must visit (first-time auth per provider).
   */
  authorize(scopes: string[]): Promise<ArcadeAuthResult>;
  readonly enabled: boolean;
}

export interface ArcadeConfig {
  apiKey?: string;
  baseUrl?: string;
  logger?: Logger;
}

export const NOOP_ARCADE_CLIENT: ArcadeClient = {
  enabled: false,
  async authorize(scopes) {
    throw new Error(
      `Arcade integration not configured. Tool requires external_auth scopes [${scopes.join(", ")}] but ARCADE_API_KEY is not set. See THREAT_MODEL.md.`,
    );
  },
};

export function createArcadeClient(config: ArcadeConfig): ArcadeClient {
  if (!config.apiKey) return NOOP_ARCADE_CLIENT;

  // Stub implementation for v0.3 — preserves the interface so calling code
  // can integrate cleanly. Replace `authorize` with the actual Arcade SDK
  // call once the production wiring is ready.
  return {
    enabled: true,
    async authorize(scopes) {
      config.logger?.warn(
        { scopes },
        "Arcade.authorize called against the v0.3 stub — see THREAT_MODEL.md.",
      );
      return {
        status: "auth_required",
        authUrl: `https://arcade.dev/authorize?scopes=${encodeURIComponent(scopes.join(","))}`,
        scopes,
      };
    },
  };
}

export const SUPPORTED_PROVIDERS = [
  "gmail",
  "google_calendar",
  "slack",
  "github",
  "linear",
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function parseScope(scope: string): { provider: string; permission: string } | null {
  const match = scope.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
  if (!match) return null;
  const [, provider, permission] = match;
  if (!provider || !permission) return null;
  return { provider, permission };
}

export function providersFromScopes(scopes: string[]): string[] {
  const providers = new Set<string>();
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed) providers.add(parsed.provider);
  }
  return Array.from(providers).sort();
}
