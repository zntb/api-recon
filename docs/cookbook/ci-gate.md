# Gate CI on API changes

The API surface should not change by accident. A scan is a cheap way to build a
contract test you did not have to write: capture a baseline once, then fail the
build when a later scan differs in a way that could break a client.

## 1. Capture a baseline

```bash
api-recon baseline https://app.example.com --depth 2 --formats json
```

`baseline` scans and stores the report at `.api-recon/baseline.json`, discovered
by walking up from the working directory like the project config. Commit it:
it is the contract the gate compares against.

```bash
git add .api-recon/baseline.json
git commit -m "Capture the API baseline"
```

Because the baseline is ordinary `report.json`, redaction already ran at capture
time — commit it with the same care you would give any report.

## 2. Gate a build

```bash
api-recon https://app.example.com --depth 2 \
  --diff latest --fail-on-diff \
  --formats json,md --quiet
```

`--diff latest` reads the stored baseline, so no job has to remember a path.
`--fail-on-diff` turns a finding into exit code `3`.

| Exit | Meaning |
| --- | --- |
| `0` | Success — no changes, or changes with `--fail-on-diff` off |
| `1` | Runtime failure |
| `2` | Refused by a safety guard (a bad `--diff` file, a missing `latest` baseline, …) |
| `3` | `--fail-on-diff` found endpoint changes |

A change is flagged **breaking** when it can plausibly break a client — an
endpoint disappearing, a response no longer returning 2xx, a removed or retyped
response field, a lost GraphQL selection, a removed WebSocket message field.
Additions never are. The diff is also embedded in `report.json` and rendered in
`report.md` as **Changes Since Baseline**.

## 3. A GitHub Actions workflow

```yaml
name: api-contract

on:
  pull_request:
    branches: [main]

jobs:
  api-recon:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # includes .api-recon/baseline.json
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm install -g api-recon
      - run: npx playwright install --with-deps chromium

      - name: Compare against the baseline
        run: >
          api-recon https://staging.example.com
          --diff latest --fail-on-diff
          --preset ci --out reports

      - name: Upload the report and any debug bundle
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: api-recon
          path: reports
```

`--preset ci` is the bounded, quiet, machine-readable bundle (`depth 2`,
`maxPages 50`, `formats json,md`, `quiet`); see the README's presets table. The
`--out reports` directory holds `report.json` and `report.md`, and a failing run
with `--debug` adds a diagnostic bundle worth uploading for triage.

## Refreshing the baseline

A breaking change is sometimes intended. Refresh the baseline in the same pull
request and let the reviewer see both the code change and the new contract:

```bash
api-recon baseline https://staging.example.com --depth 2 --formats json
git add .api-recon/baseline.json
git commit -m "Accept the new /api/orders field"
```

Do it deliberately and review the diff — a baseline updated to silence a failing
gate is a gate that has stopped working.

## Parallel jobs and per-branch baselines

`--baseline <file>` overrides the stored location on both sides, so several
scans can keep separate baselines without touching the committed one:

```bash
api-recon baseline https://staging.example.com --baseline baselines/main.json
api-recon https://staging.example.com --diff latest --baseline baselines/main.json \
  --fail-on-diff
```

A relative `baseline` path in a config file resolves against that file, so a
committed `.api-reconrc` can point the whole team at one baseline.

## Watching a long run

For a pipeline that wants a heartbeat rather than a progress table:

```bash
api-recon https://staging.example.com --preset ci --json-progress | jq -c .
```

`--json-progress` emits one JSON object per line, ending in a `done` event.
Human output — the banner, the summary — stays off stdout in a pipe.

See also: [GraphQL](graphql.md) and [WebSockets](websocket.md) for the API
shapes the gate also compares.
