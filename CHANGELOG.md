# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A security policy** — [`SECURITY.md`](SECURITY.md) states how to report a
  problem with the tool privately (a GitHub security advisory, not an issue),
  that only the 0.4.x line is supported, and what gets prioritized: anything
  that lets a secret reach a report is a release blocker, as is a weakness in
  the integrity manifest or its signature check, then the scope and
  `--allow-local` guards, then path handling. It also says what is out of
  scope — a site serving hostile content, scanning without permission, and
  advisories with no reachable path — and asks for a disclosure window rather
  than promising a bounty. `CONTRIBUTING.md` and the README's guardrails
  section point at it.

### Internal

- **The published package is now tested** — every test imported from `src/`, so
  a broken `exports` map, a lost bin shebang, a missing `.d.ts`, or a `files`
  allowlist that dropped a directory would pass the whole suite and ship. A new
  `npm run check:published` (`scripts/check-published.ts`) loads the built
  package the way a consumer does: it fails if a target named in `exports` is
  missing from `dist/`, if an emitted `.js` has no declaration beside it, if
  `dist/index.js` does not load with `scan`, `SafetyError`, `CancelledError`,
  and `normalizeFormats` exported, or if the bin does not start and print the
  package version. `publint` and `arethetypeswrong` are now dev dependencies
  with `npm run check:publint` and `npm run check:types` (`attw` ignores the
  `cjs-resolves-to-esm` rule, which the ESM-only design expects). All three run
  as steps in the Linux CI job, after the build. The gate's own helpers are
  unit-tested, so the check is covered whether or not a build has run.

### Security

- **`api-recon verify` no longer reads outside the report directory** — the
  verifier resolved every file name in a `checksums.json` against the
  manifest's own directory with no containment check, so a manifest naming
  `../secret` steered a read of any file the process could reach and could be
  made to verify as intact. A manifest is the one artifact a recipient
  receives from a sender they may not trust, so names are now validated where
  the manifest is parsed: an absolute name, or one that climbs out with `..`,
  is refused as a `SafetyError` before anything is opened. Names that stay
  inside are unaffected, including a nested `payloads/…` entry and one that
  normalizes back in (`a/../b.json`), and existing manifests verify unchanged.

### Changed

- **`openapi3-ts` removed from the dependencies** — the OpenAPI reporter is
  hand-rolled and serializes its document with `js-yaml`, so nothing ever
  imported this package; it was an install cost for every user and nothing
  else. The production dependency count drops from six to five, the lockfile
  no longer mentions it, and `openapi.yaml` is byte-for-byte unchanged.

## [0.4.2] - 2026-10-02

### Added

- **Timeouts, retries, and a resumable crawl** — a page that never finishes
  loading can no longer stall or silently drop a crawl. Every navigation is
  bounded by `--timeout <ms>` (default 30s) and retried once, and a page that
  still fails is recorded without its content. After each page the scan writes a
  `<out>/checkpoint.json` with the crawl frontier, the pages, and the traffic
  captured so far; `--resume` reads it back and continues instead of starting
  over, seeding the interceptor so the finished report covers the whole run. The
  seed URL must match, the checkpoint is versioned and holds only redacted
  capture data, and it is deleted once a run completes — so a leftover file
  means exactly one thing: a run that stopped early.
- **Guaranteed teardown** — a `SIGINT`/`SIGTERM` no longer leaves a Chromium
  process behind. `ScanOptions` accepts an `AbortSignal`; when it aborts, the
  scan closes the browser context, stops the crawl at the next page boundary,
  and flushes the capture so far to `<out>/report.json` before rejecting with
  the new `CancelledError`. The checkpoint is left in place, so the interrupted
  run continues with `--resume`. The CLI wires this to `SIGINT` and `SIGTERM`
  and exits with the conventional `128` + signal (`130`/`143`); a second signal
  exits at once, so a wedged teardown is still escapable.
