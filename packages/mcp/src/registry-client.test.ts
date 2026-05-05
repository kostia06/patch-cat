import { describe, expect, it, vi } from "vitest";
import { RegistryHttpError, createRegistryClient } from "./registry-client.js";

const SAMPLE_TOOL_VERSION = {
  name: "fetch_url",
  version: "1.0.0",
  description: "Fetch a URL.",
  source_sha256: "a".repeat(64),
  source_url: "https://r2.example.com/tools/aaa.py",
  manifest: {
    name: "fetch_url",
    version: "1.0.0",
    description: "Fetch a URL.",
    inputs: [
      {
        name: "url",
        type: "string",
        description: "URL to fetch.",
        required: true,
        tainted_ok: true,
      },
    ],
    outputs: { type: "string" },
    capabilities: { network: true, filesystem: "none", human_confirm: false },
    runtime: { language: "python", python_version: "3.12", packages: ["requests==2.32.3"] },
  },
  contributor: { github_handle: "patch-cat" },
  created_at: "2026-05-04T00:00:00Z",
};

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

describe("RegistryClient.searchTools", () => {
  it("hits /v1/tools/search with q and limit", async () => {
    const fetchImpl = makeFetch((url) => {
      expect(url).toContain("/v1/tools/search?q=fetch+a+url&limit=5");
      return jsonResponse({ results: [{ name: "fetch_url", similarity: 0.92 }] });
    });
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    const results = await client.searchTools("fetch a url", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("fetch_url");
  });

  it("throws RegistryHttpError on non-2xx", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({ error: { code: "bad_request", message: "no q" } }, 400),
    );
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    await expect(client.searchTools("x")).rejects.toThrow(RegistryHttpError);
  });
});

describe("RegistryClient.fetchTool", () => {
  it("fetches metadata and downloads source from R2 URL", async () => {
    const calls: string[] = [];
    const fetchImpl = makeFetch((url) => {
      calls.push(url);
      if (url.endsWith("/v1/tools/fetch_url")) {
        return jsonResponse(SAMPLE_TOOL_VERSION);
      }
      if (url === SAMPLE_TOOL_VERSION.source_url) {
        return new Response("# python source\nprint('hi')\n", { status: 200 });
      }
      return jsonResponse({ error: { code: "not_found", message: "x" } }, 404);
    });
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    const { manifest, source } = await client.fetchTool("fetch_url");
    expect(manifest.name).toBe("fetch_url");
    expect(source).toContain("print('hi')");
    expect(calls.length).toBe(2);
  });

  it("uses /:name/:version path when version supplied", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/v1/tools/fetch_url/1.0.0")) {
        return jsonResponse(SAMPLE_TOOL_VERSION);
      }
      if (url === SAMPLE_TOOL_VERSION.source_url) {
        return new Response("source", { status: 200 });
      }
      return jsonResponse({ error: { code: "wrong_url", message: url } }, 404);
    });
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    const { manifest } = await client.fetchTool("fetch_url", "1.0.0");
    expect(manifest.version).toBe("1.0.0");
  });
});

describe("RegistryClient.contributeTool", () => {
  it("requires a contribute token", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 200));
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    await expect(client.contributeTool(SAMPLE_TOOL_VERSION.manifest, "source")).rejects.toThrow(
      /Contribute token not configured/,
    );
  });

  it("posts to /v1/tools with bearer token", async () => {
    const seen: { url: string; auth: string | null; body: unknown } = {
      url: "",
      auth: null,
      body: null,
    };
    const fetchImpl = makeFetch((url, init) => {
      seen.url = url;
      seen.auth = (init?.headers as Headers).get("Authorization");
      seen.body = JSON.parse(String(init?.body));
      return jsonResponse({
        name: "fetch_url",
        version: "1.0.0",
        source_sha256: "a".repeat(64),
        status: "created",
      });
    });
    const client = createRegistryClient({
      baseUrl: "https://r.example.com",
      contributeToken: "test-token",
      fetchImpl,
    });
    const response = await client.contributeTool(SAMPLE_TOOL_VERSION.manifest, "source");
    expect(seen.url).toBe("https://r.example.com/v1/tools");
    expect(seen.auth).toBe("Bearer test-token");
    expect(response.status).toBe("created");
  });
});

describe("RegistryClient.recordRun", () => {
  it("never throws on HTTP failure", async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error("network down");
    });
    const client = createRegistryClient({ baseUrl: "https://r.example.com", fetchImpl });
    await expect(
      client.recordRun("fetch_url", { version: "1.0.0", success: true, duration_ms: 10 }),
    ).resolves.toBeUndefined();
  });
});
