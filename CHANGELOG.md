# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Markdown/HTML report polish** — the report now opens with a one-line
  scorecard (endpoints, resources, technologies, findings, breaking changes,
  pages and duration) and a `## Contents` table of contents. Every section
  heading gets an explicit `<a id>` anchor first, so the contents links resolve
  in `report.html` — `marked` does not add heading ids on its own. Categories
  render as badges (styled by the shared theme, plain labels elsewhere), and
  tables scroll horizontally instead of widening the page.
- **Print-ready PDF** — `report.pdf` gains a cover page naming the seed host,
  capture time, tool version, report-schema version, and the same scorecard line
  as the Markdown report, plus a running header and footer that carry the seed
  host and `Page N of M`. Each `###` block — one endpoint's detail, resource, or
  finding group — is wrapped so it is not split across a page boundary, in the
  PDF and when printing `report.html`.
- **Page → request graph** — the report now closes with a graph of which page
  produced which call, built from the `triggeredBy` already recorded on each
  endpoint. `report.md` carries it as a Mermaid `flowchart LR` (§13) that
  Markdown viewers render, while `report.html` and `dashboard.html` embed the
  same graph as inline SVG laid out at build time — no Mermaid runtime, so both
  stay self-contained and offline. Pages and requests are ranked by activity and
  capped (20 / 40), and anything dropped is counted in the report.

## [0.3.7] - 2026-09-30

### Added

- **Dashboard grouping** — a Group control clusters the table by category,
  resource, or change kind. Each group renders as a collapsible header with its
  count, and a left-hand nav lists the groups and their counts; filtering and
  search still narrow what each group shows, and first-seen order keeps a sorted
  table's order inside a group. Paths covered by the report's `resources` group
  by resource, and anything unrecognized (including baseline-only rows) falls
  under "Other endpoints".

### Changed

- **Dashboard design pass** — the dashboard's styles are now a single token set,
  themed once. Findings show as severity-coloured summary tiles beside the
  existing counts, the table scrolls inside its own box so the header row and
  the method column stay pinned, `/` focuses search and the arrow keys walk the
  rows (Enter/Space still expands one), `prefers-color-scheme` themes the whole
  page — including a dark code block — and a print stylesheet drops the
  controls and unpins the table so the dashboard prints as a readable static
  report. No data or flags change.
- **Shared HTML theme** — `report.html` and `dashboard.html` no longer each
  carry their own palette. `src/reporters/theme.ts` defines the colour,
  typography, spacing, and code-block tokens once, with the dark and print
  overrides, and both artifacts interpolate them. `report.html` therefore gains
  the dashboard's `prefers-color-scheme` dark theme, and its tables are wrapped
  in a scroll box so an unbreakable cell — a long URL or payload — scrolls
  horizontally instead of widening the page. No report data changes.

## [0.3.6] - 2026-09-30

### Added

- **Latency and size roll-up** — the interceptor already recorded `durationMs`
  per call and the bodies themselves, but nothing aggregated them. Every
  endpoint now carries `timing` (p50/p95/max response time in ms) and, when a
  body was captured, `requestBytes` / `responseBytes` (p50/p95/max in bytes),
  computed with nearest-rank percentiles so every figure is an observation
  rather than an interpolation. Cache-relevant response headers are kept in
  `cache` (`cache-control`, `etag`, `last-modified`, `age`, `vary`, and a CDN
  status) when present. The Markdown report gains a **Performance** section
  listing the slowest endpoints and largest responses, the dashboard gains a
  `Time (p95)` column and shows the figures in its expanded row, and
  `openapi.yaml` carries them as `x-observed-latency-ms` /
  `x-observed-response-bytes`. `--diff` flags a response whose p95 grew by at
  least 50% *and* 5 KB as a performance regression — reported in plain language,
  not as an API break.
