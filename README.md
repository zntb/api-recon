# api-recon

**Discover a website's APIs by driving a real browser.** Give it one seed URL;
it crawls (or you drive it interactively), records every XHR/fetch call and
WebSocket frame, infers schemas, categorizes the endpoints, and writes a report
in **JSON, Markdown, HTML, PDF, and OpenAPI 3.0**.

`api-recon` is for **observation and documentation** of APIs your own frontend
already talks to. It does not attack endpoints, fuzz inputs, bypass
authentication, or defeat CAPTCHAs and bot protections.

```
  ┌─────────────────────────────────────────────────────────────┐
  │  api-recon — acceptable use                                 │
  │                                                             │
  │  This tool observes and documents the APIs of sites you     │
  │  are authorized to test. It never bypasses auth, captchas,  │
  │  or bot protections. Respect robots.txt and rate limits,    │
  │  and only scan systems you own or have permission to scan.  │
  └─────────────────────────────────────────────────────────────┘
```

## Documentation

The reference material lives in [`docs/`](docs), split by the question it
answers. Start with the task-shaped pages when you have a specific app in
front of you, and the reference pages when you need a flag or a field.

**Reference**

| Page | What it answers |
| --- | --- |
| [CLI reference](docs/reference/cli.md) | Every flag, subcommand, and exit code; completion, presets, the project config file, progress, resuming, and the memory caps |
| [Library API](docs/reference/library.md) | `scan()` from Node, the exported types and error classes, and the events API |
| [What a scan captures](docs/reference/capture.md) | Recorded fields, endpoint categories, inferred schemas, GraphQL detection, WebSocket frames, and engine differences |
| [Reports](docs/reference/reports.md) | What each output format holds, the shared theme, and every field in `report.json` |
| [Dashboard](docs/reference/dashboard.md) | Searching, grouping, filtering, the diff view, and keyboard/screen-reader support |
| [Comparing scans](docs/reference/diffing.md) | Baselines, `--diff`, what counts as a breaking change, and CI gating |
| [Authentication and interaction](docs/reference/authentication.md) | Saved sessions, scripted login, scripted actions, and record mode |
| [Sharing a report](docs/reference/sharing.md) | `--share` for a ticket-safe summary, and `--checksum`/`verify` for integrity |
| [Safety guardrails](docs/reference/safety.md) | Every default that refuses rather than warns, plus the known limitations |
| [Telemetry (opt-in)](docs/reference/telemetry.md) | What the local payload contains, and how to preview it before opting in |

**Cookbook** — a recipe per kind of app

| Recipe | Use it when |
| --- | --- |
| [Authenticated SPA](docs/cookbook/authenticated-spa.md) | The APIs only appear after logging in, and routing happens client-side |
| [GraphQL endpoint](docs/cookbook/graphql.md) | The app talks to one `/graphql` endpoint and you want the operations, not the URL |
| [WebSocket app](docs/cookbook/websocket.md) | Real-time traffic is where the interesting contract lives |
| [CI gate](docs/cookbook/ci-gate.md) | You want a build to fail when the API surface changes |

And [Troubleshooting](docs/faq.md) — when a scan finds nothing, refuses to run,
or you need a bug report.

A rendered copy of the same sources is committed under [`docs-site/`](docs-site)
and opens straight from `file://` or serves as-is; `npm run docs:generate`
rebuilds it.

## Requirements

- Node.js **22.12+**
- A Playwright browser, downloaded once. Chromium is the default and the only
  one needed for PDF reports; Firefox and WebKit are opt-in.

## Install

```bash
npm install -g api-recon
npx playwright install chromium
```

Or as a project dependency (library use):

```bash
npm install api-recon
npx playwright install chromium
```

To scan with a different engine, install it too:

```bash
npx playwright install firefox webkit
```

## Quickstart

```bash
# Crawl one page, write every report format
api-recon https://example.com

# Two levels deep, capped at 50 pages, into a custom directory
api-recon https://example.com --depth 2 --max-pages 50 --out ./reports

# Authenticated scan with a saved session
api-recon https://app.example.com --auth ./session.json

# Scripted login (credentials come from the environment)
APP_USER=you@example.com APP_PASS='…' \
  api-recon https://app.example.com --login examples/login.yaml

# Drive the browser yourself and capture as you click
api-recon https://app.example.com --record

# A long crawl that stopped early picks up where it left off
api-recon https://app.example.com --max-pages 500 --out ./reports
api-recon https://app.example.com --max-pages 500 --out ./reports --resume

# Save a baseline, then compare against it later without naming a path
api-recon baseline https://app.example.com
api-recon https://app.example.com --diff latest --fail-on-diff
```

Not sure which flags you want? `--preset quick`, `deep`, and `ci` bundle the
common cases:

```bash
api-recon https://example.com --preset quick   # one page, no crawl, no slow PDF
api-recon https://example.com --preset ci      # bounded, quiet, machine-readable
```

## What you get

A scan writes every format into `--out` (default `./api-recon-output`):

- **`report.json`** — the machine-readable source of truth. Every endpoint with
  its method, URL pattern, statuses, headers, redacted body samples, inferred
  schemas, timing, and the page that triggered it.
- **`dashboard.html`** — a self-contained interactive report: search, filter,
  group, sort, and expand. `--open` launches it when the scan finishes.
- **`report.md` / `report.html` / `report.pdf`** — for sending to someone.
- **`openapi.yaml`** — a best-effort OpenAPI 3.0 spec derived from what was
  observed.
- **`share.md`** — with `--share`, a one-pager with no bodies, headers, or
  samples, safe to paste into a ticket.

The capture is redacted at capture time and the assembled report is checked
again before it is written, so what lands on disk is already the safe version.
A committed sample report is in
[`examples/output/`](examples/output).

## How a scan works

1. **Guardrails first.** robots.txt is fetched and enforced, the rate limiter is
   set from it, and localhost/private ranges are refused unless `--allow-local`
   says otherwise.
2. **A real browser** loads the pages. Same-origin links are followed to
   `--depth`, cross-origin calls are ignored unless `--include-third-party`.
3. **Every XHR/fetch and WebSocket is captured** — method, URL, status, redacted
   headers, body samples, timing, and the page that triggered it. Secrets are
   scrubbed at capture time, not at report time.
4. **Calls are grouped into endpoints** by `(method, URL pattern, status)`, then
   categorized, and JSON schemas are inferred and merged across samples.
5. **Reporters** derive every format from the one JSON report, so the formats
   cannot disagree.

## Contributing, development, and supply chain

Setup, the everyday commands, the test expectations, the release process, and
the supply-chain gates are in
[CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities are reported through
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
