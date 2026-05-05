export interface StoredSource {
  key: string;
  sha256: string;
  existed: boolean;
}

export class R2Storage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly publicHost: string,
  ) {}

  static async computeSha256(source: string): Promise<string> {
    const data = new TextEncoder().encode(source);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async putSource(source: string): Promise<StoredSource> {
    const sha256 = await R2Storage.computeSha256(source);
    const key = `tools/${sha256}.py`;

    const existing = await this.bucket.head(key);
    if (existing) {
      return { key, sha256, existed: true };
    }

    await this.bucket.put(key, source, {
      httpMetadata: {
        contentType: "text/x-python; charset=utf-8",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        sha256,
      },
    });

    return { key, sha256, existed: false };
  }

  async getSource(sha256: string): Promise<string | null> {
    const key = `tools/${sha256}.py`;
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return obj.text();
  }

  publicUrl(sha256: string): string {
    const host = this.publicHost.replace(/\/$/, "");
    return `${host}/tools/${sha256}.py`;
  }
}