- **Memory bounded on every axis** — each thing that could grow without limit
  now has its own cap instead of leaning on the single global byte budget:
  `--max-calls` (10000) bounds captured calls and the endpoint list,
  `--max-sockets` (100) bounds WebSocket connections, `--max-frames` (200)
  bounds frames per connection, and `--max-pages` now applies to record mode.
  Past a cap the data is counted but not stored, and the scan warns. An
  oversized JSON body is spilled in full — redacted — to `<out>/payloads/` and
  referenced from the report (`requestBodyFile` / `responseBodyFile` on an
  endpoint, `bodyFile` on an error response), so the full body survives without
  being held in memory; `--checksum` covers the spilled files. Spilling is off
  when there is no output directory.
- **`--login` / `--actions` validated up front** — a malformed step used to fail,
  or be silently skipped, deep inside a crawl. Both files are now checked before
  the browser opens, and a problem is reported as a `SafetyError` (exit `2`)
  naming the offending path and line (`steps[1].fill.value`), with an exact line
  and column for a YAML/JSON syntax error. Extra fields, a step with more than
  one key, an unknown step, and an empty object are rejected too.

### Changed

- **A demanding, mobile-friendly redesign** — every HTML artifact now shares one
  typographic system instead of a single sans stack: a serif display face for
  headings and the report's prose, a neutral sans for controls, and mono for
  machine data (paths, methods, numbers, and code). Neutral surfaces moved to
  cool steel blues, corner radii are varied by role, and the dashboard replaces
  its row of identical bordered tiles with one hairline-divided instrument strip
  of mono readouts under a serif masthead. On a phone-sized screen the dashboard
  table becomes a stack of labelled cards instead of a sideways-scrolling grid.
  No data, flags, or report fields change.

### Internal

- **A flake budget for the browser suite** — the tests are now two vitest
  projects (`unit` and `browser`, run by `npm run test:unit` / `test:browser`),
  and CI runs them as separate jobs. The browser project retries a failed test
  once instead of re-running the whole suite, and with `API_RECON_TEST_TRACE=1`
  every scan records a Playwright trace that is kept on failure and uploaded as
  the `browser-traces` artifact for triage.
- **Dependency refresh** — updated the lockfile to the latest versions that
  remain mutually compatible (`@types/node`, `typescript-eslint`, `vitest`, and
  transitive packages), all within the existing ranges, so no manifest change
  was needed. TypeScript stays on 6.x because `typescript-eslint` peers on
  `typescript >=4.8.4 <6.1.0`; jumping to TypeScript 7 would require that
  toolchain to widen its range first. `npm audit` reports 0 vulnerabilities.
- **Example freshness in CI** — because generation is deterministic,
  `npm run check:examples` now generates the sample reports into a temporary
  directory and compares them to the committed ones, failing when a report was
  added, removed, or changed without being regenerated. Generating into a temp
  directory rather than over `examples/output/` means it never clobbers
  uncommitted local edits, and hand-written files such as
  `examples/output/README.md` are excluded. `scripts/generate-examples.ts`
  exports `generateExamples(outDir)` for the check to reuse (the direct-run path
  is unchanged), and the run is part of the Linux CI gate.

## [0.4.1] - 2026-10-02

Adds optional integrity over the written reports, with a manifest a recipient
can verify and an HMAC signature for origin, plus two supply-chain and privacy
hardening changes. No existing flags, options, or report fields change.

### Added

- **Integrity for shared reports** — `--checksum [sha256|sha512]` writes a
  `checksums.json` beside the reports recording a digest of every file, so a
  recipient can recompute it and confirm the artifact was not edited. Add
  `--sign-key <file>` to sign the manifest with an HMAC, so a holder of the key
  can also confirm the manifest itself came from the scan rather than being
  rewritten alongside a doctored report. The new `api-recon verify <manifest>`
  subcommand checks a directory against its manifest (with `--sign-key` when it
  is signed) and exits `2` on a mismatch, so CI can gate on it. The manifest
  records the tool name and version, playing the part the npm provenance
  attestation plays for the published tarball: linking an artifact to the run
  that produced it. Off by default; the hashes are computed over the files on
  disk, and the manifest never covers itself.
