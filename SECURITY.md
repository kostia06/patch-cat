# Security policy

## Reporting a vulnerability

**Do not** open a public GitHub issue.

Email **security@patch-cat.com** with:

- A short description of the vulnerability
- Steps to reproduce (proof-of-concept code or demo URL is ideal)
- Your assessment of impact
- Whether you'd like to be credited publicly when we publish the fix

We acknowledge within **48 hours** and aim to ship a fix or mitigation within **14 days** for high-severity issues. Disclosure timelines are coordinated with reporters who have a preference.

For encrypted reports, our PGP key is published at:

- <https://patch-cat.com/.well-known/security-pgp.asc>
- Mirrored on Keybase: (TBD)
- Fingerprint: (TBD — set after key generation)

## Threat model

Full threat model with seven attack vectors, the defenses for each, and the section nobody else writes (*what's still possible*) is at <https://patch-cat.com/threat-model>.

## Out-of-scope reports

- Issues in vendored dependencies — file with the upstream maintainer first; if their issue affects Patch users in a non-trivial way, mention us in the upstream report and we'll coordinate.
- Issues in Cloudflare Workers, e2b sandboxes, Anthropic's API, GitHub OAuth, Arcade.dev — these are dependencies we trust. Report to the respective vendor.
- Self-XSS / clickjacking on `patch-cat.com` (a docs site with no auth surface) — generally won't accept; the docs render Markdown from the repo, no user-supplied content.
- Username enumeration via the registry's `GET /v1/tools/:name` — by design; tool names are public.

## Scope

In-scope (we will accept and act on):

- Bypass of the runtime taint blocker that lets tainted output reach a `tainted_ok: false` input without confirmation
- Bypass of the e2b sandbox's `allowInternetAccess: false` flag for tools declaring `network: false`
- Code-execution on the local user's machine (i.e., not in the e2b sandbox)
- Authentication bypass on `POST /v1/tools` or `POST /v1/refactor/proposals/:id/result`
- Injection vectors in the registry's contribution pipeline that bypass the Unicode sanitizer or quarantine LLM
- Any path that lets a malicious contributed tool reach a user's planner without the structured `confirmation_required` flow
- Supply-chain attacks against the npm package — independently verifiable Sigstore provenance breakage

## Maintainer commitments

- We will not silently roll back a defense documented in the threat model.
- We will not publish marketing claims that contradict the *what's still possible* section.
- We will reply to security@patch-cat.com.
