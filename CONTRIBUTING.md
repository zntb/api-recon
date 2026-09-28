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

## Ground rules

- Never add code that bypasses authentication, CAPTCHAs, or bot protections.
- Never persist credentials that a scan observed.
- Keep robots.txt enabled by default and rate limiting on by default.
- Do not weaken the `--allow-local` guard without an explicit design discussion.
