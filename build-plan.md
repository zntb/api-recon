## Build Plan: `api-recon`

### Guiding Principles

- **Vertical slices over horizontal layers.** Each phase produces something runnable, not just a pile of modules.
- **Fixture-first testing.** Build a local mock site early so every feature has a safe target.
- **Safety features ship in Phase 1, not at the end.** Redaction, robots.txt, and rate limiting are not "polish."
- **Reports are contracts.** Define the JSON schema in Phase 3 and let all other formats derive from it.

---

### Phase 0 — Project Scaffolding (½ day)

**Goal:** Empty but correct skeleton that installs, builds, lints, and tests.

Tasks:
1. `npm init` with ESM (`"type": "module"`).
2. Add dependencies: `playwright`, `commander`, `ejs`, `puppeteer`, `js-yaml`, `openapi3-ts`, `chalk`.
3. Add dev dependencies: `vitest`, `eslint`, `prettier`.
4. Create the folder structure from the prompt.
5. Add scripts: `build`, `test`, `lint`, `start`, `dev`.
6. Create `src/index.js` exporting a stub `scan()` that throws "not implemented."
7. Create `src/cli/index.js` that prints `--help` via `commander`.
8. Add `.gitignore` (node_modules, output dirs, session files).

**Exit criteria:** `npm install && npm test && npm run lint` all pass. `npx api-recon --help` prints usage.

---

### Phase 1 — Safety & Utilities (1 day)

**Goal:** All guardrails exist before any network code touches a real site.

Tasks:
1. **`utils/redact.js`** — function that takes a headers object and replaces values of `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `Proxy-Authorization` with `[REDACTED]`. Unit tests for edge cases (case-insensitivity, nested headers).
2. **`utils/robots.js`** — fetch and parse `/robots.txt`, expose `isAllowed(path, userAgent)`. Unit tests with fixtures.
3. **`utils/rateLimit.js`** — token-bucket or simple delay-per-origin. Unit tests with fake timers.
4. **`utils/url.js`** — normalize URLs, strip fragments, sort query params, same-domain check. Unit tests.
5. **Global safety banner** — a function that prints an acceptable-use notice on first run, stored in a config file at `~/.api-recon/config.json`.
6. **`--allow-local` guard** — refuse to scan `localhost`, `127.0.0.1`, or private IP ranges unless explicitly allowed.

**Exit criteria:** All utils have >90% test coverage. Attempting to scan `http://localhost` without `--allow-local` exits with a clear error.

---

### Phase 2 — Fixture Site (1 day)

**Goal:** A local test target that mimics a real app so every subsequent phase has something safe to hit.

Tasks:
1. Create `test/fixtures/site/` with:
   - `index.html` — landing page with links to `/products`, `/login`, `/dashboard`.
   - `products.html` — triggers a GET `/api/products` on load.
   - `login.html` — a form that POSTs to `/api/login` and sets a cookie.
   - `dashboard.html` — requires the cookie; calls `/api/user` and `/api/orders`.
   - `robots.txt` — disallows `/admin`.
   - `admin.html` — a page that should never be crawled.
2. Create `test/fixtures/server.js` — a tiny Express or `http` server that serves these files and mocks the API endpoints with JSON responses.
3. Add an npm script `test:server` that starts it on a fixed port.

**Exit criteria:** `npm run test:server` serves the fixture site; visiting it in a browser shows the expected pages and API calls in DevTools.

---

### Phase 3 — Core Capture Engine (2–3 days)

**Goal:** Load a page, intercept XHR/Fetch, and dump raw JSON. This is the heart of the tool.

Tasks:
1. **`core/browser.js`** — factory that launches Chromium (headless by default, headed when `--record`), applies `storageState` if provided, and returns a context + page.
2. **`core/interceptor.js`** — attaches to a page, listens for `request` and `response`, filters to XHR/Fetch, captures the fields listed in the prompt (redacting headers), enforces the 1 MB body cap, and returns a normalized record array.
3. **`core/crawler.js`** — BFS over same-domain links up to `--depth`/`--max-pages`, respecting robots.txt and rate limits. Handles SPA route changes via `history.pushState` hooks.
4. **`reporters/json.js`** — writes `report.json`. Define the schema now (see below).
5. **`index.js` `scan()`** — wire browser → interceptor → crawler → JSON reporter.

**JSON schema (define once, reuse everywhere):**
```json
{
  "meta": { "seedUrl": "", "startedAt": "", "durationMs": 0, "pagesVisited": 0 },
  "technologies": [],
  "endpoints": [
    {
      "id": "GET /api/products",
      "method": "GET",
      "urlPattern": "/api/products",
      "category": "data-fetching",
      "count": 3,
      "statusCodes": [200],
      "requestHeaders": {},
      "requestBodySample": null,
      "responseSchema": {},
      "triggeredBy": ["/products.html"],
      "samples": []
    }
  ],
  "safety": { "robotsRespected": true, "rateLimitMs": 500 }
}
```

