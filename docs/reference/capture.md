# What a scan captures

For every XHR/fetch request it records the method, normalized URL, status,
MIME type, redacted request/response headers, request body, JSON response body
(size-capped), timing, and the page that triggered it. Calls are deduplicated
by `(method, URL pattern, status)` and grouped into endpoints such as
`GET /api/orders/{id}`.

WebSocket connections opened by a page are captured too, with the frames sent
and received on each one (see [WebSocket capture](#websocket-capture)).

Endpoints are categorized with heuristics:

| Category | Heuristic |
| --- | --- |
| `authentication` | paths like `/login`, `/oauth`, `/token`, `/session`, `/sso` |
| `analytics` | analytics hosts (`google-analytics.com`, `segment.io`, …) or paths like `/track`, `/collect`, `/beacon` |
| `third-party` | anything cross-origin (only reported with `--include-third-party`) |
| `graphql` | the request carried a GraphQL operation (see [GraphQL detection](#graphql-detection)) |
| `mutations` | POST/PUT/PATCH/DELETE |
| `data-fetching` | GET/HEAD returning JSON |
| `uncategorized` | everything else |

The analyzer also infers **path parameters** (id-like segments), **query
parameters** with sample values, and **JSON schemas** (depth 4) for request and
response bodies. Where possible it fingerprints the stack (frameworks, CMS,
CDN, analytics) from headers, cookies, HTML, and script paths.

The rules themselves are data and small enough to audit: categorization lives in
[`src/core/analyzer.ts`](https://github.com/zntb/api-recon/blob/main/src/core/analyzer.ts)
and the technology fingerprints in
[`src/core/techStack.ts`](https://github.com/zntb/api-recon/blob/main/src/core/techStack.ts).

## GraphQL detection

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

See the [GraphQL cookbook recipe](../cookbook/graphql.md) for an end-to-end scan
of a GraphQL app.

## WebSocket capture

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

See the [WebSocket cookbook recipe](../cookbook/websocket.md) for a worked scan.

## Engines

The capture layer is engine-independent: `--browser` swaps the Playwright
driver, and interception, categorization, technology detection, and schema
inference all behave the same. The report records the engine it ran in
(`meta.engine`), so a scan is reproducible from its own output.

> Firefox and WebKit send different `User-Agent` and `Accept` headers than
> Chromium, and sites sometimes serve different responses per engine — so if
you only care about the API surface, Chromium is the safer default.

Each engine has to be installed before `--browser` can use it:

```bash
npx playwright install firefox webkit
```