- **Redaction by value, not only by key** — redaction now also masks a secret by
  its shape, so a JWT, a high-entropy base64/hex blob, an email, a phone number,
  or an SSN-shaped national id is caught even under a key that does not name it.
  It applies to header values and to every string in a body — nested objects,
  arrays, and a sensitive key's whole subtree — and a non-JSON body is replaced
  only when the body itself is the secret, not when it merely mentions one.
- **Query parameter values masked by name** — a query parameter whose name marks
  it sensitive (`token`, `key`, `code`, `email`, and the password/secret family)
  now keeps its name and its presence in `queryParams` but has its
  `sampleValues` masked, so a token or address passed in the query string no
  longer rides into the report on a field the body and header redactors never
  touched. Names are matched word-for-word after splitting camelCase and
  separators, so `accessToken` and `api_key` are caught while `monkey` is not,
  and the masking follows `--no-redact` like every other redaction.
- **Redaction is verified before the report is written** — a `SecretLedger`
  records the original value each time redaction masks a header, a body string, a
  WebSocket frame, or a sensitive query parameter, and the assembled report is
  walked for any of them. A survivor means a secret reached a field the redactors
  never touch — a page URL, an origin, metadata — and is a loud warning naming the
  report paths (never the secret), or a refusal to write under
  `--strict-redaction`. Values shorter than six characters are not tracked, so a
  short secret cannot be mistaken for a status code on a clean report.
- **Explicit scan scope** — `--include-host` adds hosts the crawl may follow
  beyond the seed's (a bare host, a `host:port`, or a URL), for a multi-host app,
  and `--exclude-path` skips a path prefix (`/admin`) or a glob (`*.pdf`). A
  redirect that leaves scope is now refused rather than followed — the
  destination is neither recorded nor inspected, and the warning names the
  `--include-host` that would allow it — so a hostile or sprawling site cannot
  bounce the scan somewhere you never agreed to. Scope is host-with-port,
  matching the existing same-domain rule, so an `http -> https` upgrade or a
  `www` redirect stays in scope while a different port does not.
- **Safer credential handling** — a session written by a login flow's
  `saveStateTo` is saved owner-only (`chmod 600`), since it holds live cookies; an
  `--auth` file that is group- or world-readable is flagged with a warning on
  startup; and nothing is persisted unless `saveStateTo` asks for it, so passing
  `--auth` reads a session but never rewrites it.

### Internal

