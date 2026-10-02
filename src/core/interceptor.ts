/**
 * XHR/fetch traffic capture. Redaction and size caps happen here, at capture
 * time, so unredacted secrets never reach any downstream artifact.
 *
 * Calls are recorded from the `response` event rather than `requestfinished`:
 * pages often navigate immediately after a fetch resolves (a login submit
 * redirecting to a dashboard, for example), and the response can be disposed
 * before `requestfinished` runs — which silently drops the call. The `request`
 * event still stamps start time and the triggering page.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Page, Request, Response, WebSocket } from 'playwright';
import type { CapturedCall, CapturedWebSocket, WebSocketDirection } from '../types.js';
import { redactBody, redactHeaders, type SecretRecorder } from '../utils/redact.js';
import { isSameDomain, normalizeUrl } from '../utils/url.js';
import type { ScanScope } from './scope.js';

export interface InterceptorOptions {
  redact: boolean;
  /** Per-body cap in bytes. */
  maxBodyBytes: number;
  /** Total bytes of bodies and frames to keep across the whole scan. */
  totalBodyBytes?: number;
  includeThirdParty: boolean;
  seedUrl: string;
  /** Hosts in scope beyond the seed's, from --include-host. */
  scope?: ScanScope;
  /** Frames stored per WebSocket connection; later frames are counted but not kept. */
  maxWebSocketFrames?: number;
  /** API calls whose metadata is retained; later calls are counted but not stored. */
  maxCalls?: number;
  /** WebSocket connections retained; later connections are counted but not stored. */
  maxWebSockets?: number;
  /**
   * Directory for spilled payloads. When set, a body larger than
   * `maxBodyBytes` is written there in full (redacted) and the call records a
   * path to it, so the full body is preserved without holding it in memory.
   * When unset (a scan with no output directory), oversized bodies are only
   * truncated in memory.
   */
  payloadDir?: string;
  /** Total bytes of spilled payloads to write before giving up. */
  maxSpillBytes?: number;
  onCapture?: (call: CapturedCall) => void;
  /**
   * Receives every original value redaction removes, so the report can be
   * checked against them before it is written. Never logged or persisted.
   */
  onSecret?: SecretRecorder;
}

const DEFAULT_TOTAL_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_FRAMES = 200;
const DEFAULT_MAX_CALLS = 10_000;
const DEFAULT_MAX_WEBSOCKETS = 100;
const DEFAULT_MAX_SPILL_BYTES = 50 * 1024 * 1024;

export class TrafficInterceptor {
  readonly calls: CapturedCall[] = [];
  readonly webSockets: CapturedWebSocket[] = [];
  /** Absolute paths of payloads spilled to disk, for the integrity manifest. */
  readonly payloadFiles: string[] = [];
  /** Calls an axis cap refused to store, so the scan can report the loss. */
  droppedCalls = 0;
  /** WebSocket connections an axis cap refused to store. */
  droppedSockets = 0;
  private readonly pending = new Map<Request, { t0: number; pageUrl: string }>();
  private readonly totalBodyBytes: number;
  private readonly maxWebSocketFrames: number;
  private readonly maxCalls: number;
  private readonly maxWebSockets: number;
  private readonly maxSpillBytes: number;
  private bytesStored = 0;
  private bodiesSuppressed = false;
  private spilledBytes = 0;
  private spillCount = 0;
  private spillSuppressed = false;
  private readonly pendingWrites: Promise<void>[] = [];

  constructor(private readonly options: InterceptorOptions) {
    this.totalBodyBytes = options.totalBodyBytes ?? DEFAULT_TOTAL_BODY_BYTES;
    this.maxWebSocketFrames = options.maxWebSocketFrames ?? DEFAULT_MAX_WEBSOCKET_FRAMES;
    this.maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
    this.maxWebSockets = options.maxWebSockets ?? DEFAULT_MAX_WEBSOCKETS;
    this.maxSpillBytes = options.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES;
  }

  /**
   * Wait for any payloads being spilled to disk, so a report that references
   * them is never written before they exist.
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.length === 0) return;
    await Promise.allSettled(this.pendingWrites);
    this.pendingWrites.length = 0;
  }

  /** Store a captured call, unless the call cap is already reached. */
  private addCall(call: CapturedCall): void {
    if (this.calls.length >= this.maxCalls) {
      this.droppedCalls += 1;
      return;
    }
    this.calls.push(call);
    this.options.onCapture?.(call);
  }

