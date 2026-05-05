import { describe, expect, it } from "vitest";
import { generateRandomState, signSession, verifySession } from "./jwt.js";

const SECRET = "x".repeat(48);
const PAYLOAD = { contributorId: "abc-123", githubHandle: "alice" };

describe("jwt", () => {
  it("round-trips a signed session", async () => {
    const token = await signSession(SECRET, PAYLOAD);
    const verified = await verifySession(SECRET, token);
    expect(verified?.contributorId).toBe("abc-123");
    expect(verified?.githubHandle).toBe("alice");
    expect(verified?.exp).toBeGreaterThan(verified?.iat ?? 0);
  });

  it("rejects token signed with a different secret", async () => {
    const token = await signSession(SECRET, PAYLOAD);
    const verified = await verifySession("y".repeat(48), token);
    expect(verified).toBeNull();
  });

  it("rejects malformed token", async () => {
    expect(await verifySession(SECRET, "not.a.token.really")).toBeNull();
    expect(await verifySession(SECRET, "abc")).toBeNull();
    expect(await verifySession(SECRET, "")).toBeNull();
  });

  it("rejects expired token", async () => {
    const token = await signSession(SECRET, PAYLOAD, -10); // already expired
    const verified = await verifySession(SECRET, token);
    expect(verified).toBeNull();
  });

  it("generateRandomState returns a unique non-empty string", () => {
    const a = generateRandomState();
    const b = generateRandomState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});
