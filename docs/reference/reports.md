# Reports

What each format holds, and what the fields in `report.json` mean.

| File | Contents |
| --- | --- |
| `report.json` | Machine-readable source of truth |
| `report.md` | A one-line scorecard and a linked table of contents, then overview, technologies, endpoint tables with category badges, detailed endpoints, auth flows, third-party calls, safety notes, WebSocket traffic |
| `report.html` | Styled standalone version of the Markdown, set as a readable print-ready document |
| `report.pdf` | Rendered from the HTML with Playwright's `page.pdf()`: a cover page, running header/footer with page numbers, and an endpoint's detail kept whole |
| `openapi.yaml` | Best-effort OpenAPI 3.0 spec from inferred paths, methods, params, and schemas |
| `dashboard.html` | Interactive dashboard: search, filter, sort, and expand endpoints; the table becomes stacked cards on a phone |
| `share.md` | One-page, share-safe summary (with `--share`): patterns, categories, and schemas only — no bodies, headers, or samples |
| `checksums.json` | Optional integrity manifest (with `--checksum`): a digest per report, optionally HMAC-signed |
| `telemetry.json` | Opt-in anonymized categorization signals (see [Telemetry](../reference/telemetry.md)); never written unless enabled |

`report.html` and `dashboard.html` share one theme (`src/reporters/theme.ts`):
the same colours, typography, spacing, and code blocks, and both follow your
`prefers-color-scheme`. Content that cannot wrap — a long URL, a payload —
scrolls horizontally inside its table or code block instead of widening the
page.

The type has three deliberate roles: a serif display face for headings and the
report's prose, a neutral sans for controls, and mono for machine data — paths,
methods, numbers, and code. Neutral surfaces are cool steel blues rather than
true greys, so the brand hue sits on the page as one family. The result reads as
a document in `report.html` and as an instrument in `dashboard.html`, from the
same palette.

Look at [`examples/output/`](https://github.com/zntb/api-recon/tree/main/examples/output)
for a real report generated from the bundled fixture site.

## Identity and colour ramp

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

Link text uses a `--link` role rather than `--accent`: `--accent` is the brand
hue at full strength for focus rings and fills, but at 4.3:1 on a light surface
it falls below WCAG AA as text. `--link` points at `--brand-700`, the
readable-ink step, which clears AA in light mode (8.0:1) and stays legible in
dark and print. `test/unit/contrast.test.ts` holds every text token at 4.5:1.

## Page → request graph

`report.md` closes with a **page → request graph**, rendered as Mermaid for a
Markdown viewer and as inline SVG in `report.html` and `dashboard.html` (no
Mermaid runtime, so both stay self-contained and work offline). It joins each
page to the requests it triggered, using the `triggeredBy` recorded on every
call — a relationship the tables alone make the reader reconstruct. Only the
busiest 20 pages and 40 requests are drawn, and the report says what was left
out.

## PDF furniture

`report.pdf` is `report.html` plus the page furniture a document needs: a cover
naming the seed host, capture time, tool and report-schema version; a running
header and footer carrying the seed host and `Page N of M`; and break rules that
keep each `###` detail section — one endpoint, resource, or finding group — on a
single page.

## report.json

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

### Versions

`schemaVersion` names the shape of the document; `meta.apiReconVersion` names
the tool build that wrote it, so a report can be read by a consumer that knows
nothing about the tool's release numbering. The shape is published as
[`schema/report.schema.json`](https://github.com/zntb/api-recon/blob/main/schema/report.schema.json)
and CI validates the committed example against it. `--diff` refuses a baseline
whose `schemaVersion` it cannot read rather than guessing at an unfamiliar
shape.

### Schemas, and why one is missing

`requestBodySchema` and `responseSchema` (and a socket's `sentSchema` /
`receivedSchema`) are inferred across *every* sample, not just one body: a field
seen in any sample is present, a field is listed in `required` only when every
sample carried it, `integer` and `number` widen to `number`, and a field whose
samples genuinely disagree on the type becomes a `oneOf` union. A format hint
such as `description: "uuid"` is kept only when every sample agreed on it.

A `null` schema says only that there is no shape; why is in the reason beside
it. When a schema is absent — or was inferred from an incomplete body — the
endpoint carries `requestBodySchemaReason` / `responseBodySchemaReason`, error
contracts carry `schemaReason`, and socket directions carry `sentSchemaReason`
/ `receivedSchemaReason`. The value is one of `no-body` (nothing captured),
`not-json` (a body that is not a JSON object/array), `truncated` (cut off at
the size cap), or `binary` (a non-text payload), so a gap is not mistaken for a
contract. `--diff` skips the field-level comparison when either scan only
partly observed a shape, rather than reporting a removed field.

### Error contracts

An endpoint that was seen failing also carries `errorResponses`, one entry per
4xx/5xx status with that status's own `bodySample` and `schema`, so the failure
contract is documented rather than repeated from the success shape.

### Resources

The flat `endpoints` list is also clustered into `resources`: each is a
collection root (`/api/orders`) with the paths observed beneath it
(`/api/orders/{id}`, `/api/orders/{id}/items`), the `methods` seen on each path,
and the conventional `missingMethods` no call exhibited — so `/api/orders`
showing no `POST` and `/api/orders/{id}` no `DELETE` is visible at a glance.
`missingMethods` is only filled in for a resource that exposes an item path, so
a one-off `POST /api/login` is not reported as missing a `GET` it never had.

### Performance

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

### Vendors

An endpoint categorized `analytics` or `third-party` whose host belongs to a
known vendor also carries `vendor`: the vendor's `name` and `category` (matched
from a catalog shared with the technology fingerprints, so a `Segment` script
and a call to `api.segment.io` name the same vendor), plus the `payloadKeys`
observed being sent — the request body's top-level field names and the query
parameter names, sorted. The report says `Stripe` or `Segment` rather than a
hostname; a host that is not a known vendor stays unattributed, and an empty
`payloadKeys` means the payload was not observed rather than that none was sent.

### Findings

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