- **Supply-chain hygiene** — GitHub Actions in every workflow are now pinned to
  a commit SHA (named by release in a trailing comment) so a repointed tag
  cannot run new code unnoticed, and [`.github/dependabot.yml`](.github/dependabot.yml)
  keeps both the actions and the npm dependencies current. CI gained two gates:
  `npm audit --audit-level=high` fails on a high or critical advisory in the
  dependency tree, and `npm run check:pack` (`scripts/check-pack.ts`) runs
  `npm pack --dry-run` and fails if the published tarball holds anything outside
  `dist/`, `schema/`, `completions/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and
  `package.json` — so a session file, a debug bundle, or the source tree cannot
  ship by accident.
- **The telemetry boundary is a contract** — the anonymized payload's shape is
  written down as `TELEMETRY_PAYLOAD_KEYS` / `TELEMETRY_SIGNAL_KEYS` in
  `src/core/telemetry.ts`, and `test/unit/telemetry.test.ts` asserts a built
  payload carries exactly those keys at both levels. A future field therefore
  fails the build until it is deliberately added to the boundary.
  `telemetryBoundaryViolations` also refuses a nested object or array where a
  scalar belongs — the place a captured host or path could hide behind an
  allowed field name — and is exported so an embedding application can assert
  the same contract on a payload it receives.

## [0.4.0] - 2026-10-01

### Added

- **A first-class diff workflow** — `api-recon baseline <url>` scans and stores
  the report as `.api-recon/baseline.json`, and `--diff latest` compares against
  it, so the CI-gate use case no longer manages a path. The stored location is
  one canonical file, discovered by walking up from the working directory like
  the project config file (a baseline committed at the repository root is found
  from any subdirectory, and re-running `baseline` updates it in place). `latest`
  is recognized as a sentinel from a flag, `API_RECON_DIFF`, or a config file's
  `"diff"`, while a real relative path in a config file still resolves against
  the file. `--baseline <file>` overrides the stored location on both sides —
  for a per-branch baseline or several in parallel CI jobs — and a missing
  baseline fails with the command that creates one.
- **Better failure output** — a deliberate failure is now a typed error that
  ends in a next step. `SafetyError` is a guard refusing to start (exit `2`),
  `RuntimeError` is a scan that failed (exit `1`), and both extend
  `ApiReconError`, which carries an optional `hint`. The CLI prints that hint
  under every message — the safety guards, the config loader, the baseline
  loader, and the engine resolver all attach one — so a failure tells you what
  to try. `--debug` turns a failed run into a bundle for a bug report:
  `debug/logs.txt` (every log line, secret-scrubbed), `debug/trace.zip` (a
  Playwright trace, openable with `npx playwright show-trace`), and
  `debug/partial-report.json` (the report built from whatever was captured
  before the failure). The bundle is best-effort and never replaces the error;
  the library gets the same behavior with `scan({ debug: true, debugDir })`.
- **Shell completion** — `api-recon completion bash|zsh|fish` prints a completion
  script for the shell. It is generated from the same `commander` program the
  CLI parses with, so a flag added there is completed without a second list;
  only the values a flag accepts (an engine, a preset, a format, a file) are
  declared. It completes the subcommands, every flag, and the values that
  matter — engines, presets, print formats, report formats, and file paths — and
  the output is deterministic, so the committed scripts under `completions/`
  (regenerated with `npm run completions:generate`) can be diffed; a test fails
  when they drift from the flags.
- **An events API for the library** — `scan()` returns a promise of the result
  that is also an async iterator, so an embedding application can show its own
  progress and stream endpoints as they are grouped, against one scan rather
  than two:

  ```ts
  for await (const event of scan({ url })) {
    // phase | page | endpoint | done
  }
  ```

  `phase` and `page` arrive while the crawl runs, `endpoint` once per grouped
  pattern, and `done` last with the same `ScanResult` that `await scan()`
  resolves to; a failure is rethrown by both. `ScanEvent` and `ScanHandle` are
  exported, and the existing `onProgress` callback is unchanged.
- **A docs site and cookbook** — the task-shaped material now lives under
  `docs/`, linked from the README rather than swelling it: recipes for an
  [authenticated SPA](docs/cookbook/authenticated-spa.md), a
  [GraphQL endpoint](docs/cookbook/graphql.md), a
  [WebSocket app](docs/cookbook/websocket.md), and a
  [CI gate](docs/cookbook/ci-gate.md), plus a
  [troubleshooting FAQ](docs/faq.md). `src/docs/site.ts` renders the Markdown
  into a static site under `docs-site/` with the same theme and brand as every
  report; `npm run docs:generate` rebuilds it, and a test fails when a committed
  page is stale.
- **Dashboard accessibility** — `dashboard.html` is operable without a mouse and
  readable with a screen reader. Sortable column headers are real buttons that
  carry `aria-sort`, so the order can be set and its direction announced from the
  keyboard; each row's disclosure is a button that names the endpoint and points
  at the detail row it opens (`aria-controls`); the result count is an
  `aria-live` region; each summary tile is a named group; and the table has a
  caption over a focusable, labelled scroll region, so a wide table scrolls from
  the keyboard. The shared theme gained a `--link` role at the ramp's
  readable-ink step, taking light-mode link text from 4.3:1 (below AA) to 8.0:1
  while the accent stays for focus rings and fills; `test/unit/contrast.test.ts`
  now fails if any text token drops under 4.5:1.
- **A share-safe mode** — `--share` writes a single one-page summary,
  `share.md`, instead of the full reports: request patterns, categories, status
  codes, call counts, and inferred schemas, with no request or response body,
  header, query value, socket frame, page URL, or origin. It is safe by
  construction rather than by redaction, so sharing the output cannot leak what
  the scan saw — finding details are dropped too, since one of them quotes a
  slice of an error body. `--share` replaces the whole format set, so no sampled
  report is written beside it, and a `--print` in the same run prints the
  summary. `share` also works as an ordinary format (`--formats share`,
  `--print share`) and is deliberately absent from the defaults.

## [0.3.9] - 2026-09-30

### Added

- **`--open` and `--print`** — a scan can end in the artifact you wanted.
  `--open` launches `dashboard.html` in the browser when the scan finishes
  (adding the dashboard to the formats if it was not requested), and prints the
  path instead when nothing can be launched. `--print [md|json|openapi|html]`
  sends a report to stdout through the same reporters that write the files, so
  what a pipe receives is what the file would have contained; with `--print`,
  every human line moves to stderr, so `api-recon <url> --print > report.md`
  holds only the report. `open` cannot be set in a config file, since it would
  pop a browser open on whoever runs the command; `API_RECON_OPEN`,
  `API_RECON_PRINT`, and `API_RECON_NO_OPEN` cover the scripted cases.
- **Presets** — `--preset quick|deep|ci` bundles the flags people otherwise piece
  together by hand: `quick` looks at one page without a crawl (and without the
  slow PDF render), `deep` crawls further and captures cross-origin traffic, and
  `ci` is bounded, quiet, and machine-readable. Each is only a bundle of ordinary
  settings — `--verbose` names the ones it applied — and it layers between the
  environment and the config file, so a flag or an `API_RECON_*` variable beats
  it and it beats a committed `depth: 3`. `preset` cannot be set in a config file
  for the same reason: commit the flags, keep the shorthand for the run in front
  of you. An unknown name lists the alternatives.
- **Project config file** — a team can commit the flags it always uses in
  `.api-reconrc` (or `api-recon.config.json` / `.api-reconrc.json`), discovered
  by walking up from the working directory, named explicitly with `--config
  <file>` or `API_RECON_CONFIG`, and skipped with `--no-config`. Settings use
  the same names as the long flags (camelCase or kebab-case), and a relative
  path in the file — `login`, `actions`, `out`, `diff`, `auth` — resolves against
  the config file's own directory, so a committed file behaves the same from any
  subdirectory. Precedence is CLI > `API_RECON_*` environment > config >
  defaults. An unknown key is an error rather than a silently ignored typo, and
  two values are refused in a shared file — `force: true` and `redact: false` —
  because they would loosen safety for everyone who clones the repository; both
  still work from a flag or the environment.
- **Live scan progress** — a terminal now shows a running table while the scan
  works — phase, seed host, elapsed time, pages visited, requests and endpoints
  so far, and the last few pages and endpoints — redrawn in place and cleared
  before the summary. Piped output and `--quiet` stay silent (ANSI frames in a
  log file are noise), while `--json-progress` streams one JSON object per line,
  ending with a `done` event, for a machine to read. The library gets the same
  stream as `onProgress` on `scan()`.

## [0.3.8] - 2026-09-30

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
- **A consistent identity** — every HTML artifact and the PDF cover now lead with
  the same mark, and the two pages link an SVG favicon. Both are embedded (inline
  SVG and a `data:` URI), so a shared report is still one file with no asset
  beside it. The mark is drawn from the theme's ramp tokens, so it picks up dark
  mode and the print palette automatically.

### Changed

- **The palette is a documented colour ramp.** `theme.ts` now defines each hue as
  a scale whose steps mean a role (`-50` tinted surface, `-200` soft fill, `-500`
  full strength, `-600` pressed, `-700` readable ink), with the status and accent
  tokens aliasing it. Dark mode therefore redefines the ramp instead of restating
  thirteen colours, and print pins the ramp to its light values — a report printed
  from a dark desktop used to put dark ink on the black print tile.

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

[Unreleased]: https://github.com/zntb/api-recon/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/zntb/api-recon/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/zntb/api-recon/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zntb/api-recon/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/zntb/api-recon/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/zntb/api-recon/compare/v0.3.7...v0.3.8
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
