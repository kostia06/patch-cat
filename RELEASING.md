# Releasing `@patch-cat/mcp`

End-to-end release process with **npm provenance** (cryptographically signed by GitHub Actions, verifiable by anyone who runs `npm audit signatures`).

## One-time setup

### 1. npm account hardening

- Account: dedicated bot account for CI publishing (e.g. `patch-cat-bot`). Do **not** use a personal account.
- 2FA: required for both auth and publish (`npm profile enable-2fa auth-and-writes`).
- Granular access token scoped to `@patch-cat/mcp` only. Save as a GitHub repo secret only if you need a fallback path; the trusted-publishing flow doesn't require it.

### 2. npm trusted publishing (no token in repo)

In the npm dashboard for the `@patch-cat/mcp` package:

1. Settings → **Trusted Publishers** → Add → GitHub
2. Repository: `patch-cat/patch-cat`
3. Workflow filename: `.github/workflows/release.yml`
4. Environment name: `release` (matches the workflow's `environment:` declaration)

Once configured, npm accepts publishes from GitHub Actions runs in this repo + workflow + environment, signed via OIDC. **No long-lived NPM_TOKEN.**

### 3. GitHub repo settings

- Branch protection on `main` requires PR review + green CI.
- Require linear history (no merge commits).
- Require signed commits (recommended).
- Configure the `release` environment with the rule "deployment branches → only `main`."

## Per-release process

```bash
# 1. Make sure main is green
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

# 2. Bump version
cd packages/mcp
pnpm version patch  # or minor / major
cd ../..

# 3. Commit and tag
git commit -am "release @patch-cat/mcp v$(jq -r .version packages/mcp/package.json)"
TAG="v$(jq -r .version packages/mcp/package.json)"
git tag "$TAG"
git push origin main "$TAG"
```

The tag push triggers `.github/workflows/release.yml`, which:

1. Re-runs `pnpm install --frozen-lockfile` (lockfile must be in sync — supply-chain hardening)
2. `pnpm typecheck` and `pnpm test`
3. `pnpm build` (produces `packages/mcp/dist/`)
4. `pnpm publish --provenance --access public` from `packages/mcp/`

The published tarball gets a Sigstore attestation linking it to this exact GitHub Actions run, this exact commit, and this exact workflow file. Anyone can verify with:

```bash
npm audit signatures @patch-cat/mcp
```

## Verifying a published release

```bash
# Fetch + inspect provenance
npm view @patch-cat/mcp@latest --json | jq '.dist.attestations'

# Or via the npm registry's provenance endpoint:
curl https://registry.npmjs.org/-/npm/v1/attestations/@patch-cat/mcp@<version>
```

If the provenance is missing or the build environment doesn't match, **don't install**.

## Dependency hygiene

- Lockfile (`pnpm-lock.yaml`) is committed and required by CI (`--frozen-lockfile`). A diff in lockfile = explicit, reviewable change.
- Renovate runs weekly via `.github/renovate.json`. Every dep update is a separate PR with the changelog and security notes.
- Major-version updates of any of: `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `@e2b/code-interpreter`, `drizzle-orm`, `hono` — require manual review and a test pass before merge.
- We pin SDK versions exactly (`==`) in generated tools' `runtime.packages` for the same reason: no silent rebases of executable behavior.

## Who can publish

Initially: bot account with trusted publishing wired to this repo. Human maintainers with publish rights are listed in [`MAINTAINERS.md`](./MAINTAINERS.md). All publish rights require 2FA. Compromised maintainer accounts are an explicit residual risk in [`THREAT_MODEL.md`](./THREAT_MODEL.md).

## Yanking a bad release

If a release ships with a regression:

```bash
# 1. Deprecate the bad version (still installable, but warns)
npm deprecate '@patch-cat/mcp@<bad-version>' "Regression in <subsystem>; use <good-version>+"

# 2. Publish a fixed version (don't bump just patch — bump minor if a defense was weakened)

# 3. Document the issue in CHANGELOG.md and link from the GitHub release page
```

We do **not** unpublish. Unpublishing breaks the lockfiles of every downstream user. Deprecate-and-publish-fix is the npm-recommended path.
