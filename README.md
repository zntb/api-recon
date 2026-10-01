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

# Save a baseline, then compare against it later without naming a path
api-recon baseline https://app.example.com
api-recon https://app.example.com --diff latest --fail-on-diff

# Scan in Firefox instead of Chromium (needs `npx playwright install firefox`)
api-recon https://example.com --browser firefox
```

## CLI reference

| Flag | Default | Description |
| --- | --- | --- |
| `<seedUrl>` | — | Start URL (required) |
| `baseline <seedUrl>` | — | Subcommand: scan and store the report as the baseline for `--diff latest` |
| `completion <shell>` | — | Subcommand: print a completion script for `bash`, `zsh`, or `fish` |
| `-d, --depth <n>` | `1` | Same-domain crawl depth (0 = seed page only) |
| `-m, --max-pages <n>` | `25` | Hard cap on pages visited |
| `-o, --out <dir>` | `./api-recon-output` | Output directory |
| `-f, --formats <list>` | `json,md,html,pdf,openapi,dashboard` | Report formats to write |
| `-b, --browser <engine>` | `chromium` | Playwright engine to drive (`chromium`, `firefox`, `webkit`), recorded in the report |
| `-a, --auth <file>` | — | Playwright `storageState.json` session |
| `-l, --login <file>` | — | Login-flow config (YAML/JSON) |
| `--record` | off | Interactive recording mode (headed browser) |
| `--actions <file>` | — | Scripted interaction steps (YAML/JSON) |
| `--diff <file>` | — | Compare this scan against a previous `report.json`, or the stored baseline with `--diff latest` |
| `--baseline <file>` | `.api-recon/baseline.json` | Override where the stored baseline lives (for the `baseline` subcommand and `--diff latest`) |
| `--fail-on-diff` | off | With `--diff`, exit `3` when any endpoint changed (CI gating) |
| `-r, --rate <ms>` | `500` | Minimum delay between requests to the same origin |
| `--respect-robots` / `--no-respect-robots` | on | robots.txt compliance (`--no-…` requires `--force`) |
| `--include-third-party` | off | Also capture cross-origin XHR/fetch calls and WebSockets |
| `--redact` / `--no-redact` | on | Redact sensitive headers, secret-shaped body fields, and WebSocket frames |
| `--force` | off | Bypass robots.txt restrictions (only for systems you may test) |
| `--allow-local` | off | Allow scanning localhost/private network ranges |
| `--max-body-mb <n>` | `1` | Maximum response body / WebSocket frame size kept, in MB |
| `--telemetry` | off | Write anonymized categorization signals to `telemetry.json` (no host, path, or body data) |
| `--telemetry-preview` | off | Print that payload to stdout without writing `telemetry.json` |
| `-q, --quiet` / `-v, --verbose` | — | Reduce / increase progress output |
| `--json-progress` | off | Emit progress as JSON lines on stdout instead of a live table |
| `--preset <name>` | — | Bundle the flags for a common case: `quick`, `deep`, `ci` (see below) |
| `--open` | off | Open `dashboard.html` in your browser when the scan finishes |
| `--print [format]` | — | Print a report to stdout: `md` (default), `json`, `openapi`, or `html` |
| `--config <file>` | discovered | Project config file (see below) |
| `--no-config` | — | Ignore any project config file, even one found on the way up |
| `--debug` | off | On failure, write `debug/logs.txt`, a browser trace, and the partial report for a bug report |

Exit codes: `0` success, `1` runtime failure, `2` refused by a safety guard (`--force`,
`--allow-local`, a bad `--diff` file, a missing `latest` baseline, …), `3`
`--fail-on-diff` found endpoint changes.

### When a scan fails

Every deliberate failure is a typed error and ends in a next step. A guard that
refused to start is a `SafetyError` (exit `2`) — scanning `localhost` without
`--allow-local`, a `robots.txt` refusal, a config file that would loosen safety —
while a scan that started and then broke is a `RuntimeError` (exit `1`). Under
the message, the CLI prints a one-line hint: what to add, where to look, or which
file the value came from.

For a bug report, `--debug` leaves a bundle behind when a run fails:

```console
$ api-recon https://app.example.com --login flow.yaml --debug
✗ login step 2 (click #submit) failed: …
  → Check the login flow against the page, then run again.

Debug bundle written to ./api-recon-output/debug:
  ./api-recon-output/debug/logs.txt
  ./api-recon-output/debug/trace.zip
  ./api-recon-output/debug/partial-report.json
```

- `logs.txt` — every line the run printed, already secret-scrubbed.
- `trace.zip` — a Playwright trace (screenshots, DOM snapshots, and sources)
  you can open with `npx playwright show-trace`.
- `partial-report.json` — the report built from whatever the crawl captured
  before the failure, in the same shape as a normal `report.json`.

Writing the bundle is best-effort: if it cannot be written, that is a warning
and the original error still stands. In the library, the same behavior is
`scan({ debug: true, debugDir: './debug' })`.

### Shell completion

`api-recon completion <shell>` prints a completion script for bash, zsh, or
fish, so the flag set stops being something to remember:

```console
# bash — for the current shell
source <(api-recon completion bash)

# zsh — write it where zsh looks for functions
api-recon completion zsh > "${fpath[1]}/_api-recon"

# fish
api-recon completion fish > ~/.config/fish/completions/api-recon.fish
```

The script completes the subcommands (`baseline`, `completion`), every flag,
and the values that matter — engines, presets, print formats, report formats,
and file paths for `--auth`, `--login`, `--actions`, `--config`, `--diff`,
`--baseline`, and `--out`. It is generated from the same command definition the
CLI parses with, so a flag added there is completed without a second list, and
the output is deterministic — commit it or regenerate it in a toolchain step.

### Presets

Three bundles for the flags people otherwise piece together by hand, so the
common cases are one word:

| Preset | What it sets | Why |
| --- | --- | --- |
| `quick` | `depth 0`, `maxPages 1`, `formats json,md,dashboard` | A first look at one page — no crawl, and no slow PDF render |
| `deep` | `depth 3`, `maxPages 100`, `includeThirdParty` | Crawl further, and capture the cross-origin calls too |
| `ci` | `depth 2`, `maxPages 50`, `formats json,md`, `quiet` | Bounded, quiet, machine-readable for a pipeline |

```console
# What does this page talk to?
api-recon https://example.com --preset quick

# CI: bounded, quiet, and only the formats a pipeline reads
api-recon https://example.com --preset ci
```

A preset is only a bundle — every value is an ordinary setting with an ordinary
default, nothing is hidden, and `--verbose` names the ones it applied. It sits
**between the environment and the config file**: a flag or an `API_RECON_*`
variable beats it (they name one setting each, which is more specific than a
bundle), and it beats the config file (otherwise `--preset quick` could not be
quick in a repository whose config says `depth: 3`). Everything a preset does not
mention still comes from the config or the default. For the same reason,
`preset` is one of the settings a config file may not carry — commit the flags
you want, and keep the shorthand for the run in front of you.

### Project config

A team that runs the same scan every time can commit the flags it always uses
instead of repeating them in every shell (or in a wiki). The file is plain JSON:

```jsonc
// .api-reconrc — committed at the repository root
{
  "depth": 2,
  "maxPages": 50,
  "rate": 250,
  "formats": ["json", "md", "dashboard"],
  "login": "flows/login.yaml",   // resolved relative to this file
  "actions": "flows/actions.json",
  "out": "reports",
  "allowLocal": true
}
```

It is discovered by walking up from the working directory, taking the nearest of
`api-recon.config.json`, `.api-reconrc.json`, or `.api-reconrc`. `--config <file>`
or `API_RECON_CONFIG` names one explicitly, and `--no-config` ignores whatever
would have been found. Settings use the same names as the long flags, in
camelCase or kebab-case, and an unknown key is an error rather than a typo that
silently does nothing.

**Precedence is CLI > environment > preset > config > defaults.** A flag always
wins, an `API_RECON_*` variable beats the file, a `--preset` bundle beats the
file, and the file beats the built-in default:

```console
$ API_RECON_DEPTH=3 api-recon https://example.com --max-pages 10
# depth 3 (environment), maxPages 10 (flag), everything else (config)
```

The environment variables are the flags in `SCREAMING_SNAKE_CASE`:
`API_RECON_DEPTH`, `API_RECON_MAX_PAGES`, `API_RECON_OUT`, `API_RECON_FORMATS`,
`API_RECON_BROWSER`, `API_RECON_AUTH`, `API_RECON_LOGIN`, `API_RECON_ACTIONS`,
`API_RECON_RATE`, `API_RECON_DIFF`, `API_RECON_BASELINE`, `API_RECON_FAIL_ON_DIFF`,
`API_RECON_RESPECT_ROBOTS`, `API_RECON_INCLUDE_THIRD_PARTY`, `API_RECON_REDACT`,
`API_RECON_FORCE`, `API_RECON_ALLOW_LOCAL`, `API_RECON_TELEMETRY`,
`API_RECON_TELEMETRY_PREVIEW`, `API_RECON_MAX_BODY_MB`, `API_RECON_QUIET`,
`API_RECON_VERBOSE`, `API_RECON_JSON_PROGRESS`, `API_RECON_RECORD`,
`API_RECON_DEBUG`. Booleans take
`1`/`0` (also `true`/`false`, `yes`/`no`, `on`/`off`).

Two values cannot be committed in a shared file: `force: true` and
`redact: false`. Each loosens a safety default for everyone who clones the
repository, so both are refused with an explanation and still work from a flag
or the environment, where the choice is explicit for that run. Run with
`--verbose` to see which file was used and which settings came from it.

`scan()` itself reads no config file — the library takes explicit options, so an
embedding application keeps control.

### The result you wanted

A scan usually ends in something you then go and find. Two flags finish the job
instead:

```console
# Look at it: the dashboard opens when the scan finishes
api-recon https://example.com --open

# Use it: the Markdown report goes to stdout, commentary to stderr
api-recon https://example.com --print > report.md
api-recon https://example.com --print json | jq '.endpoints[].id'
```

`--open` launches `dashboard.html` in whatever the desktop uses (`open` on macOS,
`start` through the shell on Windows, `xdg-open` elsewhere), adding the dashboard
to the formats if you had not asked for it. On a headless box, in a container, or
in WSL without one of those launchers it prints the path instead — a written
report is a success even if nobody opened it — and `API_RECON_NO_OPEN=1` (or
`API_RECON_OPENER=<program>`) decides what happens on your machines.

`--print` renders through the same reporters that write the files, so the text a
pipe receives is the text the file would have contained: `md` (the default), the
`report.json` document, the OpenAPI YAML, or `report.html`. It is additive to
`--out`, and while it is on, **every human line moves to stderr** — the progress
table, the summary, the file list — so redirecting stdout captures only the
report. The PDF and the dashboard are refused with a message, because they belong
in a file rather than a pipe.

### Progress

On a terminal, the scan replaces its start line with a running table — phase,
seed host, elapsed time, pages visited, requests and endpoints seen so far, plus
the last few pages and endpoints — redrawn in place, so a long crawl never looks
like a hang and never scrolls your terminal. It is cleared before the summary, so
the result is what stays on screen.

Piped or in CI there is no table, because redrawn ANSI frames in a log file are
noise; `--quiet` does the same on a terminal. A machine that wants the stream
passes `--json-progress` for one JSON object per line, ending with a `done`
event:

```console
$ api-recon https://example.com --json-progress --formats json | grep '^{"event"'
{"event":"progress","phase":"crawling","elapsedMs":0,"pagesVisited":0,"maxPages":25,"calls":0,"endpoints":0,"currentPage":null}
{"event":"progress","phase":"crawling","elapsedMs":1240,"pagesVisited":1,"maxPages":25,"calls":3,"endpoints":2,"currentPage":"/products"}
{"event":"done","phase":"analyzing","elapsedMs":4210,"pagesVisited":6,"maxPages":25,"calls":31,"endpoints":14,"currentPage":"/dashboard"}
```

In the library, the same stream is `onProgress`:

```ts
await scan({
  url: 'https://example.com',
  onProgress: (s) => console.error(`${s.phase}: ${s.pages.length} pages, ${s.calls.length} calls`),
});
```

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

Binary frames are stored base64-encoded. JSON frames are summarized into
message schemas — `sentSchema` for what the page sent (like a request body) and
`receivedSchema` for what it received (like a response) — so a socket's messages
sit alongside the HTTP schemas. The Markdown/HTML/PDF reports gain a **WebSocket
Traffic** section with those schemas, and the dashboard lists each connection as
a row whose expanded view is its frames and message schemas.

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
| `report.md` | A one-line scorecard and a linked table of contents, then overview, technologies, endpoint tables with category badges, detailed endpoints, auth flows, third-party calls, safety notes, WebSocket traffic |
| `report.html` | Styled standalone version of the Markdown |
| `report.pdf` | Rendered from the HTML with Playwright's `page.pdf()`: a cover page, running header/footer with page numbers, and an endpoint's detail kept whole |
| `openapi.yaml` | Best-effort OpenAPI 3.0 spec from inferred paths, methods, params, and schemas |
| `dashboard.html` | Interactive dashboard: search, filter, sort, and expand endpoints |
| `telemetry.json` | Opt-in anonymized categorization signals (see [Telemetry](#telemetry-opt-in)); never written unless enabled |

`report.html` and `dashboard.html` share one theme (`src/reporters/theme.ts`):
the same colours, typography, spacing, and code blocks, and both follow your
`prefers-color-scheme`. Content that cannot wrap — a long URL, a payload —
scrolls horizontally inside its table or code block instead of widening the
page.

### Identity and colour ramp

`report.html`, `dashboard.html`, and the PDF cover all carry the same mark, and
the two HTML pages link an SVG favicon. Both are embedded — the mark as inline
SVG, the favicon as a `data:` URI — so a report stays one file you can attach,
open from `file://`, or store as a CI artifact, with no asset to ship beside it.
The mark is drawn from the theme's ramp tokens, so it follows dark mode and the
print palette without a second definition.

Everything with a colour takes it from a documented ramp in
`src/reporters/theme.ts`. Each hue is a scale, and a step means the same *role*
in every mode — dark mode redefines the ramp, and print pins it to the light
values (a report printed from a dark desktop must not put dark ink on a black
tile) — so a component names a step instead of a hex value:

| Ramp | Hue | Steps in use | Where |
| --- | --- | --- | --- |
| `--brand-*` | indigo | 50, 200, 500, 600, 700 | logo tile, links, focus rings, graph edges, notes |
| `--green-*` | green | 50, 700 | `ok` — success and healthy states |
| `--amber-*` | amber | 50, 700 | `warn` — caution |
| `--red-*` | red | 50, 700 | `bad` — breaking changes and errors |
| `--blue-*` | blue | 50, 700 | `info` — neutral information |

`-50` is a tinted surface (badge, note, and row backgrounds), `-200` a soft fill
(borders, accents), `-500` the hue at full strength, `-600` one step down for a
pressed or hovered control, and `-700` readable ink for text and icons. Surfaces
and text (`--panel`, `--ink`, `--line`, …) are roles rather than ramp steps,
because print flattens them to greys instead of scaling them.

`report.md` closes with a **page → request graph**, rendered as Mermaid for a
Markdown viewer and as inline SVG in `report.html` and `dashboard.html` (no
Mermaid runtime, so both stay self-contained and work offline). It joins each
page to the requests it triggered, using the `triggeredBy` recorded on every
call — a relationship the tables alone make the reader reconstruct. Only the
busiest 20 pages and 40 requests are drawn, and the report says what was left
out.

`report.pdf` is `report.html` plus the page furniture a document needs: a cover
naming the seed host, capture time, tool and report-schema version; a running
header and footer carrying the seed host and `Page N of M`; and break rules that
keep each `###` detail section — one endpoint, resource, or finding group — on a
single page.

`report.json` shape:

```jsonc
{
  "schemaVersion": 1,
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
      "requestBodySchemaReason": "no-body",
      "responseSchema": { "type": "object", "properties": { "orders": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "integer" } } } } } },
      "timing": { "p50": 42, "p95": 180, "max": 310 },
      "responseBytes": { "p50": 1200, "p95": 8400, "max": 12000 },
      "cache": { "control": "public, max-age=60", "etag": "W/\"abc\"" },
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
      "frames": [{ "direction": "sent", "type": "text", "payloadSample": "{\"subscribe\":true}", "size": 17, "truncated": false, "at": 1699999999920 }],
      "sentSchema": { "type": "object", "properties": { "subscribe": { "type": "boolean" } } },
      "receivedSchema": null
    }
  ],
  "safety": { "robotsRespected": true, "robotsSkippedPaths": [], "rateLimitMs": 500, "maxBodyBytes": 1048576, "allowLocal": false, "redact": true },
  "findings": [
    { "kind": "missing-security-header", "severity": "low", "title": "Security headers not observed on any response", "endpoints": [], "details": ["strict-transport-security was not present on any captured response"] }
  ]
}
```

`schemaVersion` names the shape of the document; `meta.apiReconVersion` names
the tool build that wrote it, so a report can be read by a consumer that knows
nothing about the tool's release numbering. The shape is published as
[`schema/report.schema.json`](schema/report.schema.json) and CI validates the
committed example against it. `--diff` refuses a baseline whose `schemaVersion`
it cannot read rather than guessing at an unfamiliar shape.

`requestBodySchema` and `responseSchema` (and a socket's `sentSchema` /
`receivedSchema`) are inferred across *every* sample, not just one body: a field
seen in any sample is present, a field is listed in `required` only when every
sample carried it, `integer` and `number` widen to `number`, and a field whose
samples genuinely disagree on the type becomes a `oneOf` union. A format hint
such as `description: "uuid"` is kept only when every sample agreed on it.

A `null` schema says only that there is no shape; why is in the reason beside
it. When a schema is absent — or was inferred from an incomplete body — the
endpoint carries `requestBodySchemaReason` / `responseSchemaReason`, error
contracts carry `schemaReason`, and socket directions carry `sentSchemaReason`
/ `receivedSchemaReason`. The value is one of `no-body` (nothing captured),
`not-json` (a body that is not a JSON object/array), `truncated` (cut off at
the size cap), or `binary` (a non-text payload), so a gap is not mistaken for a
contract. `--diff` skips the field-level comparison when either scan only
partly observed a shape, rather than reporting a removed field.

An endpoint that was seen failing also carries `errorResponses`, one entry per
4xx/5xx status with that status's own `bodySample` and `schema`, so the failure
contract is documented rather than repeated from the success shape.

The flat `endpoints` list is also clustered into `resources`: each is a
collection root (`/api/orders`) with the paths observed beneath it
(`/api/orders/{id}`, `/api/orders/{id}/items`), the `methods` seen on each path,
and the conventional `missingMethods` no call exhibited — so `/api/orders`
showing no `POST` and `/api/orders/{id}` no `DELETE` is visible at a glance.
`missingMethods` is only filled in for a resource that exposes an item path, so
a one-off `POST /api/login` is not reported as missing a `GET` it never had.

Every endpoint also carries `timing` — the p50, p95, and `max` of its
`durationMs` — and, when a body was captured, `requestBytes` / `responseBytes`
with the same shape, so the report doubles as a performance overview. Nearest-
rank percentiles are used, so every figure is an observation rather than an
interpolation. `cache` keeps the cache-relevant response headers (`cache-control`,
`etag`, `last-modified`, `age`, `vary`, and a CDN status) when any were present.
The Markdown report gains a **Performance** section listing the slowest endpoints
and largest responses, and `--diff` flags a response whose p95 grew by at least
50% *and* 5 KB — a performance regression, reported in plain language rather
than as an API break.

An endpoint categorized `analytics` or `third-party` whose host belongs to a
known vendor also carries `vendor`: the vendor's `name` and `category` (matched
from a catalog shared with the technology fingerprints, so a `Segment` script
and a call to `api.segment.io` name the same vendor), plus the `payloadKeys`
observed being sent — the request body's top-level field names and the query
parameter names, sorted. The report says `Stripe` or `Segment` rather than a
hostname; a host that is not a known vendor stays unattributed, and an empty
`payloadKeys` means the payload was not observed rather than that none was sent.

