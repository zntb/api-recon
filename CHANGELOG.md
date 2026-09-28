# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/nightjobs-collab/api-recon/releases/tag/v0.1.0
