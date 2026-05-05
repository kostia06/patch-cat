import { describe, expect, it, vi } from "vitest";
import {
  NOOP_QUARANTINE_CLIENT,
  createQuarantineClient,
  flagsIndicateInjection,
} from "./quarantine.js";

function makeFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("flagsIndicateInjection", () => {
  it("returns true for known injection flags", () => {
    expect(flagsIndicateInjection(["imperative_instruction"])).toBe(true);
    expect(flagsIndicateInjection(["instruction_override_attempt"])).toBe(true);
    expect(flagsIndicateInjection(["agent_manipulation"])).toBe(true);
  });

  it("returns false for innocuous flags", () => {
    expect(flagsIndicateInjection([])).toBe(false);
    expect(flagsIndicateInjection(["malformed_response"])).toBe(false);
    expect(flagsIndicateInjection(["unknown_flag"])).toBe(false);
  });

  it("returns true if any flag is dangerous", () => {
    expect(flagsIndicateInjection(["malformed_response", "encoded_payload"])).toBe(true);
  });
});

describe("QuarantineClient.summarizeUntrusted", () => {
  it("posts to /v1/quarantine/summarize and returns the parsed body", async () => {
    const fetchImpl = makeFetch((url, init) => {
      expect(url).toContain("/v1/quarantine/summarize");
      const body = JSON.parse(String(init?.body));
      expect(body.text).toBe("hello");
      return jsonResponse({
        summary: "user said hi",
        flags: [],
      });
    });
    const client = createQuarantineClient({ baseUrl: "https://r.example.com", fetchImpl });
    const result = await client.summarizeUntrusted("hello");
    expect(result.summary).toBe("user said hi");
    expect(result.flags).toEqual([]);
  });

  it("returns suspicious result on non-2xx", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({ error: { code: "rate_limited", message: "..." } }, 429),
    );
    const client = createQuarantineClient({ baseUrl: "https://r.example.com", fetchImpl });
    const result = await client.summarizeUntrusted("hello");
    expect(result.flags).toContain("quarantine_unreachable");
  });

  it("returns suspicious result when fetch throws", async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error("network down");
    });
    const client = createQuarantineClient({ baseUrl: "https://r.example.com", fetchImpl });
    const result = await client.summarizeUntrusted("hello");
    expect(result.flags).toContain("quarantine_unreachable");
  });

  it("filters non-string flags from response", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        summary: "x",
        flags: ["imperative_instruction", 42, null, "encoded_payload"],
      }),
    );
    const client = createQuarantineClient({ baseUrl: "https://r.example.com", fetchImpl });
    const result = await client.summarizeUntrusted("text");
    expect(result.flags).toEqual(["imperative_instruction", "encoded_payload"]);
  });
});

describe("NOOP_QUARANTINE_CLIENT", () => {
  it("returns a disabled marker without calling out", async () => {
    const result = await NOOP_QUARANTINE_CLIENT.summarizeUntrusted("anything");
    expect(result.flags).toContain("quarantine_disabled");
  });
});