Finally, the report closes with `findings`: review cues derived from the capture,
so a scan ends with what to act on rather than only data. Each has a `kind`
(`unauthenticated`, `pii`, `missing-security-header`, `verbose-error`, or
`inconsistent-shape`), a `severity`, and the endpoint ids and evidence behind
it. They flag sensitive-looking endpoints that answered without a credential,
PII-shaped field names in the samples, security headers no response sent,
error bodies that leaked internals, and shapes that had to fall back to a
`oneOf` union within a single run. These are heuristics over whatever traffic
the scan triggered, not a security audit — the Markdown report says so in its
**Findings & Next Steps** section, and the dashboard shows the same list.

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
- **Group** by category, resource, or change kind. Each group gets a
  collapsible header with its count, and a left-hand nav lists the groups with
  per-group counts while you are grouped — so a hundred endpoints read as a
  handful of sections instead of one long table. Search and filters still apply,
  and a group only shows the rows that pass them.
- **Filter** by category, HTTP method, and status code.
- **Sort** by any column; the default order is discovery order.
- **Expand** a row for its headers, query and path params, and the inferred
  request/response schemas — rendered from the sampled bodies. WebSocket rows
  expand to their frames and inferred sent/received message schemas instead.
- **Diff** — with `--diff`, a Change column and "Changed only" / "Breaking only"
  filters appear. Without a baseline they are omitted entirely rather than
  shown empty.
