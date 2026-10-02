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
  onCapture?: (call: CapturedCall) => void;
  /**
   * Receives every original value redaction removes, so the report can be
   * checked against them before it is written. Never logged or persisted.
   */
  onSecret?: SecretRecorder;
}

const DEFAULT_TOTAL_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_FRAMES = 200;

export class TrafficInterceptor {
  readonly calls: CapturedCall[] = [];
  readonly webSockets: CapturedWebSocket[] = [];
  private readonly pending = new Map<Request, { t0: number; pageUrl: string }>();
  private readonly totalBodyBytes: number;
  private readonly maxWebSocketFrames: number;
  private bytesStored = 0;
  private bodiesSuppressed = false;

  constructor(private readonly options: InterceptorOptions) {
    this.totalBodyBytes = options.totalBodyBytes ?? DEFAULT_TOTAL_BODY_BYTES;
    this.maxWebSocketFrames = options.maxWebSocketFrames ?? DEFAULT_MAX_WEBSOCKET_FRAMES;
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
    try {
      const raw = req.postData();
      if (raw !== null && raw !== undefined) requestBodySample = this.storeBody(raw);
    } catch {
      requestBodySample = null;
    }

    const mimeType = (response.headers()['content-type'] ?? '').split(';')[0]!.trim();
    let responseBodySample: string | null = null;
    let truncated = false;
    const contentLength = Number(response.headers()['content-length'] ?? '0');
    const jsonish = mimeType.includes('json');
    if (jsonish && (Number.isNaN(contentLength) || contentLength <= this.options.maxBodyBytes)) {
      try {
        const text = await response.text();
        if (text.length > this.options.maxBodyBytes) {
          responseBodySample = this.storeBody(text.slice(0, this.options.maxBodyBytes));
          truncated = true;
        } else {
          responseBodySample = this.storeBody(text);
        }
      } catch {
        // Body may be disposed if the page navigated away; metadata is still kept.
        responseBodySample = null;
      }
    }

    const call: CapturedCall = {
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
      startedAt: meta?.t0 ?? Date.now(),
      durationMs: Date.now() - (meta?.t0 ?? Date.now()),
      triggeredBy: normalizeUrl(meta?.pageUrl ?? '') || (meta?.pageUrl ?? ''),
    };
    this.calls.push(call);
    this.options.onCapture?.(call);
  }

  private onFailed(req: Request): void {
    if (!this.isApi(req)) return;
    const meta = this.pending.get(req);
    this.pending.delete(req);
    const url = normalizeUrl(req.url());
    if (!this.shouldCapture(url)) return;
    this.calls.push({
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
