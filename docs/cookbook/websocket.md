# Scan a WebSocket app

For a real-time app the contract is not a response schema, it is the messages on
the socket. `api-recon` captures WebSocket connections alongside HTTP traffic:
each connection with the frames sent and received, and an inferred message shape
per direction.

## What gets captured

A connection is recorded with its URL, the origins that opened it, the page that
triggered it, and its frames:

```jsonc
{
  "url": "wss://example.com/live",
  "triggeredBy": "https://example.com/dashboard",
  "frameCount": 3,
  "sentCount": 1,
  "receivedCount": 2,
  "framesTruncated": false,
  "frames": [
    { "direction": "sent", "type": "text", "payloadSample": "{\"subscribe\":true}",
      "size": 17, "truncated": false, "at": 1699999999999 }
  ]
}
```

Frames follow the same rules as HTTP bodies:

- **Redaction runs at capture time.** A `token`-shaped field in a frame is masked
  exactly like one in a request body, so what lands on disk is already safe.
- **Sizes are capped** per frame by `--max-body-mb`, and drawn from the same
  total-size budget as HTTP bodies.
- **Chatty streams are bounded** by a per-connection frame cap. The connection
  still reports how many frames were *seen* in `frameCount`, and sets
  `framesTruncated` when some were not stored.
- **Binary frames** are stored base64-encoded.

JSON frames are summarized into `sentSchema` (what the page sent, like a request
body) and `receivedSchema` (what it received, like a response), merged across
every frame with the same depth-capped inference the HTTP bodies use.

## Open the socket

Sockets usually open after a click, so either drive the UI:

```yaml
# flows/open-socket.yaml
- click: 'button#connect'
- wait: 2000                  # let the handshake and first messages happen
- click: 'button#send-ping'
```

```bash
api-recon https://app.example.com/dashboard --actions flows/open-socket.yaml \
  --depth 1
```

…or open it yourself, which is easier when the trigger is a menu:

```bash
api-recon https://app.example.com --record
```

If the socket is on another origin — a collaboration or presence service, say —
it is treated like any cross-origin call and is only captured with
`--include-third-party`:

```bash
api-recon https://app.example.com --record --include-third-party
```

## The report

- **Markdown / HTML / PDF** gain a **WebSocket Traffic** section with each
  connection's frames and message schemas.
- **The dashboard** lists each connection as a row whose expanded view is its
  frames and message shapes.
- **Diffing** matches connections by URL and compares the *shape* of the sent
  and received JSON, so a field dropping out of a received message is flagged
  breaking — `WebSocket received message field removed: value` — while a new one
  is additive. Frame streams themselves are not compared byte for byte, because
  a scan records whatever the crawl happened to trigger.

## A note on flakiness

Real-time traffic is timing-sensitive: a socket that emits on join may look
different on a slow run. Give the app a moment (`wait` actions, or `--rate`) and
expect the *shape* comparison to be stable even when the frame count is not. If
a socket is persistently missing, it opened before the crawl's first page was
attached — in `--record` mode you can watch it connect, or seed the scan at the
page that opens it.

See also: [Authenticated SPA](authenticated-spa.md) when the socket needs a
session, and the [FAQ](../faq.md) for size caps and redaction.