- **Removed endpoints stay visible** — an endpoint that existed in the baseline
  and not in this scan has no row in the current report, so the dashboard
  reconstructs one from the diff. It appears struck through on a red row, sorts
  and searches like any other, and there is a `Removed (baseline)` filter to
  isolate the endpoints that disappeared. Only such rows carry no request or
  response detail, and they say so instead of showing empty sections.
- **Findings at a glance** — when the report carries findings, the summary tiles
  show their counts coloured by severity and a panel lists every cue, so the
  things to act on are the first thing you see.
- **Keyboard** — `/` focuses search, the arrow keys move between rows, and
  Enter/Space expands the focused one.
- **Dark mode** — the theme follows `prefers-color-scheme`, so the page darkens
  with the rest of your desktop rather than flashing white.
- **Sticky table** — the header row and the method column stay pinned while you
  scroll a long report.
- **Prints like `report.html`** — a print stylesheet drops the interactive
  controls and unpins the table, so the dashboard prints as a readable report.

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

Capture a baseline once, then compare later scans against it. The `baseline`
subcommand stores the report in one known place, and `--diff latest` reads it
back, so neither command names a file path:

```bash
# Capture the baseline — stored at .api-recon/baseline.json
api-recon baseline https://app.example.com

# Later, scan again and compare against the stored baseline
api-recon https://app.example.com --diff latest --out ./latest
```