  /**
   * Write an oversized payload to `<payloadDir>` in full, redacted, and return
   * its path relative to the report directory (`payloads/<name>`). Returns null
   * when there is nowhere to write, the cap is set low, or the spill budget is
   * spent — in which case the truncated in-memory sample is all that is kept.
   */
  private spill(payload: string, kind: string, ext: string): string | null {
    const dir = this.options.payloadDir;
    if (!dir || this.spillSuppressed) return null;
    // Estimate with the un-redacted length; redaction only shortens a payload,
    // so this is a safe upper bound on what reaches disk.
    if (this.spilledBytes + payload.length > this.maxSpillBytes) {
      this.spillSuppressed = true;
      return null;
    }
    const text = this.options.redact ? redactBody(payload, undefined, this.options.onSecret) : payload;
    // A body that is nothing but a secret has no safe content to write; leave
    // it out rather than spilling the unredacted original.
    if (text === null) return null;
    this.spilledBytes += payload.length;
    const name = `${kind}-${++this.spillCount}${ext}`;
    const file = join(dir, name);
    this.pendingWrites.push(
      (async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(file, text, 'utf8');
      })(),
    );
    this.payloadFiles.push(file);
    // Report paths with forward slashes, so a report stays portable.
    return posix.join('payloads', name);
  }

  attach(page: Page): void {
    page.on('request', (req) => this.onRequest(req));
    page.on('response', (res) => {
      void this.onResponse(res).catch(() => {});
    });
    page.on('requestfailed', (req) => this.onFailed(req));
    page.on('websocket', (ws) => this.onWebSocket(ws, page));
  }

  /** Number of API calls captured so far. */
  get captured(): number {
    return this.calls.length;
  }

  /**
   * Seed traffic captured before a checkpoint, so `--resume` continues one
   * report instead of starting a second. The stored payloads are counted
   * against the total-size budget too, so a resumed run cannot exceed it.
   */
  restore(state: { calls?: CapturedCall[]; webSockets?: CapturedWebSocket[] }): void {
    for (const call of state.calls ?? []) {
      this.calls.push(call);
      this.bytesStored +=
        (call.requestBodySample?.length ?? 0) + (call.responseBodySample?.length ?? 0);
    }
    for (const connection of state.webSockets ?? []) {
      this.webSockets.push(connection);
      for (const frame of connection.frames) this.bytesStored += frame.payloadSample?.length ?? 0;
    }
  }

  private isApi(req: Request): boolean {
    const type = req.resourceType();
    return type === 'xhr' || type === 'fetch';
  }

  private shouldCapture(url: string): boolean {
    if (this.options.includeThirdParty) return true;
    // --include-host widens what counts as same-site; without it, the seed's
    // host is the whole scope.
    if (this.options.scope) return this.options.scope.allowsHost(url);
    return isSameDomain(url, this.options.seedUrl);
  }

  private onRequest(req: Request): void {
    if (!this.isApi(req)) return;
    this.pending.set(req, { t0: Date.now(), pageUrl: req.frame()?.url() ?? '' });
  }

  private async onResponse(response: Response): Promise<void> {
    const req = response.request();
    if (!this.isApi(req)) return;

    const meta = this.pending.get(req);
    this.pending.delete(req);

    const url = normalizeUrl(response.url() || req.url());
    if (!this.shouldCapture(url)) return;

    const requestHeaders = this.options.redact
      ? redactHeaders(req.headers(), this.options.onSecret)
      : req.headers();
    const responseHeaders = this.options.redact
      ? redactHeaders(response.headers(), this.options.onSecret)
      : response.headers();

    let requestBodySample: string | null = null;
    let requestBodyFile: string | undefined;
    try {
      const raw = req.postData();
      if (raw !== null && raw !== undefined) {
        requestBodySample = this.storeBody(raw);
        if (raw.length > this.options.maxBodyBytes) {
          requestBodyFile = this.spill(raw, 'request-body', '.txt') ?? undefined;
        }
      }
    } catch {
      requestBodySample = null;
    }

    const mimeType = (response.headers()['content-type'] ?? '').split(';')[0]!.trim();
    let responseBodySample: string | null = null;
    let responseBodyFile: string | undefined;
    let truncated = false;
    const contentLength = Number(response.headers()['content-length'] ?? '0');
    const jsonish = mimeType.includes('json');
    // With somewhere to spill, read up to the remaining spill budget so an
    // oversized body can be preserved on disk rather than dropped; otherwise
    // read no further than the in-memory cap, as before.
    const readLimit = this.options.payloadDir
      ? Math.max(this.options.maxBodyBytes, this.maxSpillBytes - this.spilledBytes)
      : this.options.maxBodyBytes;
    if (jsonish && (Number.isNaN(contentLength) || contentLength <= readLimit)) {
      try {
        const text = await response.text();
        if (text.length > this.options.maxBodyBytes) {
          responseBodySample = this.storeBody(text.slice(0, this.options.maxBodyBytes));
          responseBodyFile = this.spill(text, 'response-body', '.json') ?? undefined;
          truncated = true;
        } else {
          responseBodySample = this.storeBody(text);
        }
      } catch {
        // Body may be disposed if the page navigated away; metadata is still kept.
        responseBodySample = null;
      }
    }

    this.addCall({
      method: req.method().toUpperCase(),
      url,
      status: response.status(),
      mimeType,
      resourceType: req.resourceType(),
      requestHeaders,
      requestBodySample,
      responseHeaders,
      responseBodySample,
      responseBodyTruncated: truncated,
      ...(requestBodyFile ? { requestBodyFile } : {}),
      ...(responseBodyFile ? { responseBodyFile } : {}),
      startedAt: meta?.t0 ?? Date.now(),
      durationMs: Date.now() - (meta?.t0 ?? Date.now()),
      triggeredBy: normalizeUrl(meta?.pageUrl ?? '') || (meta?.pageUrl ?? ''),
    });
  }

  private onFailed(req: Request): void {
    if (!this.isApi(req)) return;
    const meta = this.pending.get(req);
    this.pending.delete(req);
    const url = normalizeUrl(req.url());
    if (!this.shouldCapture(url)) return;
    this.addCall({
      method: req.method().toUpperCase(),
      url,
      status: 0,
      mimeType: '',
      resourceType: req.resourceType(),
      requestHeaders: this.options.redact
        ? redactHeaders(req.headers(), this.options.onSecret)
        : req.headers(),
      requestBodySample: null,
      responseHeaders: {},
      responseBodySample: null,
      responseBodyTruncated: false,
      startedAt: meta?.t0 ?? Date.now(),
      durationMs: Date.now() - (meta?.t0 ?? Date.now()),
      triggeredBy: meta?.pageUrl ?? '',
    });
  }

  /**
   * Record a WebSocket connection and subscribe to its frames. Filtering and
   * redaction match the HTTP path, so a socket is only kept when it is
   * same-origin (or `--include-third-party` is on) and its payloads are redacted
   * at capture time — frames often carry the same tokens as request bodies.
   */
  private onWebSocket(ws: WebSocket, page: Page): void {
    const url = normalizeUrl(ws.url());
    if (!this.shouldCapture(url)) return;
    // A page that opens sockets in a loop must not grow the report without
    // bound; keep counting, but stop storing past the cap.
    if (this.webSockets.length >= this.maxWebSockets) {
      this.droppedSockets += 1;
      return;
    }

    const connection: CapturedWebSocket = {
      url,
      origins: [safeOrigin(url)],
      triggeredBy: page.url(),
      openedAt: Date.now(),
      closedAt: null,
      frameCount: 0,
      sentCount: 0,
      receivedCount: 0,
      framesTruncated: false,
      frames: [],
      // Filled in once the scan is done and every frame has arrived.
      sentSchema: null,
      receivedSchema: null,
    };
    this.webSockets.push(connection);

    ws.on('framesent', (frame) => this.onFrame(connection, 'sent', frame.payload));
    ws.on('framereceived', (frame) => this.onFrame(connection, 'received', frame.payload));
    ws.on('close', () => {
      connection.closedAt = Date.now();
    });
  }

  private onFrame(
    connection: CapturedWebSocket,
    direction: WebSocketDirection,
    payload: string | Buffer,
  ): void {
    connection.frameCount += 1;
    if (direction === 'sent') connection.sentCount += 1;
    else connection.receivedCount += 1;

    // Heartbeats and chatty streams should not grow a report without bound;
    // keep counting, but stop storing once the cap is reached.
    if (connection.frames.length >= this.maxWebSocketFrames) {
      connection.framesTruncated = true;
      return;
    }

    const isText = typeof payload === 'string';
    const raw = isText ? payload : payload.toString('base64');
    const stored = this.storePayload(raw);
    connection.frames.push({
      direction,
      type: isText ? 'text' : 'binary',
      payloadSample: stored.value,
      size: isText ? Buffer.byteLength(payload) : payload.length,
      truncated: stored.truncated,
      at: Date.now(),
    });
  }

  /** Truncate + redact a body, respecting the total-size budget. */
  private storeBody(body: string): string | null {
    return this.storePayload(body).value;
  }

  /**
   * Truncate + redact a payload (an HTTP body or a WebSocket frame) against the
   * per-payload cap and the shared total budget. Reports whether it was cut.
   */
  private storePayload(payload: string): { value: string | null; truncated: boolean } {
    if (this.bodiesSuppressed) return { value: null, truncated: false };
    const truncated = payload.length > this.options.maxBodyBytes;
    const capped = truncated ? payload.slice(0, this.options.maxBodyBytes) : payload;
    if (this.bytesStored + capped.length > this.totalBodyBytes) {
      this.bodiesSuppressed = true;
      return { value: null, truncated: false };
    }
    this.bytesStored += capped.length;
    return {
      value: this.options.redact ? redactBody(capped, undefined, this.options.onSecret) : capped,
      truncated,
    };
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
