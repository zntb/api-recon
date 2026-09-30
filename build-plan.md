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
  schema changes, query-param drift, GraphQL operation drift, where a removed
  operation is treated as breaking, and WebSocket connection drift, where
  connections are matched by URL and the shape of their sent/received JSON
  frames is compared). When the two scans ran in different engines the
  comparison says so, since a difference may be engine-specific rather than an
  API change. Changes that can break a client (an endpoint disappearing, losing
  all 2xx responses, a response field or its type going away) are flagged
  `breaking`. `--fail-on-diff` exits `3` when anything
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
  still reports what was seen. The report gains a `webSockets` array, and the
  JSON frames in each direction are merged into an inferred message shape
  (`sentSchema` / `receivedSchema`) using the same depth-capped inference as
  HTTP bodies — shared with the `--diff` message comparison, so the two cannot
  disagree. The Markdown reporter gains a "WebSocket Traffic" section and the
  dashboard a row per connection whose expanded view is its frames and message
  schemas.

- **Engine recorded in the report** — `meta.engine` names the Playwright engine
  a scan ran in, so the report is reproducible from its own output via
  `--browser <engine>`. The Markdown/HTML/PDF Overview table and the dashboard
  header surface it, and the multi-engine integration suite asserts it.
- **Opt-in telemetry** — `--telemetry`, `API_RECON_TELEMETRY=1`, or the library
  `telemetry: true` writes an anonymized `telemetry.json` beside the reports:
  for each endpoint, the category, the heuristic that produced it, the HTTP
  method, and whether the response was JSON, with no host, path, query, header,
  or body. It is inert by default and never touches the network. Categorization
  yields the matched heuristic alongside the category, which is what lets a
  signal explain *why* an endpoint landed in its bucket. A `--telemetry-preview`
  mode prints that payload to stdout without writing a file, so the boundary can
  be checked before opting in.
- **Schemas merged across samples** — `buildEndpoint` used to infer
  `requestBodySchema` / `responseSchema` from a single representative body, so a
  field that only appeared in a later sample was invisible and a field observed
  as both `integer` and `string` took whichever body came first.
  `inferSchemaFromBodies` and `mergeSchema` (`src/core/schemaInference.ts`) now
  union every sample: a field seen anywhere is present, it is `required` only
  when every sample had it, `integer`/`number` widen to `number`, types that
  disagree become a `oneOf` union, and a format hint survives only when the
  samples agreed on it. WebSocket frames and the `--diff` message comparison
  share the same merge, the OpenAPI reporter carries the union as `oneOf`, and
  `--diff` compares type *sets* so a gained or lost union member is reported.
- **Deterministic example generation** — `scripts/generate-examples.ts` bound
  ephemeral ports and stamped the wall clock into the report, so regenerating
  `examples/output/` rewrote every origin, timestamp, and response `date` header
  and buried any real change in the noise. It now binds fixed ports (4610/4611)
  and reads a fixed clock, so regeneration is byte-reproducible: the committed
  samples change only when the report does.
- **Error contracts captured** — a 4xx/5xx response was only a number in
  `statusCodes`; its body and shape were dropped, so a report documented the
  happy path and nothing about failure. Each failed status is now kept on the
  endpoint as an `errorResponses` entry (`status`, `count`, `bodySample`,
  `schema`, `mimeTypes`), merged across samples like any other body. The
  Markdown sections and the dashboard show a block per status, `openapi.yaml`
  gives each error status its own schema instead of repeating the success one,
  and `--diff` compares error bodies so a removed field in a `422` is breaking.
- **Richer value hints** — `stringFormatHint` tagged only `uuid`, `email`,
  `uri`, and a loose timestamp, and a single observation could describe neither
  a closed set nor a range. String inference now also recognizes ISO-8601
  `date`, `time`, and `date-time` values, ISO-8601 `duration`s, and `currency`
  (an ISO-4217 code or a symbol-prefixed amount). A second, value-level pass
  over the samples (`src/core/schemaInference.ts`) annotates the merged shape —
  through nested objects, array items, and `oneOf` variants — with an `enum`
  when a string field held a small closed set of short values (identifiers and
  prose are excluded) and with `minimum`/`maximum` when a numeric field spanned
  a range. `openapi.yaml` carries them through as `format`, `enum`, and
  `minimum`/`maximum`, and `--diff` flags a removed enum value, a gained enum,
  or an inward-moved bound as breaking while reporting a widened set or range
  as additive.