- **Findings & next steps** — a report now ends with what to act on rather than
  only data. `src/core/findings.ts` derives `findings` from the capture: a
  sensitive-looking endpoint that answered without a credential
  (`unauthenticated`), PII-shaped field names in the samples (`pii`), security
  headers no response sent (`missing-security-header`), error bodies that leaked
  internals (`verbose-error`), and shapes that fell back to a `oneOf` union
  within a single run (`inconsistent-shape`). Each carries a `severity`, the
  endpoint ids, and the evidence. The Markdown report groups them under
  **Findings & Next Steps** and the dashboard lists them in a findings panel.
  They are heuristics over whatever traffic a scan triggered — review cues, not
  a security audit — and are absent from reports written before this release.

## [0.3.5] - 2026-09-30

### Added

- **Vendor attribution** — third-party and analytics traffic used to be a
  `category` plus a hostname. Endpoints in those categories now carry a
  `vendor` when their host belongs to a known vendor: its `name`, `category`,
  and the `payloadKeys` observed being sent (the request body's top-level field
  names and the query parameter names). One catalog in `src/core/vendors.ts`
  defines every vendor's name, category, and hosts, and both the analyzer and
  the technology fingerprints read it, so a `Segment` script and a call to
  `api.segment.io` name the same vendor and the `analytics` host list can no
  longer drift from the names it attributes. Hosts match by suffix only, so
  `notstripe.com` is not mistaken for Stripe. The Markdown report, dashboard,
  and `openapi.yaml` (`x-vendor`, `x-vendor-category`, `x-vendor-payload-keys`)
  surface it, and `--diff` reports vendor or payload-key drift as non-breaking.

## [0.3.4] - 2026-09-30

### Added

- **Versioned report schema** — `report.json` now begins with `schemaVersion`,
  which names the *shape* of the document independently of the tool build in
  `meta.apiReconVersion`. The shape is published as
  [`schema/report.schema.json`](schema/report.schema.json) (JSON Schema
  draft-07), and CI validates the committed example report against it, so a
  renamed, dropped, or retyped field fails the build rather than a downstream
  consumer. `loadBaseline()` — and therefore `--diff` — refuses a baseline whose
  `schemaVersion` this build cannot read, naming the expected and found
  versions, instead of comparing a shape it does not understand.

## [0.3.3] - 2026-09-30

### Added

- **Resource coverage** — the flat endpoint list now also clusters into
  `resources`: each a collection root (`/api/orders`) with the paths beneath it
  (`/api/orders/{id}`, `/api/orders/{id}/items`), the verbs observed on each
  path, and the conventional verbs that were not (`missingMethods`). Grouping
  lives in `src/core/resources.ts` and is surfaced in the JSON report, the
  Markdown report's resource-coverage section, and the dashboard. A resource is
  only audited for missing verbs when it exposes an item path, so an action
  endpoint is not asked for a verb it was never meant to have.

## [0.3.2] - 2026-09-30

### Added

- **GraphQL selection sets** — `analyzeGraphQL` read operation names and types
  but not what each operation asked the server for. Every operation now records
  its top-level `selections` and the `arguments` passed to them, parsed from the
  document (still ignoring strings, comments, fragments, and nested selection
  sets) and unioned across samples like a REST schema. The Markdown report and
  dashboard show them, and `--diff` treats a selection or argument that is no
  longer observed as breaking, the way it already does for a removed REST
  response field.

## [0.3.1] - 2026-09-30

### Added

- **Distinguish "not observed" from "absent"** — a `null` schema used to mean
  both "no body was captured" and "the body was not JSON". An endpoint now
  carries a `requestBodySchemaReason` / `responseSchemaReason` beside an absent
  or partial schema, with the same on error contracts (`schemaReason`) and
  WebSocket directions (`sentSchemaReason` / `receivedSchemaReason`). The value
  is one of `no-body`, `not-json`, `truncated`, or `binary`. The Markdown report
  and dashboard show it in plain words and `openapi.yaml` records it as an
  `x-schema-reason` extension. `--diff` treats a shape that was only partly
  observed as inconclusive rather than reporting a removed field, so a truncated
  sample no longer looks like an API change.

## [0.3.0] - 2026-09-30

### Added

- **Richer value hints** — string inference now recognizes ISO-8601 timestamps
  (`date`, `time`, and `date-time`), ISO-8601 durations, and currencies given as
  an ISO-4217 code or a symbol-prefixed amount. A merged shape also gains an
  `enum` when a field's samples formed a small closed set, and `minimum`/`maximum`
  when they spanned a numeric range. `openapi.yaml` carries these through as
  `format`, `enum`, and `minimum`/`maximum`, so the generated spec is more
  precise without any new flag.
