/**
 * Shared types for api-recon. The JSON report schema is defined here once and
 * every reporter (md/html/pdf/openapi) derives from it.
 */

export type ReportFormat = 'json' | 'md' | 'html' | 'pdf' | 'openapi' | 'dashboard';

export const REPORT_FORMATS: readonly ReportFormat[] = [
  'json',
  'md',
  'html',
  'pdf',
  'openapi',
  'dashboard',
];

/** Playwright engines a scan can run in. Chromium is the default. */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export const BROWSER_ENGINES: readonly BrowserEngine[] = ['chromium', 'firefox', 'webkit'];

export type Category =
  | 'authentication'
  | 'data-fetching'
  | 'mutations'
  | 'analytics'
  | 'third-party'
  | 'graphql'
  | 'uncategorized';

export const CATEGORIES: readonly Category[] = [
  'authentication',
  'data-fetching',
  'mutations',
  'analytics',
  'third-party',
  'graphql',
  'uncategorized',
];

/** A single captured XHR/fetch request/response pair. */
export interface CapturedCall {
  method: string;
  url: string;
  status: number;
  mimeType: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBodySample: string | null;
  responseHeaders: Record<string, string>;
  responseBodySample: string | null;
  responseBodyTruncated: boolean;
  startedAt: number;
  durationMs: number;
  /** The page URL that triggered this call. */
  triggeredBy: string;
}

/** A deduplicated endpoint grouped by (method, urlPattern). */
export interface Endpoint {
  id: string;
  method: string;
  /** Path with id-like segments replaced by `{param}` placeholders. */
  urlPattern: string;
  /** Absolute origin(s) observed for this pattern. */
  origins: string[];
  category: Category;
  count: number;
  statusCodes: number[];
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodySample: string | null;
  responseBodySample: string | null;
  pathParams: string[];
  queryParams: QueryParam[];
  requestBodySchema: JsonSchemaLike | null;
  responseSchema: JsonSchemaLike | null;
  /** MIME types observed across samples. */
  mimeTypes: string[];
  triggeredBy: string[];
  /** GraphQL detection; omitted when this endpoint is not GraphQL. */
  graphql?: GraphQLInfo;
}

export interface QueryParam {
  name: string;
  sampleValues: string[];
}

/** The kind of a GraphQL operation definition. */
export type GraphQLOperationType = 'query' | 'mutation' | 'subscription' | 'unknown';

/** One operation observed on a GraphQL endpoint. */
export interface GraphQLOperation {
  /** The operation's name, or `null` for an anonymous operation. */
  name: string | null;
  type: GraphQLOperationType;
}

/**
 * GraphQL detection for an endpoint. Present only on endpoints whose captured
 * traffic carried a GraphQL request, so its absence means "not GraphQL".
 */
export interface GraphQLInfo {
  /** True when a schema introspection query (`__schema` / `__type`) was seen. */
  introspection: boolean;
  /** Operation definitions observed across the endpoint's samples. */
  operations: GraphQLOperation[];
}

/** Minimal JSON-Schema-like object produced by the inference engine. */
export interface JsonSchemaLike {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  required?: string[];
  example?: unknown;
}

/** Direction of a WebSocket frame relative to the page. */
export type WebSocketDirection = 'sent' | 'received';

export interface WebSocketFrame {
  direction: WebSocketDirection;
  /** Text frames keep their text; binary frames are stored base64-encoded. */
  type: 'text' | 'binary';
  /** Redacted, size-capped payload; `null` when the capture budget was exhausted. */
  payloadSample: string | null;
  /** Payload size in bytes, as observed. */
  size: number;
  truncated: boolean;
  /** When the frame was seen (epoch ms). */
  at: number;
}

/** One captured WebSocket connection and the frames exchanged on it. */
export interface CapturedWebSocket {
  url: string;
  origins: string[];
  /** The page URL that opened the socket. */
  triggeredBy: string;
  openedAt: number;
  closedAt: number | null;
  /** Total frames observed, including any past the per-connection storage cap. */
  frameCount: number;
  sentCount: number;
  receivedCount: number;
  /** True when frames past the storage cap were observed but not stored. */
  framesTruncated: boolean;
  frames: WebSocketFrame[];
}

