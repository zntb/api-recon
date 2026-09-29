# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/zntb/api-recon/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/zntb/api-recon/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zntb/api-recon/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zntb/api-recon/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zntb/api-recon/releases/tag/v0.1.0