- **Enum and bounds diffing** — `--diff` now compares those hints: losing an
  enum value, gaining an enum where none was inferred, or having a numeric
  `minimum` rise or `maximum` fall narrows what a client can rely on and is
  flagged breaking, while an added value or a widened range is reported as
  additive. A change that only drops an inferred enum or bound is not breaking.

## [0.2.9] - 2026-09-29

Captures the response contract of each failed status, so a report documents what
an API returns on failure and not only on success. Existing flags and options
are unchanged; an endpoint gains an `errorResponses` field when it was observed
failing.

### Added

- **Error contracts** — a 4xx or 5xx response is no longer just a number in
  `statusCodes`. Its body and inferred schema are kept per status in a new
  `errorResponses` array on the endpoint (`status`, `count`, `bodySample`,
  `schema`, `mimeTypes`), so the failure shape is documented beside the success
  one instead of being dropped. Bodies get the same capture-time redaction and
  size caps as any other response, and several samples of one status are merged
  the same way. The Markdown/HTML/PDF detailed endpoint sections gain an
  **Error responses** block, the dashboard's expanded row gains a block per
  status, and `openapi.yaml` now gives each error status its own schema rather
  than repeating the success schema for every status.
- **Error-body diffing** — `--diff` compares the error bodies of statuses seen on
  both scans, so a field removed from a `422` body is flagged breaking like any
  other removed field. A status that merely appeared or disappeared stays with
  the existing status-code comparison and is not treated as breaking.

## [0.2.8] - 2026-09-29

Makes the committed sample reports reproducible. No user-facing behavior
changes.

### Internal

- **Deterministic example generation** — `npm run examples:generate` bound
  ephemeral ports and stamped `Date.now()` into the report, so every regeneration
  rewrote every origin, timestamp, and response `date` header under
  `examples/output/` and buried any real change in the diff. It now binds fixed
  ports (4610/4611) and reads a fixed clock, so regenerating shows a diff only
  when the report itself changed.

## [0.2.7] - 2026-09-29

Endpoint schemas now describe every observed sample rather than a single body.
Existing flags and options are unchanged; a schema may gain fields and, when
samples disagree on a type, use a `oneOf` union.

### Added

