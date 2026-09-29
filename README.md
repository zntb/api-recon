# api-recon

**Discover a website's APIs by driving a real browser.** Give it one seed URL;
it crawls (or you drive it interactively), records every XHR/fetch call, infers
schemas, categorizes the endpoints, and writes a report in **JSON, Markdown,
HTML, PDF, and OpenAPI 3.0**.

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

## Requirements

- Node.js **22+**
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

# Scan in Firefox instead of Chromium (needs `npx playwright install firefox`)
api-recon https://example.com --browser firefox
```

## CLI reference

| Flag | Default | Description |
| --- | --- | --- |
| `<seedUrl>` | — | Start URL (required) |
| `-d, --depth <n>` | `1` | Same-domain crawl depth (0 = seed page only) |
| `-m, --max-pages <n>` | `25` | Hard cap on pages visited |
| `-o, --out <dir>` | `./api-recon-output` | Output directory |
| `-f, --formats <list>` | `json,md,html,pdf,openapi,dashboard` | Report formats to write |
| `-b, --browser <engine>` | `chromium` | Playwright engine to drive (`chromium`, `firefox`, `webkit`), recorded in the report |
| `-a, --auth <file>` | — | Playwright `storageState.json` session |
| `-l, --login <file>` | — | Login-flow config (YAML/JSON) |
| `--record` | off | Interactive recording mode (headed browser) |
| `--actions <file>` | — | Scripted interaction steps (YAML/JSON) |
| `--diff <file>` | — | Compare this scan against a previous `report.json` |
| `--fail-on-diff` | off | With `--diff`, exit `3` when any endpoint changed (CI gating) |
| `-r, --rate <ms>` | `500` | Minimum delay between requests to the same origin |
| `--respect-robots` / `--no-respect-robots` | on | robots.txt compliance (`--no-…` requires `--force`) |
| `--include-third-party` | off | Also capture cross-origin XHR/fetch calls and WebSockets |
| `--redact` / `--no-redact` | on | Redact sensitive headers, secret-shaped body fields, and WebSocket frames |
| `--force` | off | Bypass robots.txt restrictions (only for systems you may test) |
| `--allow-local` | off | Allow scanning localhost/private network ranges |
| `--max-body-mb <n>` | `1` | Maximum response body / WebSocket frame size kept, in MB |
| `--telemetry` | off | Write anonymized categorization signals to `telemetry.json` (no host, path, or body data) |
| `-q, --quiet` / `-v, --verbose` | — | Reduce / increase progress output |

Exit codes: `0` success, `1` runtime failure, `2` refused by a safety guard (`--force`,
`--allow-local`, a bad `--diff` file, …), `3` `--fail-on-diff` found endpoint changes.

## What it captures

For every XHR/fetch request it records the method, normalized URL, status,
MIME type, redacted request/response headers, request body, JSON response body
(size-capped), timing, and the page that triggered it. Calls are deduplicated
by `(method, URL pattern, status)` and grouped into endpoints such as
`GET /api/orders/{id}`.

WebSocket connections opened by a page are captured too, with the frames sent
and received on each one (see below).

Endpoints are categorized with heuristics:

| Category | Heuristic |
| --- | --- |
| `authentication` | paths like `/login`, `/oauth`, `/token`, `/session`, `/sso` |
| `analytics` | analytics hosts (`google-analytics.com`, `segment.io`, …) or paths like `/track`, `/collect`, `/beacon` |
| `third-party` | anything cross-origin (only reported with `--include-third-party`) |
| `graphql` | the request carried a GraphQL operation (see below) |
| `mutations` | POST/PUT/PATCH/DELETE |
| `data-fetching` | GET/HEAD returning JSON |
| `uncategorized` | everything else |

The analyzer also infers **path parameters** (id-like segments), **query
parameters** with sample values, and **JSON schemas** (depth 4) for request and
response bodies. Where possible it fingerprints the stack (frameworks, CMS,
CDN, analytics) from headers, cookies, HTML, and script paths.

### GraphQL detection

GraphQL rides on ordinary HTTP, so it is recognized by what a request carries
rather than by its URL: a JSON body with a `query` document (POST), an
`application/graphql` body, a `query` search parameter (GET), or the
`operationName` of an automatic persisted query. Such endpoints are categorized
as `graphql` and gain a `graphql` object:

```jsonc
"graphql": {
  "introspection": true,          // a `__schema` / `__type` query was observed
  "operations": [                 // operation definitions seen across samples
    { "name": "IntrospectionQuery", "type": "query" },
    { "name": "GetProducts", "type": "query" }
  ]
}
```

Operation names are read from the document itself with a small tokenizer that
ignores keywords inside strings, comments, nested selection sets, and
fragments, so a field named `mutation` is not mistaken for an operation.
Anonymous operations are kept with a `null` name, and a request that names an
operation the document does not declare (a persisted query, for example) is
recorded with the `unknown` type. Nothing is executed or replayed — the document
text is only scanned. The report's Markdown, HTML, dashboard, and OpenAPI
output surface the same information, with the OpenAPI spec carrying it as
`x-graphql-operations` / `x-graphql-introspection` extensions.

### WebSocket capture

Every WebSocket a page opens is recorded, with the frames sent and received on
it. Frames are subject to the same rules as HTTP bodies: payloads are redacted
at capture time (a `token`-shaped field in a frame is masked exactly like one in
a request body), capped per frame by `--max-body-mb`, and drawn from the same
total-size budget. A per-connection frame cap keeps a chatty stream — heartbeats,
for example — from filling a report; the connection still reports how many
frames were seen, and says so when some were not stored. `--include-third-party`
controls cross-origin sockets the same way it controls cross-origin fetches.

```jsonc
{
  "url": "wss://example.com/live",
  "origins": ["wss://example.com"],
  "triggeredBy": "https://example.com/dashboard",
  "frameCount": 3,
  "sentCount": 1,
  "receivedCount": 2,
  "framesTruncated": false,
  "frames": [
    { "direction": "sent", "type": "text", "payloadSample": "{\"subscribe\":true}", "size": 17, "truncated": false, "at": 1699999999999 }
  ]
}
```

Binary frames are stored base64-encoded. The Markdown/HTML/PDF reports gain a
**WebSocket Traffic** section, and the dashboard lists each connection as a row
whose expanded view is its frames.

The capture layer is engine-independent: `--browser` swaps the Playwright
driver, and interception, categorization, technology detection, and schema
inference all behave the same. The report records the engine it ran in
(`meta.engine`), so a scan is reproducible from its own output.

> Firefox and WebKit send different `User-Agent` and `Accept` headers than
> Chromium, and sites sometimes serve different responses per engine — so if
you only care about the API surface, Chromium is the safer default.

## Reports

| File | Contents |
| --- | --- |
| `report.json` | Machine-readable source of truth |
| `report.md` | Overview, technologies, endpoint tables, detailed endpoints, auth flows, third-party calls, safety notes, WebSocket traffic |
| `report.html` | Styled standalone version of the Markdown |
| `report.pdf` | Rendered from the HTML with Playwright's `page.pdf()` |
| `openapi.yaml` | Best-effort OpenAPI 3.0 spec from inferred paths, methods, params, and schemas |
| `dashboard.html` | Interactive dashboard: search, filter, sort, and expand endpoints |
| `telemetry.json` | Opt-in anonymized categorization signals (see [Telemetry](#telemetry-opt-in)); never written unless enabled |

`report.json` shape:

```jsonc
{
  "meta": { "seedUrl": "…", "startedAt": "…", "durationMs": 1234, "pagesVisited": 6, "apiReconVersion": "0.2.2", "engine": "chromium" },
  "technologies": [{ "name": "Express", "category": "framework", "evidence": "x-powered-by: Express" }],
  "endpoints": [
    {
      "id": "GET /api/orders/{id}",
      "method": "GET",
      "urlPattern": "/api/orders/{id}",
      "origins": ["https://example.com"],
      "category": "data-fetching",
      "count": 3,
      "statusCodes": [200],
      "pathParams": ["id"],
      "queryParams": [{ "name": "page", "sampleValues": ["2"] }],
      "requestHeaders": { "accept": "application/json" },
      "responseHeaders": { "content-type": "application/json" },
      "requestBodySample": null,
      "responseBodySample": "{\"orders\":[…]}",
      "requestBodySchema": null,
      "responseSchema": { "type": "object", "properties": { "orders": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "integer" } } } } } },
      "mimeTypes": ["application/json"],
      "triggeredBy": ["https://example.com/dashboard"]
    }
  ],
  "pages": [{ "url": "…", "normalizedUrl": "…", "depth": 0, "title": "…", "visitedAt": 0 }],
  "webSockets": [
    {
      "url": "wss://example.com/live",
      "origins": ["wss://example.com"],
      "triggeredBy": "https://example.com/dashboard",
      "openedAt": 1699999999900,
      "closedAt": 1699999999999,
      "frameCount": 3,
      "sentCount": 1,
      "receivedCount": 2,
      "framesTruncated": false,
      "frames": [{ "direction": "sent", "type": "text", "payloadSample": "{\"subscribe\":true}", "size": 17, "truncated": false, "at": 1699999999920 }]
    }
  ],
  "safety": { "robotsRespected": true, "robotsSkippedPaths": [], "rateLimitMs": 500, "maxBodyBytes": 1048576, "allowLocal": false, "redact": true }
}
```

Look at [`examples/output/`](examples/output) for a real report generated from
the bundled fixture site.

## Dashboard

`dashboard.html` is the report you actually work in. Open it in any browser —
no server, no build step:

```bash
api-recon https://example.com --formats dashboard --out ./reports
open ./reports/dashboard.html
```

- **Search** across paths, methods, categories, status codes, hosts, params,
  MIME types, and the pages that triggered each call.
- **Filter** by category, HTTP method, and status code.
- **Sort** by any column; the default order is discovery order.
- **Expand** a row for its headers, query and path params, and the inferred
  request/response schemas — rendered from the sampled bodies.
- **Diff** — with `--diff`, a Change column and "Changed only" / "Breaking only"
  filters appear. Without a baseline they are omitted entirely rather than
  shown empty.
- **Removed endpoints stay visible** — an endpoint that existed in the baseline
  and not in this scan has no row in the current report, so the dashboard
  reconstructs one from the diff. It appears struck through on a red row, sorts
  and searches like any other, and there is a `Removed (baseline)` filter to
  isolate the endpoints that disappeared. Only such rows carry no request or
  response detail, and they say so instead of showing empty sections.

It is a single self-contained file: all CSS, the report JSON, and the rendering
script are inlined, so nothing is fetched at open time and it works from
`file://`, from a CI artifact, or on a machine with no network. Scanned values
are written to the DOM as text, never as HTML, so a target site cannot inject
markup into its own report — and the embedded payload is the same redacted
report as `report.json`.