`.api-recon/baseline.json` is discovered by walking up from the working
directory, like the project config file, so a baseline committed at the
repository root is found from any subdirectory and re-running `baseline` updates
it in place. Commit it to gate CI on the API surface changing. The sentinel also
works from `API_RECON_DIFF=latest` and from a config file's `"diff": "latest"`.

To keep a baseline somewhere else — a per-branch file, or several in parallel CI
jobs — pass `--baseline <file>` on both sides. It overrides only the stored
location; a relative path in a config file still resolves against that file:

```bash
api-recon baseline https://app.example.com --baseline baselines/main.json
api-recon https://app.example.com --diff latest --baseline baselines/main.json
```

If you would rather manage the file yourself, pass the path directly to
`--diff`:

```bash
# Capture a baseline anywhere
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

Error bodies are compared per status too: a field removed from a `422` body is
breaking, the same as any other removed field, while an endpoint that simply
started (or stopped) returning an error status is left to the status-code
comparison.

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

For CI, `--fail-on-diff` turns the finding into an exit code — with a committed
baseline and `latest`, the job names no path to manage:

```bash
api-recon https://app.example.com --diff latest --fail-on-diff
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
  writes an anonymized `telemetry.json` beside the reports, and
  `--telemetry-preview` prints the same payload to stdout without writing it. It
  contains no host, path, query value, header, or body, and nothing is ever sent
  over the network.
