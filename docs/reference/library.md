# Library API

`api-recon` is ESM-only and published with type declarations. Install it as a
dependency and drive a scan from Node:

```bash
npm install api-recon
npx playwright install chromium
```

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
`includeThirdParty`, `allowLocal`, `maxBodyBytes`, `browser`, …), including
`checksum` and `signKey` for the integrity manifest. The digest and manifest
functions are exported too — `buildIntegrityManifest`, `verifyIntegrityManifest`,
and `verifyManifestFromDisk` — for an application that wants to check a report
without the CLI.

The typed error classes are exported as well, so a host application can tell a
refusal from a failure: `SafetyError` (a guard refused to start), `RuntimeError`
(a scan that started and then broke), `CancelledError` (stopped on request), and
their shared base `ApiReconError`, each carrying an optional `hint` — the same
one the CLI prints under a failure.

Pass a `signal` (an `AbortSignal`) to stop a scan on your own terms: when it
aborts, the browser is closed, the partial capture is written to
`<out>/report.json`, and the promise rejects with the exported `CancelledError`
(leaving the checkpoint in place for a later `resume`).

Types are exported for every report structure:

```ts
import type { ReconReport, Endpoint, ScanOptions, ScanResult, ScanEvent } from 'api-recon';
```

TypeScript consumers should use `moduleResolution: "node16"`, `"nodenext"`, or
`"bundler"`; the package is ESM-only, so there is no CommonJS `require` entry.

## Events

`scan()` returns a promise of the result that is also an async iterator, so an
embedding application can draw its own progress and stream endpoints as they are
grouped — against one scan, not two:

```ts
import { scan } from 'api-recon';

for await (const event of scan({ url: 'https://example.com', depth: 2 })) {
  switch (event.type) {
    case 'phase':    console.error(event.phase); break;             // crawling | recording | analyzing
    case 'page':     console.log('visited', event.page.url); break;
    case 'endpoint': console.log('found', event.endpoint.id); break;
    case 'done':     console.log(event.result.report.endpoints.length); break;
  }
}
```

`phase` and `page` arrive while the crawl runs, `endpoint` once per grouped
pattern, and `done` last, carrying the same `ScanResult` that `await scan(...)`
resolves to. A caller that only awaits still works unchanged; so does the
`onProgress` callback.

Comparing two reports without scanning at all is exported too — see
[Comparing scans](../reference/diffing.md).