Use `report.md` / `report.html` / `report.pdf` when you need something to send
someone; use `dashboard.html` when you need to find something. Both a plain and
a diffed dashboard are committed under [`examples/output/`](examples/output).

## Comparing scans

Pass a previous `report.json` to see what changed since it was captured:

```bash
# Capture a baseline
api-recon https://app.example.com --out ./baseline --formats json

# Later, scan again and compare against it
api-recon https://app.example.com --diff ./baseline/report.json --out ./latest
```

Every format carries the comparison: `report.json` gains a `diff` object, and
`report.md`/`.html`/`.pdf` gain a **Changes Since Baseline** section.

Each endpoint is reported as **added**, **removed**, or **changed**, with
per-field detail for schemas, e.g. `response field removed: products[].id`.
Changes that could break an existing client are marked **breaking**: a removed
endpoint, a response that no longer returns 2xx, or a removed or retyped
response field. Additions never are.

GraphQL endpoints are compared by operation too: a new operation or a change in
whether the schema is introspectable is additive, while an operation that is no
longer observed is flagged breaking — `GraphQL operations not observed this
time: DeleteProduct (mutation)`.

WebSocket connections are matched by URL and reported the same way, under a
`WS `-prefixed id. They also carry a message-shape comparison: the top-level
fields of the sent and received JSON frames are diffed, so a field dropping out
of a received message is flagged breaking —
`WebSocket received message field removed: value`.

