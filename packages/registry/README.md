# @patch-cat/registry

The hosted Patch tool registry — a Cloudflare Worker that lets Patch users pull tools from a shared corpus instead of regenerating them. JSON-API only; no UI.

**Status:** v0.2 — schema and routes are live; pre-seed and DNS wiring are operator tasks.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/health`                       | —    | Liveness probe. |
| `GET`  | `/auth/github/start`            | —    | Begin GitHub OAuth. Optional `?redirect=http://localhost:PORT/...` for the MCP `auth_register` flow. |
| `GET`  | `/auth/github/callback`         | —    | OAuth callback. Sets session cookie or redirects to `redirect` with `?token=...`. |
| `GET`  | `/v1/tools/search?q=&limit=`    | —    | Semantic search via pgvector. Returns `RegistryToolEntry[]`. |
| `GET`  | `/v1/tools/:name`               | —    | Latest version metadata + R2 source URL. |
| `GET`  | `/v1/tools/:name/:version`      | —    | Specific version metadata + R2 source URL. |
| `POST` | `/v1/tools`                     | ✓    | Contribute a new tool / version. Body: `{ manifest, source }`. |
| `POST` | `/v1/tools/:name/runs`          | —    | Anonymous run telemetry; bumps `tools.use_count` / `success_count`. |

## One-time setup

### 1. Cloudflare account

```bash
wrangler login
```

### 2. R2 buckets

```bash
wrangler r2 bucket create patchcat-tools          # production
wrangler r2 bucket create patchcat-tools-dev      # local dev
```

In the Cloudflare dashboard for each bucket, enable **Public access** (so tool source can be fetched from `r2.dev` without going through the Worker). Note the public bucket URL — you'll set it as `PUBLIC_R2_HOST`.

### 3. Neon Postgres

Create a Neon project, copy the connection string. Then run the initial migration:

```bash
psql "$DATABASE_URL" -f packages/registry/drizzle/0000_init.sql
```

Or generate further migrations from the Drizzle schema:

```bash
cd packages/registry
DATABASE_URL=... pnpm db:generate
DATABASE_URL=... pnpm db:migrate
```

The migration includes `CREATE EXTENSION IF NOT EXISTS vector;` for pgvector.

### 4. GitHub OAuth apps

You need two apps (one for dev, one for prod) because GitHub OAuth allows only one callback per app:

| App | Homepage | Callback |
|-----|----------|----------|
| Dev  | `http://localhost:8787`               | `http://localhost:8787/auth/github/callback` |
| Prod | `https://patch-cat.com`               | `https://registry.patch-cat.com/auth/github/callback` (or `*.workers.dev` until DNS is wired) |

Note your client id + client secret for each.

### 5. Worker secrets

Production:

```bash
cd packages/registry
wrangler secret put DATABASE_URL          # paste Neon connection string
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SECRET        # random 32+ bytes (e.g. `openssl rand -hex 32`)
```

Then update `[vars]` in `wrangler.toml` with `PUBLIC_R2_HOST` and `OAUTH_REDIRECT_URI` (already set per-environment in the file — verify they match your bucket / domain).

Local dev: copy `.dev.vars.example` to `.dev.vars` and fill in the dev OAuth credentials, the same Neon connection string (or a Neon dev branch — recommended), `SESSION_SECRET`, and any other variables needed.

### 6. Deploy

```bash
cd packages/registry
pnpm deploy           # production
# or
pnpm deploy --env dev # *.workers.dev preview
```

### 7. Pre-seed the registry

See [`PRESEEDING.md`](./PRESEEDING.md) for the hand-reviewed seed flow. Runs locally against a deployed registry.

## Local dev

```bash
cd packages/registry
pnpm dev
# Worker now serves http://localhost:8787
```

Hit a few endpoints:

```bash
curl http://localhost:8787/health
curl 'http://localhost:8787/v1/tools/search?q=fetch%20a%20url'
```

## Testing

Unit tests run via vitest with mocked R2 / no real DB:

```bash
pnpm test
```

Integration tests against a real Neon dev branch (not yet automated) — point `DATABASE_URL` at a branch and run `pnpm vitest --mode=integration` once that's wired up.

## Architecture decisions

- **R2 source is content-addressed by SHA-256.** Object key = `tools/{sha256}.py`. Re-uploads of identical content are no-ops. New content always means a new version row.
- **R2 reads are served directly from the bucket's public hostname**, not proxied through the Worker. The `RegistryClient` in `@patch-cat/mcp` calls `source_url` directly. Saves Worker invocation time and CPU on the largest payloads.
- **Embeddings are 768-dim via Workers AI `bge-base-en-v1.5`.** The `tools.embedding` column has an HNSW index with `vector_cosine_ops`. Re-embedded on every contribute (description may have changed).
- **Search is read-only and edge-cached for 30s** via `Cache-Control`.
- **Version metadata is edge-cached for 5 minutes** since versions are immutable after upload.
- **Aggregate counters (`use_count`, `success_count`) are updated write-through** on every `POST /v1/tools/:name/runs`. No background job needed for v0.2.
- **No web UI.** This is intentional. The registry is a JSON API; humans interact with it via Patch's MCP server, not via a dashboard.

## License

MIT.