**Exit criteria:** `api-recon http://localhost:PORT --allow-local --formats json` against the fixture site produces a `report.json` containing `/api/products`, `/api/login`, `/api/user`, `/api/orders`, and does NOT include `/admin`.

---

### Phase 4 — Authentication (1–2 days)

**Goal:** Capture authenticated APIs via saved sessions and scripted logins.

Tasks:
1. **`core/authenticator.js`**:
   - Load `storageState.json` if `--auth` is passed.
   - Execute a YAML/JSON login flow if `--login` is passed, with `${ENV_VAR}` substitution.
   - Save the resulting state to `saveStateTo` if the config requests it.
2. Add support for `fill`, `click`, `submit`, `waitForURL`, `waitForSelector` steps.
3. Refuse to log credentials; scrub env vars from any log output.
4. Update the fixture site to include a real login flow (POST → Set-Cookie → protected page).

**Exit criteria:** Running `--login test/fixtures/login.yaml` against the fixture site captures `/api/user` and `/api/orders`, which are inaccessible without auth. The saved session can be reused with `--auth`.

---

### Phase 5 — Interactive Recording & Scripted Actions (1–2 days)

**Goal:** Let a human or a config drive the browser to surface more endpoints.

Tasks:
1. **`core/actions.js`** — execute a YAML/JSON list of steps (`scroll`, `click`, `fill`, `submit`, `wait`). Log failures but continue.
2. **`--record` mode** — launch headed browser, print instructions, capture traffic, and end on `Ctrl+C` or a `done` command typed into the terminal. Write the same JSON report as a normal scan.
3. Update the fixture site with a "Load more" button that triggers a paginated `/api/products?page=2` call so actions can be tested.

**Exit criteria:** Running with `--actions` that clicks "Load more" captures the paginated call. Running with `--record` and manually clicking it also captures it.

---

### Phase 6 — Analysis & Categorization (2 days)

**Goal:** Turn raw captures into a structured, categorized report.

Tasks:
1. **`core/analyzer.js`**:
   - Deduplicate by `(method, urlPattern, status)`.
   - Categorize into authentication, data-fetching, mutations, analytics, third-party, uncategorized using the heuristics from the prompt.
   - Infer path params (UUID/numeric segments).
   - Infer query params and sample values.
2. **`core/schemaInference.js`** — infer JSON shapes from sample request/response bodies (capped at depth 4). Output a JSON-Schema-like object.
3. **`core/techStack.js`** — fingerprint CMS, frameworks, CDNs, analytics from headers, meta tags, script paths, cookies. Reuse the earlier conversation's logic.

**Exit criteria:** The fixture site's report correctly categorizes `/api/login` as authentication, `/api/products` as data-fetching, and detects Express and (if you add it) a fake analytics beacon as analytics.

---

### Phase 7 — Report Generators (2 days)

**Goal:** Emit Markdown, HTML, PDF, and OpenAPI from the single JSON source of truth.

Tasks:
1. **`reporters/markdown.js`** — sections: Overview, Technologies, Endpoint Summary by Category (table), Detailed Endpoints, Auth Flows, Third-party, Safety Notes.
2. **`reporters/html.js`** — render Markdown via `marked` + a small CSS file. Inline the CSS for portability.
3. **`reporters/pdf.js`** — load the generated HTML in Puppeteer and `page.pdf()`. Handle page breaks for large endpoint lists.
4. **`reporters/openapi.js`** — map endpoints to OpenAPI 3.0 `paths`, `methods`, `parameters`, `requestBody`, `responses`. Use inferred schemas.
5. Wire all reporters into `scan()` behind the `--formats` flag.

**Exit criteria:** One command produces `report.json`, `report.md`, `report.html`, `report.pdf`, and `openapi.yaml`. Sensitive headers are `[REDACTED]` in every one.

---

### Phase 8 — CLI Polish & Library API (1 day)

**Goal:** Make it pleasant to use as both a CLI and a library.

Tasks:
1. Finalize `commander` flags with help text and defaults.
2. Add progress output (pages crawled, endpoints found) using `chalk`.
3. Add `--quiet` and `--verbose` modes.
4. Confirm the library API matches the prompt's example (`import { scan } from 'api-recon'`).
5. Add JSDoc or TypeScript `.d.ts` files for the public API.

**Exit criteria:** `npx api-recon --help` documents every flag. The library example in the README runs unmodified.

---

### Phase 9 — Testing, Docs, and Release (1–2 days)

**Goal:** Ship something trustworthy.

Tasks:
1. **Integration tests:** run the full pipeline against the fixture site in CI (headless). Assert on JSON structure, not exact strings.
2. **Unit test coverage:** aim for >85% overall.
3. **`README.md`:** install, quickstart, CLI reference, library reference, ethics section, examples.
4. **`examples/`:** a sample login YAML, an actions YAML, and sample output files from the fixture site.
5. **`LICENSE`** (MIT or Apache-2.0) and a short `CONTRIBUTING.md`.
6. **Dry-run publish:** `npm pack` and inspect the tarball; confirm no session files or secrets are included.
7. **Version 0.1.0 release.**

