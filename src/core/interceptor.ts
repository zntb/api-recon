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

import type { Page, Request, Response } from 'playwright';
import type { CapturedCall } from '../types.js';
import { redactBody, redactHeaders } from '../utils/redact.js';
import { isSameDomain, normalizeUrl } from '../utils/url.js';

export interface InterceptorOptions {
  redact: boolean;
  /** Per-body cap in bytes. */
  maxBodyBytes: number;
  /** Total bytes of bodies to keep across the whole scan. */
  totalBodyBytes?: number;
  includeThirdParty: boolean;
  seedUrl: string;
  onCapture?: (call: CapturedCall) => void;
}

const DEFAULT_TOTAL_BODY_BYTES = 25 * 1024 * 1024;

export class TrafficInterceptor {
  readonly calls: CapturedCall[] = [];
  private readonly pending = new Map<Request, { t0: number; pageUrl: string }>();
  private readonly totalBodyBytes: number;
  private bytesStored = 0;
  private bodiesSuppressed = false;

  constructor(private readonly options: InterceptorOptions) {
    this.totalBodyBytes = options.totalBodyBytes ?? DEFAULT_TOTAL_BODY_BYTES;
  }

  attach(page: Page): void {
    page.on('request', (req) => this.onRequest(req));
    page.on('response', (res) => {
      void this.onResponse(res).catch(() => {});
    });
    page.on('requestfailed', (req) => this.onFailed(req));
  }

  /** Number of API calls captured so far. */
  get captured(): number {
    return this.calls.length;
  }

  private isApi(req: Request): boolean {
    const type = req.resourceType();
    return type === 'xhr' || type === 'fetch';
  }

  private shouldCapture(url: string): boolean {
    if (this.options.includeThirdParty) return true;
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

    const requestHeaders = this.options.redact ? redactHeaders(req.headers()) : req.headers();
    const responseHeaders = this.options.redact ? redactHeaders(response.headers()) : response.headers();

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
      requestHeaders: this.options.redact ? redactHeaders(req.headers()) : req.headers(),
      requestBodySample: null,
      responseHeaders: {},
      responseBodySample: null,
      responseBodyTruncated: false,
      startedAt: meta?.t0 ?? Date.now(),
      durationMs: Date.now() - (meta?.t0 ?? Date.now()),
      triggeredBy: meta?.pageUrl ?? '',
    });
  }

  /** Truncate + redact a body, respecting the total-size budget. */
  private storeBody(body: string): string | null {
    if (this.bodiesSuppressed) return null;
    if (this.bytesStored + body.length > this.totalBodyBytes) {
      this.bodiesSuppressed = true;
      return null;
    }
    this.bytesStored += body.length;
    const capped = body.length > this.options.maxBodyBytes ? body.slice(0, this.options.maxBodyBytes) : body;
    return this.options.redact ? redactBody(capped) : capped;
  }
}
