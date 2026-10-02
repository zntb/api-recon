# Telemetry (opt-in)

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

The payload's field set is itself a contract. `src/core/telemetry.ts` names the
exact keys (`TELEMETRY_PAYLOAD_KEYS`, `TELEMETRY_SIGNAL_KEYS`), and
`telemetryBoundaryViolations` checks a payload against them at both levels —
refusing a nested object or array where a scalar belongs, which is where a
captured host or path could otherwise hide behind an allowed field name. A new
field fails `test/unit/telemetry.test.ts` until it is deliberately added to the
boundary, so the local, key-free shape cannot widen by accident.