- **Schemas merged across samples** — `requestBodySchema` and `responseSchema`
  (and a socket's `sentSchema` / `receivedSchema`) are now inferred from *all* of
  the endpoint's samples instead of one representative body. A field seen in any
  sample is present, a field appears in `required` only when every sample carried
  it, `integer` and `number` widen to `number`, and a field whose samples
  genuinely disagree on the type becomes a `oneOf` union (with `type` absent). A
  format hint such as `description: "uuid"` survives only when every sample
  agreed on it, and a `null` observation keeps the informative shape instead of
  erasing it. Responses still prefer successful samples, so an error page cannot
  masquerade as the contract. `openapi.yaml` carries the union as `oneOf`, and
  `--diff` compares type *sets*, so gaining or losing a union member reads as a
  type change rather than being missed.

## [0.2.6] - 2026-09-29

Adds a way to inspect the opt-in telemetry payload without writing it.
Existing flags, options, and report fields are unchanged.

### Added

- **`--telemetry-preview`** — the flag (or `telemetryPreview: true` for the
  library) builds the same anonymized payload as `--telemetry` but prints it to
  stdout instead of writing `telemetry.json`; the file is never created. Pass
  both to print and write. It exists so the privacy boundary can be checked by
  reading the actual payload before opting in.

## [0.2.5] - 2026-09-29

Infers message schemas from WebSocket frames. Existing flags, options, and
report fields are unchanged apart from two new fields on `webSockets` entries.

### Added

- **WebSocket message schemas** — the JSON frames a socket sends and receives
  are now merged into an inferred shape per direction, `sentSchema` and
  `receivedSchema`, the same depth-capped schema inference used for HTTP bodies.
  A socket's messages therefore appear beside the HTTP request/response schemas
  in `report.json`, the Markdown "WebSocket Traffic" section, and the
  dashboard's expanded socket row. The `--diff` message-shape comparison now
  shares the same inference, so the report and the diff can never disagree.

## [0.2.4] - 2026-09-29

Adds opt-in, local-only telemetry for tuning the categorization heuristics.
Off by default; existing flags, options, and report fields are unchanged.

### Added

- **Opt-in telemetry** — `--telemetry`, `API_RECON_TELEMETRY=1`, or the library
  `telemetry: true` writes an anonymized `telemetry.json` beside the reports.
  It holds only the categorization decisions: for each endpoint, the category,
  the heuristic that produced it, the HTTP method, and whether the response was
  JSON. No host, path, query value, header, or body is included, and nothing is
  sent over the network — the file is for a human to read and forward. It is
  never written unless enabled, and the payload carries a plain-language
  `contains` field stating the boundary. Categorization now yields the matched
  heuristic (`categorizeWithReason`), which is what makes a signal explain
  *why* an endpoint landed in its bucket.

## [0.2.3] - 2026-09-29

Records the browser engine in the report. Existing flags, options, and report
fields are unchanged apart from the new `meta.engine`.

### Added

- **Engine recorded in the report** — `meta.engine` names the Playwright engine
  the scan ran in, so a scan is reproducible from its own output by re-running
  with `--browser <engine>`. Sites sometimes serve different responses per
  engine, which is exactly why the engine belongs next to the data it produced.
  The Markdown/HTML/PDF Overview table and the dashboard header show it.
- **Engine differences flagged in `--diff`** — the comparison carries each
  scan's engine under `diff.baseline.engine` / `diff.current.engine`. When they
  differ, the CLI summary, the Markdown "Changes Since Baseline" section, and
  the dashboard note that some differences may be engine-specific rather than
  API changes, since a site can serve different responses per engine.

## [0.2.2] - 2026-09-29

Extends `--diff` to WebSocket connections. Existing flags, options, and report
fields are unchanged.

### Added

- **WebSocket diffing** — `--diff` matches WebSocket connections by URL, so a
  socket that appears or disappears is reported like an endpoint (a missing one
  is breaking). It also compares the message *shape*: the top-level fields of
  the sent and received JSON frames are diffed, and a field that is no longer
  observed is flagged breaking, matching how a removed response field is
  treated. Connections ride in the same change list as endpoints under a `WS `
  pseudo-id, so the counts, the CLI summary, the Markdown "Changes Since
  Baseline" table, and the dashboard's change column and removed-row rendering
  all cover them without a separate path.

## [0.2.1] - 2026-09-29

Adds WebSocket capture. A page's WebSocket connections and their frames are now
recorded alongside XHR/fetch traffic, subject to the same redaction and size
limits. The report gains a `webSockets` array; existing fields are unchanged.

### Added

- **WebSocket frame capture** — every socket a page opens is recorded with the
  frames sent and received on it: direction, text or binary, size, and a
  redacted payload sample. Frames are redacted at capture time exactly like
  request bodies (a `token`-shaped field in a frame is masked), capped per frame
  by `--max-body-mb`, and drawn from the same total-size budget as bodies; a
  per-connection cap of 200 frames keeps a chatty stream from filling a report,
  while `frameCount` still reports what was seen. Cross-origin sockets follow
  `--include-third-party`, and binary frames are stored base64-encoded. The
  Markdown/HTML/PDF reports gain a **WebSocket Traffic** section (now section 8;
  "Changes Since Baseline" moves to 9), and the dashboard lists each connection
  as a searchable, sortable row whose expanded view is its frames.

## [0.2.0] - 2026-09-29

Adds GraphQL detection. A request carrying a GraphQL operation is now
recognized, categorized, and summarized by operation name — including whether
the schema introspection query was observed. Existing flags and options are
unchanged; the report gains an optional `graphql` field on endpoints and a
`graphql` category.

### Added

- **GraphQL detection** — a captured call is recognized as GraphQL by its
  request rather than its URL: a JSON body with a `query` document (POST), an
  `application/graphql` body, a `query` search parameter (GET), or the
  `operationName` of an automatic persisted query. Such endpoints are
  categorized as `graphql` and gain a `graphql` object listing the operation
  names and types observed, plus an `introspection` flag that is true when a
  `__schema` / `__type` schema query was seen. Operation names are read from the
  document with a small tokenizer that ignores keywords inside strings,
  comments, nested selection sets, and fragments; anonymous operations keep a
  `null` name, and a named-but-undeclared operation (a persisted query, for
  example) is recorded as type `unknown`. Nothing is executed or replayed. The
  detection is engine-independent, like the rest of the analyzer.
- **GraphQL in every report** — the Markdown/HTML/PDF detailed endpoint sections
  list the operations and the introspection result; the dashboard shows them in
  the expanded row and indexes them for search and the category filter; and
  `openapi.yaml` carries them as `x-graphql-operations` and
  `x-graphql-introspection` extensions on the operation.
- **GraphQL operation diffing** — `--diff` now compares GraphQL endpoints by
  operation. A new operation, or introspection appearing, is reported as
  additive; an operation that is no longer observed is flagged breaking, the
  same as a removed endpoint or response field, since a client that calls it
  would break.

## [0.1.3] - 2026-09-28

Adds an interactive dashboard for reading a report, and makes removed endpoints
visible when a scan is compared against a baseline. Existing flags, options, and
the report schema are unchanged, but note that `dashboard.html` is now written by
default — pass `--formats` to leave it out.

### Added

- **Interactive HTML dashboard** (`dashboard.html`, part of the default formats)
  — a self-contained page that renders the report as a table you can search
  (path, method, category, status, host, params, MIME type, triggering page),
  filter by category / method / status, sort by any column, and expand row by
  row for headers, params, and inferred request/response schemas. With `--diff`
  it also grows a Change column and "Changed only" / "Breaking only" filters.
  All CSS, the report JSON, and the rendering script are inlined — no CDN, no
  fetch — so it opens straight from `file://`, and every scanned value reaches
  the DOM as text rather than markup.
- **Removed endpoints in the dashboard** — an endpoint that was in the baseline
  and not in the current scan has no row of its own in the report, so the
  dashboard rebuilds one from the diff. Removed endpoints now appear struck
  through on a red row, sort and search like any other, and can be isolated with
  a `Removed (baseline)` filter — previously they were only a number in the
  summary. `examples/output/dashboard-diff.html` is a committed example.

## [0.1.2] - 2026-09-28

Adds scan-to-scan comparison, so a report can be checked against a previously
saved one. Existing flags, options, and the report schema are unchanged apart
from the new optional `diff` field.

### Added

- **`--diff` mode** — `--diff <baseline.json>` compares a scan against an earlier
  report and marks each endpoint as added, removed, or changed, flagging the
  changes that could break a client: an endpoint that disappeared, a response
  that no longer returns 2xx, and a response or request field that was removed
  or retyped. Per-endpoint details also cover status-code drift, category
  changes, and query-parameter drift. The result is embedded in `report.json`
  under `diff` and rendered by the Markdown reporter as "Changes Since
  Baseline", which the HTML and PDF reports inherit; `openapi.yaml` is a schema,
  not a changelog, so it is left alone.
- **`--fail-on-diff`** — exits `3` when the comparison found any change, so CI
  can fail a build that alters the API surface. Using it without `--diff` is an
  error (exit `2`), as is a baseline that is missing, not JSON, or not an
  api-recon report.
- **`diffReports()` and `loadBaseline()`** — exported so two saved reports can be
  compared without scanning, with `formatDiffSummary()` for the human-readable
  summary the CLI prints.

## [0.1.1] - 2026-09-28

Adds a choice of browser engine and automates releases. Existing flags, options,
and the report schema are unchanged.

### Added

- **Multiple browser engines** — `--browser chromium|firefox|webkit` (Chromium by
  default) selects the Playwright engine a scan runs in, and the library API takes
  the same `browser` option. Interception, categorization, technology detection,
  and schema inference are engine-independent, and the integration suite drives
  the fixture site in all three engines. PDF reports still require Chromium, since
  `page.pdf()` is Chromium-only; without it the other formats are written and a
  warning is logged.

### Fixed

- `package.json`'s `repository`, `homepage`, and `bugs` fields, and this
  changelog's release link, now point at `zntb/api-recon`. The old link pointed at
  a repository that does not exist, and the missing `repository` field would have
  made `npm publish --provenance` fail.

### Internal

- Releases are tag-driven: a `vX.Y.Z` tag checks that the tag, `package.json`, and
  this changelog agree, builds the GitHub Release from the matching section here,
  and publishes to npm with a provenance attestation.
- Text files are normalized to LF through `.gitattributes`, enforced by a CI check.

## [0.1.0] - 2026-09-27

First release. `api-recon` discovers a website's own API surface by driving a
headless browser, simulating user actions, and exporting a categorized report.

### Added

- **CLI and library** — `api-recon <seedUrl>` on the command line, and
  `import { scan } from 'api-recon'` programmatically, with types exported for
  every report structure.
- **Crawling** — breadth-first crawl over same-domain links with `--depth` and
  `--max-pages`, plus SPA route capture via `history.pushState` / `popstate`.
- **Network capture** — XHR/fetch request and response metadata, redacted
  headers, size-capped JSON bodies, timings, and the triggering page URL.
- **Authentication** — saved Playwright `storageState` (`--auth`) and scripted
  login flows (`--login`) with `${ENV_VAR}` substitution and optional
  `saveStateTo`.
- **Interactive recording** — `--record` opens a headed browser, captures while
  you browse, and finishes on `done` or Ctrl+C.
- **Scripted actions** — `--actions` supports click, fill, submit, wait,
  waitForSelector, scroll, navigate, and press; failures log and continue.
- **Analysis** — deduplication by `(method, pattern, status)`, categorization
  (authentication, analytics, third-party, mutations, data-fetching,
  uncategorized), path and query parameter inference, JSON schema inference to
  depth 4, and technology fingerprinting.
- **Reports** — `report.json`, `report.md`, `report.html`, `report.pdf`
  (Playwright `page.pdf()`), and `openapi.yaml`.
- **Safety guardrails** — robots.txt compliance with `--force` override,
  per-origin rate limiting that honours `Crawl-delay`, capture-time redaction of
  sensitive headers and secret-shaped body fields, a private-host guard
  requiring `--allow-local`, a first-run acceptable-use banner, and per-response
  size caps.
- **Tests** — unit suites for redaction, URL handling, robots parsing, rate
  limiting, the safety guard, and config loading; browser-driven integration
  suites covering capture and categorization, robots enforcement, login plus
  session reuse, scripted actions, all five report formats, record mode, and CLI
  behavior.
- **Fixture site** — `npm run test:server` serves a mock storefront modelling
  login, pagination, form posts, a same-origin analytics beacon, a cross-origin
  partner endpoint, and a robots-disallowed page.
- **Examples** — `examples/login.yaml`, `examples/actions.yaml`, and sample
  reports generated into `examples/output/`.
- **CI** — lint, typecheck, build, and the full test suite on Linux, macOS, and
  Windows.

### Known limitations

- Only Chromium is supported; Firefox and WebKit are not wired up.
- GraphQL request bodies and WebSocket frames are not analyzed.
- Categorization and schema inference are heuristic and should be reviewed
  before a report is published or shared.

[Unreleased]: https://github.com/zntb/api-recon/compare/v0.3.7...HEAD
[0.3.7]: https://github.com/zntb/api-recon/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/zntb/api-recon/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/zntb/api-recon/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/zntb/api-recon/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/zntb/api-recon/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/zntb/api-recon/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/zntb/api-recon/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/zntb/api-recon/compare/v0.2.9...v0.3.0
[0.2.9]: https://github.com/zntb/api-recon/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/zntb/api-recon/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/zntb/api-recon/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/zntb/api-recon/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/zntb/api-recon/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/zntb/api-recon/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/zntb/api-recon/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/zntb/api-recon/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/zntb/api-recon/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/zntb/api-recon/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/zntb/api-recon/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zntb/api-recon/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zntb/api-recon/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zntb/api-recon/releases/tag/v0.1.0
