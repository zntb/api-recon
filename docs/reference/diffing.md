# Comparing scans

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

The [CI gate cookbook recipe](../cookbook/ci-gate.md) has a working GitHub
Actions job built on this.