Run both scans in the same engine where you can. When the baseline's
`meta.engine` differs from the current scan's, the CLI summary, the Markdown
"Changes Since Baseline" section, and the dashboard all flag it — a site can
serve different responses per engine, and a difference may not be an API change
at all.

Classification is heuristic and deliberately under-reports. A scan samples
whatever traffic the crawl happened to trigger, so an endpoint listed as removed
may simply not have been exercised this time — the evidence sits beside each
change so you can judge it.

For CI, `--fail-on-diff` turns the finding into an exit code:

```bash
api-recon https://app.example.com --diff ./baseline/report.json --fail-on-diff
```

From the library, either pass the option and read `result.diff`, or compare two
loaded reports directly without scanning:

```js
import { scan, diffReports, loadBaseline } from 'api-recon';

const result = await scan({ url: 'https://app.example.com', diff: './baseline/report.json' });
console.log(result.diff?.counts);          // { added, removed, changed, breaking }

const diff = diffReports(await loadBaseline('./old.json'), await loadBaseline('./new.json'));
console.log(diff.counts.breaking, diff.changes);
```

## Authentication

Two mechanisms, both credential-safe:

**Saved session** — anything you saved with Playwright, or that `--login`
produced:

```bash
api-recon https://app.example.com --auth ./session.json
```

