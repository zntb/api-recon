# Troubleshooting FAQ

The questions that come up when a scan does not do what you expected. Every
error `api-recon` raises is typed and ends in a hint (the `→` line); this page is
the longer version.

## The scan finished but found no endpoints

A scan only sees traffic the crawl triggered. The usual causes, in order:

1. **The API fires after a login.** Use `--login` or `--auth`; see
   [Authenticated SPA](cookbook/authenticated-spa.md).
2. **The calls need an interaction** — a tab, a search, a "load more". Script it
   with `--actions`, or use `--record` and click it yourself.
3. **The page is a client-side route** the crawl never reached. Seed the route
   directly: `api-recon https://app.example.com/settings`.
4. **The calls are cross-origin** (a separate API host). They are ignored unless
   you pass `--include-third-party`.
5. **The calls happen before the tool is listening.** The interceptor attaches
   to every page the context opens, so this is rare — but a service worker can
   serve cached responses that never hit the network. Try a headed `--record`
   run to watch what actually happens.

If it works interactively but not in the crawl, the missing step is the action.

## It refuses to scan localhost

```
Refusing to scan private/local address 127.0.0.1 — this usually means a mistake.
```

That is the local guard, and it is deliberate: scanning your own machine by
accident is the common case. Pass `--allow-local` when the target really is
yours.

## robots.txt disallows my seed URL

```
robots.txt disallows /app on https://example.com. Re-run with --force to override.
```

The seed path must be allowed by `robots.txt`, and paths under `/admin` (or
whatever the site disallows) are skipped during the crawl. `--force` bypasses
the rules; use it only for a system you are authorized to test. `--force` never
bypasses the local guard — that one still needs `--allow-local`.

## The PDF was skipped

`report.pdf` needs Chromium, because `page.pdf()` is Chromium-only. If the scan
ran in Firefox or WebKit, the PDF is skipped with a warning and everything else
is written. Install Chromium (`npx playwright install chromium`) and scan with
`--browser chromium`, or just read `report.html`.

## Are secrets ending up in the report?

Redaction is on by default and runs **at capture time**, so secrets never reach
any report: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
`X-Api-Key`, `X-Auth-Token`, `X-Csrf-Token`, and other sensitive headers;
JSON body fields and WebSocket frames with keys such as `password`, `token`,
`secret`, `apiKey`, `creditCard`, and `cvv`; and log lines are scrubbed too.

It is a denylist, not a proof. A report is still a picture of a live system:
review it before sharing, and prefer `--redact` (the default) on any scan whose
output leaves your machine. `--no-redact` exists for local debugging and is not
recommended.

## Can I commit the report or the baseline?

Yes — that is what the [CI gate](cookbook/ci-gate.md) is built on — but treat
them as you would any artifact derived from production traffic. Redaction has
already run; a review is still worth it. A saved `session.json` is a different
matter: it is a credential and must not be committed.

## "No stored baseline found"

```
No stored baseline found. Capture one first with `api-recon baseline <url>`.
```

`--diff latest` reads `.api-recon/baseline.json`; there isn't one yet, or it is
not in this directory or above it. Run `api-recon baseline <url>` once, or point
at a file with `--diff ./path/to/report.json`.

## "baseline report is not compatible with this build"

The baseline was written by an older build, before the report shape was
versioned. LoadBaseline refuses it rather than comparing a shape it does not
understand. Re-scan to produce a current report, then diff against that:

```bash
api-recon baseline https://app.example.com
```

## The diff reports changes I did not make

Some of the time, that is true and useful. The rest of the time:

- **"Not seen this time" is not "gone".** A scan samples the traffic the crawl
  triggered. A removed endpoint, operation, or field is reported with that
  evidence so you can judge whether the crawl simply did not exercise it.
- **The two scans may have run in different engines.** Sites serve different
  responses per browser; when the baseline's engine differs from the current
  scan's, the CLI summary, the Markdown report, and the dashboard all say so.
  Run both scans in the same engine where you can.
- **A response body that was only partly observed** — truncated, not JSON,
  binary — is not compared field by field; the diff says the shape was not
  compared rather than inventing a removal.

## Firefox and WebKit results differ from Chromium

They often do. Different `User-Agent` and `Accept` headers mean a site may serve
different bundles, and some APIs are polyfilled differently. If you only care
about the API surface, Chromium is the safer default; if you care about what a
given engine sees, record it in the report's `meta.engine` and keep the baseline
and the scan in the same engine. PDF rendering is always Chromium.

## A scan seems to hang

Navigation is bounded by an internal timeout (30 seconds per page), and
`--max-pages` caps the crawl, so a stall should resolve itself. If a large site
is simply slow, bound it harder:

```bash
api-recon https://app.example.com --depth 1 --max-pages 20 --rate 250
```

A page that never reaches network-idle is moved past after a short settle, so a
polling page does not stall the crawl.

## Where are the reports written?

`./api-recon-output` by default, or `--out <dir>`. `--print` sends a text format
to stdout instead, and `--open` launches the dashboard. A `--debug` run writes
its bundle to `<out>/debug`.

## The report is enormous

Cap it: `--max-body-mb` (1 MB per body/frame by default), `--depth`, and
`--max-pages` all bound size. The dashboard is the format built for a large
report — search, filter, and sort rather than scrolling a document.

## How do I collect a bug report?

```bash
api-recon https://app.example.com --debug
```

On failure, `--debug` writes a bundle to `<out>/debug`: `logs.txt` (every line
the run printed, already scrubbed), `trace.zip` (open with
`npx playwright show-trace`), and `partial-report.json` (whatever was captured
before the failure). Attach the three; the log alone usually names the step.
