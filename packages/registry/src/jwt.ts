// Minimal HMAC-SHA256 JWT signer/verifier for session tokens.
// Web Crypto-only: works in both Workers and Node 20+.

export interface SessionPayload {
  contributorId: string;
  githubHandle: string;
  iat: number;
  exp: number;
}

const HEADER = { alg: "HS256", typ: "JWT" };
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64UrlEncode(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(
  secret: string,
  payload: { contributorId: string; githubHandle: string },
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };

  const headerSegment = base64UrlEncode(JSON.stringify(HEADER));
  const payloadSegment = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigSegment = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigSegment}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, sigSegment] = parts as [string, string, string];

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sigSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) return null;

  let claims: SessionPayload;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment)));
  } catch {
    return null;
  }

  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof claims.contributorId !== "string" || typeof claims.githubHandle !== "string") {
    return null;
  }
  return claims;
}

export function generateRandomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