**Exit criteria:** A fresh clone runs `npm install && npm test && npx api-recon <fixture> --allow-local` successfully in under 2 minutes.

---

### Phase 10 — Post-Release Hardening (ongoing)

Follow-up work beyond v0.1.0. Items move up into "Shipped" as they land.

**Shipped**

- **Firefox and WebKit support** — `--browser chromium|firefox|webkit` (Chromium
  by default), with the same `browser` option in the library API. The engine map
  lives in `src/core/browser.ts`; interception, categorization, technology
  detection, and schema inference are engine-independent, and the multi-engine
  integration suite (`test/integration/engines.test.ts`) drives the fixture site
  in Firefox and WebKit. PDF reports still render through Chromium, because
  `page.pdf()` is Chromium-only, and are skipped with a warning without it.
- **Scan diffing** — `--diff <baseline.json>` compares the current scan against an
  earlier report and marks each endpoint as added, removed, or changed, with
  per-endpoint details (status-code drift, category change, request/response
  schema changes, query-param drift, and GraphQL operation drift, where a
  removed operation is treated as breaking). Changes that can break a client (an
  endpoint disappearing, losing all 2xx responses, a response field or its type
  going away) are flagged `breaking`. `--fail-on-diff` exits `3` when anything
  changed, for CI. The logic lives in `src/core/diff.ts` and is exported as
  `diffReports`, `loadBaseline`, and `formatDiffSummary`; the diff is also
  embedded in the report under `diff` and rendered by the Markdown reporter.
- **Interactive HTML dashboard** — the `dashboard` format writes
  `dashboard.html`, a single self-contained page (inline CSS, inline report
  JSON, inline script) that renders the report as a searchable, filterable,
  sortable table with expandable per-endpoint detail. It is part of the default
  formats, so `api-recon <url>` produces it alongside the other reports, and it
  opens straight from `file://`. When a baseline is present it also grows a
  Change column and "Changed only"/"Breaking only" filters. The renderer lives in
  `src/reporters/dashboard.ts`; `report.html` deliberately stays a printable
  document, since PDF is rendered from it.
- **GraphQL detection** — a captured request carrying a GraphQL operation is
  recognized (JSON body document, `application/graphql` body, `query` search
  parameter, or a persisted query's operation name) and categorized as
  `graphql`. The endpoint gains a `graphql` object with the operation names and
  types observed and an `introspection` flag for `__schema` / `__type` queries;
  operation names are parsed from the document with a tokenizer that ignores
  strings, comments, nested selection sets, and fragments. The detection lives
  in `src/core/graphql.ts`, runs inside the analyzer, and is surfaced by the
  Markdown/HTML/PDF, dashboard, and OpenAPI reporters.
- **WebSocket capture** — the interceptor also listens for `websocket` events
  and records each connection's frames, with the same origin filtering,
  capture-time redaction, per-payload cap, and shared size budget as HTTP
  bodies. A per-connection frame cap bounds chatty streams while `frameCount`
  still reports what was seen. The report gains a `webSockets` array, the
  Markdown reporter a "WebSocket Traffic" section, and the dashboard a row per
  connection whose expanded view is its frames.

**Ideas for follow-ups**

- Optional telemetry (opt-in) to improve categorization heuristics.
- Record the engine used in the report, so a scan is reproducible from its own
  output.

---

### Timeline Summary

| Phase | Focus | Est. Time |
|-------|-------|-----------|
| 0 | Scaffolding | ½ day |
| 1 | Safety & utils | 1 day |
| 2 | Fixture site | 1 day |
| 3 | Capture engine | 2–3 days |
| 4 | Authentication | 1–2 days |
| 5 | Recording & actions | 1–2 days |
| 6 | Analysis | 2 days |
| 7 | Reporters | 2 days |
| 8 | CLI/library polish | 1 day |
| 9 | Testing & release | 1–2 days |
| **Total** | | **~13–16 days** |

---

### Risk Register

| Risk | Mitigation |
|------|------------|
| Playwright installation issues on CI | Cache browsers, use `--with-deps` on Linux |
| PDF generation flaky in headless | Fall back to Markdown if PDF fails, log a warning |
| False-positive categorization | Keep heuristics in a single config file so users can override |
| Accidental scan of sensitive site | `--allow-local` guard, robots.txt default, prominent banner |
| Secrets leaking into reports | Redaction runs at capture time, not report time |
| Crawl explosion | Hard caps on pages, depth, and total response bytes |

---

### Definition of Done (v0.1.0)

- All acceptance criteria from the prompt pass against the fixture site.
- CI is green on Linux, macOS, and Windows.
- README's quickstart works from a clean clone.
- No known secret-leak or robots.txt bypass paths.
- Published to npm (or packaged for private use) with a tagged release.