- **Not observed vs. absent** — a `null` schema meant both "no body was
  captured" and "the body was not JSON", so a reader could not tell a contract
  from a gap. Every endpoint now carries `requestBodySchemaReason` /
  `responseSchemaReason` beside an absent or partial schema, with `schemaReason`
  on error contracts and `sentSchemaReason` / `receivedSchemaReason` on socket
  directions. `src/core/schemaInference.ts` classifies the gap as `no-body`,
  `not-json`, `truncated`, or `binary`, the Markdown report and dashboard show
  it in plain words, `openapi.yaml` carries it as an `x-schema-reason`
  extension, and `--diff` treats a shape that was only partly observed as
  inconclusive instead of reporting a removed field.
- **GraphQL selection sets** — `analyzeGraphQL` read operation names and types
  but not what each operation asked the server for. Every operation now records
  its top-level `selections` and the `arguments` passed to them. The tokenizer
  in `src/core/graphql.ts` reads fields through aliases while still ignoring
  strings, comments, nested selection sets, fragment spreads, inline fragments,
  and directive arguments, and `mergeGraphQL` unions the observations across
  samples like a REST schema. The Markdown report and dashboard show them, and
  `--diff` treats a selection or argument that is no longer observed as
  breaking, the way it already does for a removed REST response field.
- **Resource coverage** — the flat endpoint list now also clusters into
  `resources`, each a collection root (`/api/orders`) with the paths beneath it
  (`/api/orders/{id}`, `/api/orders/{id}/items`), the verbs observed on each
  path, and the conventional verbs absent from it. `groupResources` in
  `src/core/resources.ts` does the grouping, and the result is surfaced in the
  JSON report, the Markdown report's resource-coverage section, and the
  dashboard. A resource is only audited for missing verbs when it exposes an
  item path, so an action endpoint such as `POST /api/login` is not asked for a
  `GET` it was never meant to have.
- **Versioned report schema** — `report.json` now begins with `schemaVersion`,
  naming the *shape* of the document independently of the tool build in
  `meta.apiReconVersion`. `REPORT_SCHEMA_VERSION` in `src/types.ts` is the
  source of truth, the shape is published as `schema/report.schema.json`
  (draft-07, `additionalProperties: false` throughout), and
  `scripts/validate-report.ts` validates the committed example report against
  it in CI (`npm run check:schema`) so a renamed or dropped field fails the
  build. `loadBaseline` — and therefore `--diff` — refuses a baseline whose
  `schemaVersion` it cannot read, naming the expected and found versions,
  instead of comparing a shape it does not understand.
