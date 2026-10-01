# Contributing to api-recon

Thanks for helping! This project is an observation tool: safety and ethics
reviews matter as much as feature tests.

## Setup

```bash
npm install
npx playwright install chromium   # only Chromium is used
```

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `test/` |
| `npm test` | Unit + integration tests (integration drives a real browser) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |
| `npm run test:server` | Start the fixture site on :4599 |
| `npm run docs:generate` | Rebuild `docs-site/` from `docs/` (a test fails when it is stale) |
| `npm run completions:generate` | Rewrite the committed shell completions after changing a flag |
| `npm run examples:generate` | Rewrite the committed sample reports |

## Tests

- **Unit tests** (`test/unit`) cover redaction, robots parsing, rate limiting,
  URL handling, schema inference, categorization, and the OpenAPI mapping.
- **Integration tests** (`test/integration`) start the fixture site from
  `test/fixtures/server.ts` and drive a real headless Chromium through a full
  scan. They assert on the JSON structure, not on exact strings.
- Prefer extending the **fixture** over mocking Playwright. The fixture already
  models auth, pagination, form posts, a same-origin beacon, and a cross-origin
  partner endpoint.

Add a test for every behavior change. Security-relevant changes (redaction,
robots handling, rate limiting) require positive *and* negative cases.

## Where heuristics live

Categorization rules live in `src/core/analyzer.ts`; technology fingerprints in
`src/core/techStack.ts`. Keep new rules data-driven and small so they stay
auditable.

## Releasing

Three things must agree before a tag is pushed: the Git tag (`vX.Y.Z`), the
`version` in `package.json`, and a `## [X.Y.Z]` section in `CHANGELOG.md`. The
release workflow fails fast if any of them disagree — before it downloads
Chromium, so a mistake costs seconds rather than minutes.

`CHANGELOG.md` is the source of truth for release notes: the workflow extracts
the section for the tag and publishes it as the GitHub Release body, so the
release matches what readers see in the repository. Check yours with
`npm run changelog:extract -- --version 0.2.0`.

Publishing to npm is automatic. `.github/workflows/release.yml` builds the
tarball and creates the GitHub Release; publishing that release then triggers
`.github/workflows/publish.yml`, which pushes the package. One tag push, two
workflows, no manual `npm publish`.

Authentication is configured once on npmjs.com, and no secret is needed:

1. Open the package on npmjs.com → **Settings → Trusted Publisher**.
2. Choose **GitHub Actions** and fill in user `zntb`, repository `api-recon`, and
   workflow filename `publish.yml` (the filename only, with its extension).
3. Allow **direct publishing** (`npm publish`), not stage-only. A trusted
   publisher created after 2026-09-03 defaults to stage-publish only, and
   `npm publish` then fails with `E_STAGE_REQUIRED`.

The workflow exchanges a short-lived OIDC token for publish credentials, so
nothing long-lived is stored. It installs npm ≥ 11.5.1 itself, because trusted
publishing needs it and Node 22 still ships npm 10.

If you ever need the fallback instead, set an `NPM_TOKEN` secret (*Settings →
Secrets and variables → Actions*) to a **granular** access token with
read-and-write package access and **Bypass 2FA** enabled. Two things to know:
without `Bypass 2FA` every CI publish fails with `EOTP`, and npm removed legacy
classic tokens (including "Automation") in November 2025. Bypass-2FA direct
publishing is itself being removed in January 2027, so OIDC is the durable path.

```bash
# 0. Start from a green, up-to-date main
npm run lint && npm run typecheck && npm test
git switch main && git pull

# 1. Add a CHANGELOG.md entry for the version you are about to release, e.g.
#    "## [0.2.0] - 2026-10-01", and commit it. The release fails without it.
npm run changelog:extract -- --version 0.2.0
git add CHANGELOG.md && git commit -m "Update changelog for 0.2.0"

# 2. Bump the version — this writes package.json, commits, and tags vX.Y.Z
npm version patch        # or: minor / major

# 3. Push the commit and the tag (the tag triggers the Release workflow)
git push && git push --tags

# 4. Both workflows run from that tag: release.yml builds and creates the
#    GitHub Release, then publish.yml pushes the tarball to npm.
gh run list --limit 5
```

The publish job re-runs lint, typecheck, the test suite, and the build before
pushing, and it refuses to run when the version is already on npm — so re-running
it can never overwrite a published version. To retry a publish that failed:

```bash
gh workflow run publish.yml -f tag=v0.2.0   # or use the Actions tab
```

`publish.yml` publishes with `--provenance`, which attaches a signed attestation
tying the tarball to the workflow run. That requires the repository to be public.

Publishing from your own machine is still possible if you ever need it, and the
guard still applies:

```bash
npm login
npm publish --access public   # runs prepublishOnly: lint, typecheck, tests
npm run release:dry           # preview the tarball without publishing
```

If your npm account requires two-factor auth for publishing, add `--otp=<code>`.

The tag must match the version exactly: `v0.2.0` for `"version": "0.2.0"`.

## Ground rules

- Never add code that bypasses authentication, CAPTCHAs, or bot protections.
- Never persist credentials that a scan observed.
- Keep robots.txt enabled by default and rate limiting on by default.
- Do not weaken the `--allow-local` guard without an explicit design discussion.