- The tool **never** bypasses authentication, CAPTCHAs, or bot protections, and
  never fuzzes or brute-forces endpoints.

## Telemetry (opt-in)

`api-recon` has no phone-home. The only diagnostics it can produce are written
to a **local** `telemetry.json` in the output directory, and only when you ask
for them — `--telemetry`, `API_RECON_TELEMETRY=1`, or `telemetry: true` from the
library. Nothing is ever sent over the network.

To read the payload before you commit to it, `--telemetry-preview` (or
`telemetryPreview: true` for the library) builds the same data but prints it to
stdout instead, and never creates `telemetry.json`. That makes it easy to
confirm for yourself that the payload describes nothing about your target.

A scan usually targets a private system, so the payload deliberately holds only
the *categorization decisions*: for each endpoint, the category, the heuristic
that produced it, the HTTP method, and whether the response was JSON. No host,
path, query value, header, or body is included — the payload is safe to share
precisely because it cannot describe the target:

```jsonc
{
  "version": 1,
  "apiReconVersion": "0.2.9",
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
npm run examples:generate  # regenerate examples/output
```

The integration suite runs the whole pipeline against a local fixture site
(`test/fixtures/`) covering data fetching, mutations, login + cookie-protected
APIs, pagination via scripted actions, a same-origin analytics beacon, a
cross-origin partner endpoint, and a robots-disallowed page.

`npm run examples:generate` drives that fixture over plain HTTP and writes the
committed reports in `examples/output/`. It binds fixed ports (4610/4611) and
reads a fixed clock, so it is reproducible: regenerating produces a diff only
when the report itself changed, not when it merely ran again.

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
