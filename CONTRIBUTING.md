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

Publishing to npm is a **manual step** so that no npm token is stored in this
repository. The GitHub Actions workflow (`.github/workflows/release.yml`) only
builds the tarball and creates the GitHub Release.

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

# 4. Publish to npm once the release workflow is green
npm login                # once per machine
npm publish --access public
```

`npm publish` runs the `prepublishOnly` guard (lint → typecheck → tests) and then
`prepack` (builds `dist/`), so a broken tree cannot be published. Preview the
contents without publishing with `npm run release:dry`.

If your account requires two-factor auth for publishing, add `--otp=<code>`.

The tag must match the version exactly: `v0.2.0` for `"version": "0.2.0"`.

## Ground rules

- Never add code that bypasses authentication, CAPTCHAs, or bot protections.
- Never persist credentials that a scan observed.
- Keep robots.txt enabled by default and rate limiting on by default.
- Do not weaken the `--allow-local` guard without an explicit design discussion.
