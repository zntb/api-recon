# CLI reference

Every flag, subcommand, and exit code, plus the flags people otherwise piece
together by hand. For the task-shaped material — a recipe per kind of app, and
what to do when a scan misbehaves — see the [authenticated SPA](../cookbook/authenticated-spa.md),
[GraphQL](../cookbook/graphql.md), [WebSocket](../cookbook/websocket.md), and
[CI gate](../cookbook/ci-gate.md) recipes, and the [FAQ](../faq.md).

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `<seedUrl>` | — | Start URL (required) |
| `baseline <seedUrl>` | — | Subcommand: scan and store the report as the baseline for `--diff latest` |
| `completion <shell>` | — | Subcommand: print a completion script for `bash`, `zsh`, or `fish` |
| `verify <manifest>` | — | Subcommand: check reports against a `checksums.json` integrity manifest |
| `-d, --depth <n>` | `1` | Same-domain crawl depth (0 = seed page only) |
| `-m, --max-pages <n>` | `25` | Hard cap on pages visited (and on pages recorded in `--record` mode) |
| `--max-calls <n>` | `10000` | Cap on captured API calls retained, which bounds the endpoint list; later calls are counted but not stored |
| `--max-sockets <n>` | `100` | Cap on WebSocket connections retained; later connections are counted but not stored |
| `--max-frames <n>` | `200` | Frames stored per WebSocket connection; later frames are counted but not stored |
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
| `--timeout <ms>` | `30000` | Per-navigation timeout; a page that does not load is retried once |
| `--resume` | off | Continue from `<out>/checkpoint.json` left by a crashed or cancelled run |
| `--respect-robots` / `--no-respect-robots` | on | robots.txt compliance (`--no-…` requires `--force`) |
| `--include-third-party` | off | Also capture cross-origin XHR/fetch calls and WebSockets |
| `--include-host <hosts>` | — | Comma-separated extra hosts the crawl may follow, for a multi-host app (a `host:port` for a non-default port) |
| `--exclude-path <paths>` | — | Comma-separated URL paths to skip, as a prefix (`/admin`) or a glob (`*.pdf`) |
| `--redact` / `--no-redact` | on | Redact sensitive headers and secret- or PII-shaped values in bodies and WebSocket frames |
| `--strict-redaction` | off | After the scan, refuse to write the reports if a redacted value still appears in them (by default that is a loud warning) |
| `--force` | off | Bypass robots.txt restrictions (only for systems you may test) |
| `--allow-local` | off | Allow scanning localhost/private network ranges |
| `--max-body-mb <n>` | `1` | Maximum response body / WebSocket frame size kept in memory, in MB; an oversized JSON body is spilled in full to `<out>/payloads/` (see [Keeping memory bounded](#keeping-memory-bounded)) |
| `--telemetry` | off | Write anonymized categorization signals to `telemetry.json` (no host, path, or body data) |
| `--telemetry-preview` | off | Print that payload to stdout without writing `telemetry.json` |
| `-q, --quiet` / `-v, --verbose` | — | Reduce / increase progress output |
| `--json-progress` | off | Emit progress as JSON lines on stdout instead of a live table |
| `--preset <name>` | — | Bundle the flags for a common case: `quick`, `deep`, `ci` (see [Presets](#presets)) |
| `--open` | off | Open `dashboard.html` in your browser when the scan finishes |
| `--print [format]` | — | Print a report to stdout: `md` (default), `json`, `openapi`, `html`, or `share` |
| `--share` | off | Write only a share-safe one-page `share.md` — patterns, categories, and schemas, with no bodies, headers, or samples |
| `--checksum [algorithm]` | — | Write a `checksums.json` integrity manifest over the reports (`sha256` by default, or `sha512`) |
| `--sign-key <file>` | — | Sign that manifest with the HMAC key in the file (implies `--checksum`) |
| `--config <file>` | discovered | Project config file (see [Project config](#project-config)) |
| `--no-config` | — | Ignore any project config file, even one found on the way up |
| `--debug` | off | On failure, write `debug/logs.txt`, a browser trace, and the partial report for a bug report |

Exit codes: `0` success, `1` runtime failure, `2` refused by a safety guard
(`--force`, `--allow-local`, a bad `--diff` file, a missing `latest` baseline,
…) or a failed `verify`, `3` `--fail-on-diff` found endpoint changes.

## When a scan fails

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

## Shell completion

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

The script completes the subcommands (`baseline`, `completion`, `verify`), every
flag, and the values that matter — engines, presets, print formats, report
formats, checksum algorithms, and file paths for `--auth`, `--login`,
`--actions`, `--config`, `--diff`, `--baseline`, `--sign-key`, and `--out`. It is
generated from the same command definition the CLI parses with, so a flag added
there is completed without a second list. The
scripts are committed under [`completions/`](https://github.com/zntb/api-recon/tree/main/completions)
and a test keeps them in sync with the flags, so changing a flag means running
`npm run completions:generate`; the output is deterministic, so the diff is
readable.

## Presets

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

## Project config

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
`API_RECON_RESPECT_ROBOTS`, `API_RECON_INCLUDE_THIRD_PARTY`,
`API_RECON_INCLUDE_HOST`, `API_RECON_EXCLUDE_PATH`, `API_RECON_REDACT`,
`API_RECON_STRICT_REDACTION`, `API_RECON_FORCE`, `API_RECON_ALLOW_LOCAL`, `API_RECON_TELEMETRY`,
`API_RECON_TELEMETRY_PREVIEW`, `API_RECON_MAX_BODY_MB`, `API_RECON_MAX_CALLS`,
`API_RECON_MAX_SOCKETS`, `API_RECON_MAX_FRAMES`, `API_RECON_QUIET`,
`API_RECON_VERBOSE`, `API_RECON_JSON_PROGRESS`, `API_RECON_RECORD`,
`API_RECON_SHARE`, `API_RECON_DEBUG`, `API_RECON_CHECKSUM`, `API_RECON_SIGN_KEY`,
`API_RECON_TIMEOUT`, `API_RECON_RESUME`. Booleans take `1`/`0` (also
`true`/`false`, `yes`/`no`, `on`/`off`), and `API_RECON_CHECKSUM` also accepts
`sha256` or `sha512`.

Two values cannot be committed in a shared file: `force: true` and
`redact: false`. Each loosens a safety default for everyone who clones the
repository, so both are refused with an explanation and still work from a flag
or the environment, where the choice is explicit for that run. Run with
`--verbose` to see which file was used and which settings came from it.

`scan()` itself reads no config file — the library takes explicit options, so an
embedding application keeps control.

## The result you wanted

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

## Progress

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

For an event-oriented API — phases, pages, and endpoints as they are discovered —
see [Events](../reference/library.md#events) under the library API.

## Timeouts and resuming

A page that never finishes loading must not stall the whole crawl, so every
navigation is bounded by `--timeout <ms>` (default 30s) and retried once before
it is recorded without its content. A flaky page costs a retry, not the page.

After each page the scan writes everything it takes to continue — the crawl
frontier, the pages, and the traffic captured so far — to
`<out>/checkpoint.json`. If a run crashes or you cancel it with Ctrl+C, point
the same command at the same output directory with `--resume`:

```bash
# A long crawl that stopped partway through…
api-recon https://app.example.com --depth 5 --max-pages 500 --out ./reports

# …continues from ./reports/checkpoint.json instead of starting over
api-recon https://app.example.com --depth 5 --max-pages 500 --out ./reports --resume
```

The seed URL must match the checkpoint's, and the checkpoint is deleted once a
run completes, so a leftover file means exactly one thing: a run that stopped
early. It is versioned, so a checkpoint from an older shape is refused rather
than misread, and it holds only redacted capture data — the same fields the
reports keep. Resuming keeps the original start time, so the finished report
spans the whole capture rather than only the part after the resume.

## Stopping a scan

Ctrl+C is a clean stop, not an abandoned process. On `SIGINT` or `SIGTERM` the
scan closes the browser, stops the crawl at the next page boundary, and flushes
the capture so far to `<out>/report.json` before it exits — so a long crawl
never leaves a Chromium process behind, and the interrupted run is still worth
reading. The checkpoint is deliberately kept, so the run continues with
`--resume`. The exit code is the conventional `128` + signal: `130` for
`SIGINT`, `143` for `SIGTERM`. Pressing Ctrl+C a second time skips the graceful
path and exits at once, so a wedged teardown is never something you cannot
escape.

## Keeping memory bounded

A long crawl of a busy app can bury a small machine in captured traffic, so
every axis has its own cap rather than sharing one global budget:
`--max-calls` bounds the captured calls (and so the endpoint list),
`--max-sockets` bounds WebSocket connections, `--max-frames` bounds frames per
connection, `--max-pages` bounds pages (in record mode too), and `--max-body-mb`
bounds any single body held in memory. Past a cap the data is still counted but
no longer stored, and the scan warns, so a capped run says so instead of looking
complete.

An oversized JSON body is not thrown away. When an output directory is set, the
full body is written — redacted, exactly like the in-memory sample — under
`<out>/payloads/`, and the report references it (`requestBodyFile` /
`responseBodyFile` on an endpoint, `bodyFile` on an error response). The name is
relative to the output directory, so the reports and their side files move
together, and `--checksum` covers them. A scan with no `--out` has nowhere to
spill, so it truncates in memory as before.
