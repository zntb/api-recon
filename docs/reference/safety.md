# Safety guardrails

The defaults below are on because a crawler pointed at a site you do not own is
a tool that can do real damage. Each one is a refusal, not a warning.

- **robots.txt** is fetched and enforced by default; the seed path itself must
  be allowed. `--force` bypasses the rules and prints a warning.
- **Rate limiting** waits at least `--rate` ms between requests to the same
  origin, and respects `Crawl-delay` when it is stricter.
- **Redaction is on by default** and runs at capture time, so secrets never
  reach any report. Known-sensitive names are masked — the headers
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`,
  `X-Auth-Token`, `X-Csrf-Token`, `X-Xsrf-Token`, and body/WebSocket keys such as
  `password`, `token`, `secret`, `apiKey`, `creditCard`, `cvv` — and a value is
  masked on its own shape even under a name that does not name it: a JWT, a
  high-entropy base64/hex blob, an email, a phone number, or an SSN. A query
  parameter whose *name* marks it sensitive (`token`, `key`, `code`, `email`,
  and the password/secret family) keeps its name and the fact that it was
  present, but its `sampleValues` are masked rather than reported. Redaction is
  also **verified rather than assumed**: after the report is assembled it is
  searched for the original values redaction removed, and any survivor is a loud
  warning — or, with `--strict-redaction`, a refusal to write the reports.
- **The crawl stays in scope.** Links and SPA routes are followed only on the
  seed's host (plus any `--include-host`), `--exclude-path` skips paths you name,
  and a redirect that leaves that scope is refused — the destination is neither
  recorded nor inspected — so a hostile or sprawling site cannot bounce the scan
  somewhere you never agreed to. Add the destination's `host:port` to
  `--include-host` to follow it deliberately.
- **Local/private targets are refused** unless `--allow-local` is passed.
- **Size caps**: 1 MB per response body (`--max-body-mb`) and a global capture
  budget, plus `--max-pages` and `--depth` bounds. See
  [Keeping memory bounded](../reference/cli.md#keeping-memory-bounded) for the
  per-axis caps and payload spilling.
- **Telemetry is opt-in and local** — see [Telemetry](../reference/telemetry.md).
- The tool **never** bypasses authentication, CAPTCHAs, or bot protections, and
  never fuzzes or brute-forces endpoints.

Two values refuse to be committed in a shared project config file for the same
reason: `force: true` and `redact: false` would loosen a default for everyone
who clones the repository, so both are errors there and still work from a flag.

## Reporting a hole

Found a hole in any of that? Report it privately through
[`SECURITY.md`](https://github.com/zntb/api-recon/blob/main/SECURITY.md) rather
than opening a public issue. Findings about redaction or the integrity manifest
are treated as release blockers.

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
- A scan samples the traffic the crawl happened to trigger. "Not seen this
  time" is not proof an endpoint is gone; `--diff` says so in as many words.