**Scripted login** — a YAML/JSON flow with `${ENV_VAR}` substitution. Values are
read from the environment, never logged, and never written to reports:

```yaml
loginUrl: https://app.example.com/login
steps:
  - fill: { selector: '#email', value: '${APP_USER}' }
  - fill: { selector: '#password', value: '${APP_PASS}' }
  - click: 'button[type="submit"]'
  - waitForURL: '**/dashboard'
saveStateTo: ./session.json   # optional: reuse later with --auth
```

Supported steps: `fill`, `click`, `submit`, `waitForURL`, `waitForSelector`,
`waitForTimeout`.

## Scripted actions

Run interaction steps on every crawled page to surface lazy-loaded endpoints:

```yaml
- wait: 500
- scroll: { to: bottom }
- click: 'button.load-more'
- wait: 1000
- fill: { selector: 'input[name="q"]', value: 'widget' }
- submit: 'form#search'
```

Supported steps: `click`, `fill`, `submit`, `wait`, `waitForSelector`,
`scroll` (`{ to: top|bottom }` or a selector), `navigate`, `press`. A failing
step logs a warning and the run continues.

## Interactive record mode

```bash
api-recon https://app.example.com --record
```

A headed browser opens; browse, click, log in — every XHR/fetch call is
captured. Type `done` + Enter (or press Ctrl+C) to finish and write the report.
Redaction settings still apply.

Automation hooks: `API_RECON_HEADLESS=1` runs record mode headless,
`API_RECON_TELEMETRY=1` enables telemetry, and
`API_RECON_RECORD_AUTOSTOP_MS=<ms>` ends the session automatically.

## Library API

```js
import { scan } from 'api-recon';

const result = await scan({
  url: 'https://example.com',
  depth: 2,
  formats: ['json', 'md', 'openapi'],
  auth: './session.json',
  actions: './actions.yaml',
  redact: true,
  respectRobots: true,
});

console.log(result.endpoints);
await result.writeReports('./out');
```

`scan()` returns `{ report, endpoints, technologies, safety, writeReports(dir), files }`.
Passing `out` writes the reports during the scan; `writeReports()` writes them
later. All CLI flags have camelCase equivalents (`maxPages`, `respectRobots`,
`includeThirdParty`, `allowLocal`, `maxBodyBytes`, `browser`, …).

Types are exported for every report structure:

```ts
import type { ReconReport, Endpoint, ScanOptions, ScanResult } from 'api-recon';
```