- **Vendor attribution** — a network call to a known third-party or analytics
  vendor is no longer just a hostname under `third-party`. `src/core/vendors.ts`
  holds one catalog of vendor names, categories, and hosts; the analyzer uses it
  both to categorize a tracking host and to attach a `vendor` to the endpoint
  (`name`, `category`, and the `payloadKeys` observed being sent — the request
  body's top-level fields plus query parameters). `techStack.ts` reads the same
  catalog, so a `Segment` script and a call to `api.segment.io` name one vendor.
  Matched by host suffix only, so `notstripe.com` is not mistaken for Stripe;
  the Markdown report, dashboard, and `openapi.yaml` (`x-vendor*`) surface it,
  and `--diff` reports vendor or payload-key drift as non-breaking.
- **Latency and size roll-up** — the `durationMs` and body sizes the interceptor
  already records are now aggregated per endpoint with nearest-rank percentiles
  (`src/core/performance.ts`): `timing` (p50/p95/max in ms), `requestBytes` /
  `responseBytes` (p50/p95/max in bytes), and `cache` (the cache-control, etag,
  last-modified, age, vary, and CDN-status headers when present). The Markdown
  report gains a **Performance** section listing the slowest endpoints and
  largest responses, the dashboard gains a `Time (p95)` column and the figures
  in its expanded row, and `openapi.yaml` carries `x-observed-latency-ms` /
  `x-observed-response-bytes`. `--diff` flags a response whose p95 grew by both
  50% and at least 5 KB, as a performance regression rather than an API break.
- **Findings & next steps** — the report now closes with `findings`,
  `src/core/findings.ts` deriving review cues from the capture: sensitive-looking
  endpoints answered without a credential, PII-shaped field names in the
  samples, security headers no response sent, error bodies that leaked
  internals, and shapes that fell back to a `oneOf` union within one run. Each
  finding carries a `kind`, a `severity`, the endpoint ids, and the evidence;
  the Markdown report groups them under **12. Findings & Next Steps** and the
  dashboard lists them in a findings panel. They are heuristics over the traffic
  a scan triggered, framed as review cues rather than an audit.
- **Dashboard design pass** — the dashboard's styles are now one token set in
  `src/reporters/dashboard.ts`. Findings appear as severity-coloured summary
  tiles (and the findings panel), the table scrolls inside its own box so the
  header row and method column stay pinned, `/` focuses search and the arrow
  keys walk the rows, `prefers-color-scheme` themes the whole page (including a
  dark `pre` block), and a print stylesheet drops the controls and unpins the
  table so the dashboard prints as usefully as `report.html`.
- **Dashboard grouping** — a Group control clusters the table by category,
  resource, or change kind. Each group carries a collapsible header with its
  count and a left-hand nav lists the groups with per-group counts; first-seen
  order keeps a sorted table's order inside each group, and search/filters still
  narrow what each group shows. Endpoints with paths a report's `resources`
  cover group by resource, with anything unrecognized under "Other endpoints".
- **One shared theme** — `src/reporters/theme.ts` now holds the colour,
  typography, spacing, and code-block tokens for both `report.html` and
  `dashboard.html`, including the dark and print overrides, so a restyle happens
  in one place and the two artifacts cannot drift apart. `report.html` gains the
  same `prefers-color-scheme` dark theme as the dashboard, and its tables are
  wrapped in a scroll box so an unbreakable cell (a long URL, a payload) scrolls
  horizontally instead of widening the page.
- **Markdown/HTML report polish** — the report opens with a one-line scorecard
  (endpoints, resources, technologies, findings, breaking changes, pages and
  duration) and a `## Contents` table of contents, and each section heading gets
  an explicit `<a id>` anchor first so the links resolve in `report.html` —
  `marked` does not add heading ids by itself. Categories render as badges
  (styled by the shared theme, plain labels elsewhere), and — as with the shared
  theme — tables scroll horizontally rather than widening the page.
- **Print-ready PDF** — `report.pdf` now carries a cover page (seed host, capture
  time, tool and report-schema version, and the same scorecard line as the
  Markdown) and a running header/footer naming the seed host with `Page N of M`,
  supplied as Chromium header/footer templates. Every `###` block — one
  endpoint's detail, resource, or finding group — is wrapped in a
  `section.detail` with `break-inside: avoid`, so a detail is not split across a
  page boundary when printed from the PDF or from `report.html`.
- **Page → request graph** — `src/reporters/graph.ts` turns the `triggeredBy`
  already recorded on every call into a graph: pages in one column, the requests
  they triggered in the other, an edge per relationship weighted by call count.
  `report.md` gets it as a Mermaid `flowchart LR` (§13), which GitHub and other
  Markdown viewers draw; `report.html` and `dashboard.html` get the same graph as
  inline SVG laid out at build time, so neither needs a Mermaid runtime and both
  keep working offline. The busiest 20 pages and 40 requests are kept and the
  rest counted, so a large capture degrades to a readable picture rather than a
  hairball. `buildRequestGraph` is exported for library use.
- **A consistent identity** — `src/reporters/brand.ts` holds the mark and the
  favicon, both embedded: the mark is inline SVG drawn from the theme's ramp
  tokens (so it takes the dark and print palettes for free), and the favicon is
  a `data:` URI, so a shared report needs no asset beside it. `report.html`,
  `dashboard.html`, and the PDF cover all show it. The palette is now a
  documented ramp in `theme.ts` — `-50` tinted surface, `-200` soft fill, `-500`
  full strength, `-600` pressed, `-700` readable ink — with the status and accent
  roles aliasing it, so dark mode moves the ramp rather than restating thirteen
  colour tokens, and print pins the ramp to its light values so a report printed
  from a dark desktop cannot put dark ink on a black tile.
- **Live progress** — the scan no longer prints a start line and then goes
  quiet. On a terminal it redraws a fixed-height table in place (phase, seed
  host, elapsed time, pages visited, requests, endpoints, and the last few pages
  and endpoints), cleared just before the summary so the result is what stays on
  screen. A pipe or CI log gets nothing — redrawn ANSI frames there are noise —
  and `--json-progress` streams one JSON object per line, ending in a `done`
  event, for a machine. The library gets the same stream as `onProgress` on
  `scan()`. Rendering is pure and separated from the timer (`src/utils/progress.ts`),
  and the scan only ever pushes state, so a reporter cannot fail a scan.
- **Project config file** — `.api-reconrc` (also `api-recon.config.json` and
  `.api-reconrc.json`) is discovered by walking up from the working directory,
  or named with `--config <file>` / `API_RECON_CONFIG`, and skipped with
  `--no-config`. It carries the same settings as the flags, in camelCase or
  kebab-case, and resolves its relative paths (`login`, `actions`, `out`, …)
  against its own directory so a committed file means the same thing from any
  subdirectory. Precedence is CLI > `API_RECON_*` env > config > defaults, the
  table of which lives in `src/cli/config.ts`; unknown keys are an error rather
  than a silently ignored typo, and `force: true` / `redact: false` are refused
  in a shared file because they would loosen safety for everyone who clones it.
- **Presets** — `--preset quick|deep|ci` bundles the flags people piece together
  by hand (`src/cli/presets.ts`): `quick` is one page with no crawl or PDF
  render, `deep` crawls further and includes cross-origin traffic, `ci` is
  bounded, quiet, and machine-readable. A preset is only a bundle of ordinary
  settings, so it needs no special handling — it is one more layer in the
  resolver, between the environment and the config file: flags and env vars beat
  it (one setting each is more specific than a bundle) and it beats the config
  (or `--preset quick` could not be quick in a repository whose config says
  `depth: 3`). `preset` is therefore also refused in a config file. `--verbose`
  names the settings a preset applied, and an unknown name lists the
  alternatives.
- **Open or print the result** — `--open` launches `dashboard.html` in the user's
  browser when the scan finishes (`src/utils/open.ts`: `open` on macOS, `start`
  through the shell on Windows, `xdg-open` elsewhere), adding the dashboard to
  the formats if it was not asked for, and falling back to printing the path when
  nothing can be launched. `--print [md|json|openapi|html]` writes a report to
  stdout through the very reporters that write the files, so a pipe sees the same
  bytes; with `--print`, every human line (progress table, summary, banner) moves
  to stderr, so `api-recon <url> --print > report.md` holds only the report. Both
  have `API_RECON_*` variables, and `open` is refused in a config file because it
  would pop a browser open on whoever runs the command.

**Proposed updates & features**

The list below is neither a commitment nor an order — each item is meant to be
liftable on its own, and the phase work above still takes precedence. Items are
grouped by the quality they improve, and each one names the code it would touch
so it can be scoped without re-reading the source.

**Report accuracy & detail**


**Stability & performance**

- **Check example freshness in CI.** Now that generation is deterministic, a CI
  job can run `npm run examples:generate` and fail on `git diff --exit-code
  examples/output`, so a report change that was never regenerated cannot merge.
- **Timeouts, retries, and a checkpoint.** A page that never finishes loading can
  stall a crawl; add a per-navigation timeout with a `--timeout` flag, one retry
  for a flaky load, and a checkpoint written after each page so a crashed or
  cancelled run can `--resume` instead of starting over.
- **Guaranteed teardown.** Handle `SIGINT`/`SIGTERM` so the browser context is
  always closed and a partial `report.json` is still flushed; today a Ctrl+C
  during a long crawl can leave a Chromium process behind.
- **Bound memory on every axis.** The capture budget is global, but frames,
  endpoints, pages, and error bodies can each grow without limit. Cap each
  explicitly, and stream oversized payloads to a side file rather than holding
  them in memory.
- **Give the browser suite a flake budget.** Mark the browser-driven integration
  tests as a separate job, record a Playwright trace on failure for triage, and
  allow a single retry on the known-flaky assertions instead of re-running the
  whole suite.
- **Validate `--login` / `--actions` input up front.** A malformed step currently
  fails — or is skipped — deep inside a run; validate the YAML against a schema
  first and report the offending path and line.

**Aesthetics**

**Security & privacy**

- **Redact by value, not only by key.** The rules match key names and a few
  shapes today; add high-entropy detection (JWT-, base64-, hex-shaped values) and
  the obvious PII patterns (email, phone, national ID) so a secret that is not in
  the key list is still masked.
- **Mask query values for sensitive parameter names.** `queryParams` keeps
  `sampleValues`, which is genuinely useful but leaks values for names like
  `token`, `key`, `code`, and `email`. Mask the value for flagged names while
  keeping the parameter name and its presence.
- **Verify redaction before writing.** Assemble the report, scan it for the
  original secret values gathered during capture, and refuse to write — or warn
  loudly under `--strict-redaction` — if any is found. Redaction is currently
  assumed rather than proved.
- **Scope the scan explicitly.** Add `--include-host` / `--exclude-path`, and
  refuse to follow cross-origin redirects by default, so a scan cannot wander
  outside the agreed scope on a large or hostile site.
- **Safer credential handling.** Write a saved `storageState` with owner-only
  permissions, warn when an `--auth` file is group- or world-readable, and never
  persist a session unless `saveStateTo` asks for it.
- **Integrity for shared reports.** Offer an optional checksum (or HMAC) over the
  report so a recipient can confirm it was not edited, aligned with the npm
  provenance attestation the release already publishes.
- **Supply-chain hygiene.** Pin GitHub Actions by commit SHA, enable Dependabot,
  and add an `npm audit` gate to CI. The published `files` list is already tight
  (`dist`, `README`, `LICENSE`, `CHANGELOG`); keep it that way with an
  `npm pack --dry-run` assertion in CI.
- **Pin the telemetry boundary as a contract.** The payload is local and
  key-free by construction, but nothing stops a future field from being added to
  it; assert the exact key set in a test so widening the boundary cannot happen
  by accident.

**User experience**

- **A first-class diff workflow.** `api-recon baseline <url>` to write a known
  baseline path and `--diff latest` to compare against it, so the CI-gate use
  case stops requiring the user to manage file paths.
- **Better failure output.** Typed error classes (a safety refusal vs. a runtime
  failure), a short "what to try next" hint on every error, and a `--debug` flag
  that writes a bundle (logs, trace, and the partial report) for a bug report.
- **Shell completion.** Generated `bash`/`zsh`/`fish` completions, which
  `commander` makes cheap now that the flag set is large.
- **An events API for the library.** Expose the scan as an async iterator
  (`for await (const event of scan(...))`) so an embedding application can show
  its own progress and stream endpoints as they are discovered.
- **A docs site and cookbook.** Recipes for an authenticated SPA, a GraphQL
  endpoint, a WebSocket app, and a CI gate, plus a troubleshooting FAQ; the
  README is already long enough that the detailed material deserves its own
  space.
- **Accessibility of the dashboard.** Keyboard-reachable controls, ARIA labels
  on the table and tiles, a sane focus order, and WCAG AA contrast, so the
  artifact is usable with a screen reader rather than only a mouse.
- **A share-safe mode.** `--share` that strips bodies, samples, and headers
  entirely — keeping only patterns, categories, and schemas — and emits a
  one-page summary suitable for pasting into a ticket.

If a few are picked first, the highest-leverage trio is proving redaction before
writing (security), checking example freshness in CI (stability), and masking
sensitive query values for flagged parameter names (privacy).

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
