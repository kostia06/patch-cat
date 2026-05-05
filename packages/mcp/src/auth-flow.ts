import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface OAuthListenerResult {
  url: string;
  tokenPromise: Promise<string>;
  close: () => void;
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Patch — authorized</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #111; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p  { color: #555; line-height: 1.5; }
    .ok { color: #16a34a; font-weight: 600; }
  </style>
</head>
<body>
  <h1><span class="ok">Authorized.</span></h1>
  <p>You can close this tab and return to your AI assistant. Patch has saved the contribute token to your local config.</p>
</body>
</html>`;

const FAILURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Patch — authorization failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #111; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p  { color: #555; line-height: 1.5; }
    .err { color: #dc2626; font-weight: 600; }
  </style>
</head>
<body>
  <h1><span class="err">Authorization failed.</span></h1>
  <p>The OAuth callback was missing a token. Try running <code>patch_auth_register</code> again.</p>
</body>
</html>`;

export async function startOAuthListener(timeoutMs = 5 * 60 * 1000): Promise<OAuthListenerResult> {
  let resolveToken!: (token: string) => void;
  let rejectToken!: (error: Error) => void;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const token = url.searchParams.get("token");
    if (!token) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(FAILURE_HTML);
      rejectToken(new Error("OAuth callback missing token query parameter."));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    resolveToken(token);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind localhost OAuth listener.");
  }
  const port = (address as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/callback`;

  let timer: NodeJS.Timeout | null = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      rejectToken(new Error(`OAuth listener timed out after ${timeoutMs}ms.`));
      close();
    }, timeoutMs);
  }

  // Always close the server once we resolve or reject.
  tokenPromise.finally(close).catch(() => {
    /* swallow — caller already gets the rejection */
  });

  return { url, tokenPromise, close };
}