## Safety guardrails

- **robots.txt** is fetched and enforced by default; the seed path itself must
  be allowed. `--force` bypasses the rules and prints a warning.
- **Rate limiting** waits at least `--rate` ms between requests to the same
  origin, and respects `Crawl-delay` when it is stricter.
- **Redaction is on by default** and runs at capture time, so secrets never
  reach any report: `Authorization`, `Proxy-Authorization`, `Cookie`,
  `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `X-Csrf-Token`, `X-Xsrf-Token`,
  plus JSON body fields and WebSocket frames with keys such as `password`,
  `token`, `secret`, `apiKey`, `creditCard`, `cvv`.
- **Local/private targets are refused** unless `--allow-local` is passed.
- **Size caps**: 1 MB per response body (`--max-body-mb`) and a global capture
  budget, plus `--max-pages` and `--depth` bounds.
- **Telemetry is opt-in and local**: `--telemetry` (or `API_RECON_TELEMETRY=1`)
  writes an anonymized `telemetry.json` beside the reports. It contains no host,
  path, query value, header, or body, and nothing is ever sent over the network.
- The tool **never** bypasses authentication, CAPTCHAs, or bot protections, and
  never fuzzes or brute-forces endpoints.

## Telemetry (opt-in)

`api-recon` has no phone-home. The only diagnostics it can produce are written
to a **local** `telemetry.json` in the output directory, and only when you ask
for them — `--telemetry`, `API_RECON_TELEMETRY=1`, or `telemetry: true` from the
library. Nothing is ever sent over the network.

A scan usually targets a private system, so the payload deliberately holds only
the *categorization decisions*: for each endpoint, the category, the heuristic
that produced it, the HTTP method, and whether the response was JSON. No host,
path, query value, header, or body is included — the payload is safe to share
precisely because it cannot describe the target:

```jsonc
{
  "version": 1,
  "apiReconVersion": "0.2.4",
  "generatedAt": "2026-09-29T…",
  "endpointCount": 2,
  "contains": "categorization decisions only: category, heuristic, HTTP method, and whether the response was JSON. No host, path, query values, headers, or bodies.",
  "signals": [
    { "category": "data-fetching", "heuristic": "json-response", "method": "GET", "json": true },
    { "category": "mutations", "heuristic": "mutation-method", "method": "POST", "json": true }
  ]
}
```

The `heuristic` names the rule that matched (`auth-path`, `analytics-host`,
`analytics-path`, `third-party`, `graphql`, `mutation-method`, `json-response`,
`fallback`). Read the file before you send it — it exists to tune the
heuristics, and a pile of `fallback` signals shows which paths still need a rule.

## Development

```bash
npm install
npx playwright install chromium firefox webkit   # the suite drives all three

npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # tsc -> dist/
npm test            # unit + integration (drives a real browser)

npm run test:server # fixture site on http://127.0.0.1:4599
```

The integration suite runs the whole pipeline against a local fixture site
(`test/fixtures/`) covering data fetching, mutations, login + cookie-protected
APIs, pagination via scripted actions, a same-origin analytics beacon, a
cross-origin partner endpoint, and a robots-disallowed page.

See [CONTRIBUTING.md](CONTRIBUTING.md) for test expectations.

## Limitations

- Chromium, Firefox, and WebKit are supported through `--browser`, but the
  engine you pick must be installed (`npx playwright install <engine>`).
- `page.pdf()` only exists in Chromium, so PDF reports always need Chromium
  installed — even when the scan itself ran in Firefox or WebKit. If it is
  missing, the other formats are still written and a warning is logged.
- GraphQL requests are detected and their operation names read, but query
  variables and returned fields are not analyzed.
- WebSocket frames are captured but not parsed: a binary frame is stored
  base64-encoded, and a frame cap (200 per connection) bounds a chatty stream.
  `--diff` compares a socket's message *shape*, not frame-by-frame content.
- Heuristic categorization and schema inference are best-effort starting
  points — review reports before publishing them.

## License

[MIT](LICENSE)
