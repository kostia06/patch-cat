import { describe, expect, it } from "vitest";
import { R2Storage } from "./storage.js";

class MemoryR2Bucket {
  private store = new Map<string, { body: string; metadata: Record<string, string> }>();
  public putCalls = 0;

  async head(key: string): Promise<R2Object | null> {
    if (!this.store.has(key)) return null;
    return { key } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return {
      key,
      async text() {
        return v.body;
      },
    } as R2ObjectBody;
  }

  async put(key: string, value: string): Promise<R2Object> {
    this.putCalls += 1;
    this.store.set(key, { body: value, metadata: {} });
    return { key } as R2Object;
  }
}

describe("R2Storage", () => {
  it("computes deterministic SHA-256 of source", async () => {
    const a = await R2Storage.computeSha256("hello world");
    const b = await R2Storage.computeSha256("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("puts new source and reports existed=false", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    const storage = new R2Storage(bucket, "https://r2.example.com");
    const result = await storage.putSource("# tool\nprint('a')\n");
    expect(result.existed).toBe(false);
    expect(result.key).toBe(`tools/${result.sha256}.py`);
  });

  it("returns existed=true on duplicate put", async () => {
    const bucket = new MemoryR2Bucket();
    const storage = new R2Storage(bucket as unknown as R2Bucket, "https://r2.example.com");
    await storage.putSource("# duplicate content\n");
    const second = await storage.putSource("# duplicate content\n");
    expect(second.existed).toBe(true);
    expect(bucket.putCalls).toBe(1);
  });

  it("retrieves source from bucket", async () => {
    const bucket = new MemoryR2Bucket();
    const storage = new R2Storage(bucket as unknown as R2Bucket, "https://r2.example.com");
    const stored = await storage.putSource("# stored\n");
    const fetched = await storage.getSource(stored.sha256);
    expect(fetched).toBe("# stored\n");
  });

  it("returns null when fetching unknown sha", async () => {
    const bucket = new MemoryR2Bucket();
    const storage = new R2Storage(bucket as unknown as R2Bucket, "https://r2.example.com");
    expect(await storage.getSource("a".repeat(64))).toBeNull();
  });

  it("publicUrl appends sha and strips trailing slash", () => {
    const storage = new R2Storage({} as R2Bucket, "https://r2.example.com/");
    expect(storage.publicUrl("abc")).toBe("https://r2.example.com/tools/abc.py");
  });
});