export interface CapturedPage {
  url: string;
  /** Normalized route (fragment stripped, query sorted) used for dedup. */
  normalizedUrl: string;
  depth: number;
  title: string | null;
  visitedAt: number;
}

export interface Technology {
  name: string;
  category: string;
  /** Evidence that triggered the match, e.g. a header or script path. */
  evidence: string;
}

export interface SafetyInfo {
  robotsRespected: boolean;
  robotsSkippedPaths: string[];
  rateLimitMs: number;
  maxBodyBytes: number;
  allowLocal: boolean;
  redact: boolean;
}

export interface ReportMeta {
  seedUrl: string;
  startedAt: string;
  durationMs: number;
  pagesVisited: number;
  apiReconVersion: string;
  /**
   * Playwright engine the scan ran in. Sites sometimes serve different
   * responses per engine, so recording it keeps a scan reproducible from its
   * own report — re-run with `--browser <engine>`.
   */
  engine: BrowserEngine;
}

/** How an endpoint differs between two scans. */
export type ChangeKind = 'added' | 'removed' | 'changed';

/** One endpoint-level difference between a baseline scan and the current one. */
export interface EndpointChange {
  /** The endpoint's stable id, e.g. `GET /api/orders/{id}`. */
  id: string;
  kind: ChangeKind;
  /**
   * True when the change can break an existing client. Heuristic, and biased
   * toward under-reporting: removals and narrowed types are breaking, additions
   * are not.
   */
  breaking: boolean;
  /** Human-readable descriptions of what differs. */
  details: string[];
}

/** Identifies the scan a diff was computed against. */
export interface ScanRef {
  seedUrl: string;
  startedAt: string;
  apiReconVersion: string;
  /**
   * Engine the scan ran in. Absent on reports written before the engine was
   * recorded; a difference between the two scans is worth flagging, since a
   * site may serve different responses per engine.
   */
  engine?: BrowserEngine;
}

/** Endpoint-level comparison of a scan against an earlier baseline report. */
export interface ReportDiff {
  baseline: ScanRef;
  current: ScanRef;
  changes: EndpointChange[];
  counts: { added: number; removed: number; changed: number; breaking: number };
  hasChanges: boolean;
}

/** The single source-of-truth report. All other formats derive from it. */
export interface ReconReport {
  meta: ReportMeta;
  technologies: Technology[];
  endpoints: Endpoint[];
  pages: CapturedPage[];
  /** WebSocket connections observed during the scan, with their frames. */
  webSockets: CapturedWebSocket[];
  safety: SafetyInfo;
  /** Present only when the scan was run with a baseline to compare against. */
  diff?: ReportDiff;
}

import type { Logger } from './utils/logger.js';

/** Options accepted by `scan()` (library) and the CLI. */
export interface ScanOptions {
  url: string;
  depth?: number;
  maxPages?: number;
  out?: string;
  formats?: ReportFormat[];
  auth?: string;
  login?: string;
  record?: boolean;
  actions?: string;
  rate?: number;
  /** Playwright engine to drive. Defaults to `chromium`. */
  browser?: BrowserEngine;
  /**
   * Path to a previous `report.json` to compare this scan against. The result
   * gains a `diff` field; the scan itself is unaffected.
   */
  diff?: string;
  respectRobots?: boolean;
  force?: boolean;
  includeThirdParty?: boolean;
  redact?: boolean;
  maxBodyBytes?: number;
  allowLocal?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /** Injectable logger (used by the CLI for progress output and tests). */
  logger?: Logger;
}

/** Result of a completed scan. */
export interface ScanResult {
  report: ReconReport;
  /** Writes every enabled report format into the given directory. */
  writeReports: (outDir: string) => Promise<string[]>;
  /** Paths of report files already written (when formats were emitted during scan). */
  files: string[];
  /** Convenience alias for `report.diff`, when a baseline was supplied. */
  diff?: ReportDiff;
}
