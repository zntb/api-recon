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

/**
 * The rule that decided an endpoint's category. Kept alongside the category so
 * diagnostics — and the opt-in telemetry file — can explain a decision without
 * carrying the URL that triggered it.
 */
export type CategorizationHeuristic =
  | 'auth-path'
  | 'analytics-host'
  | 'analytics-path'
  | 'third-party'
  | 'graphql'
  | 'mutation-method'
  | 'json-response'
  | 'fallback'
  | 'invalid-url';

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

/**
 * The third-party or analytics vendor an endpoint belongs to, recognized from
 * its host and joined to the same names used by technology fingerprinting.
 */
export interface VendorAttribution {
  /** Vendor name, e.g. `Stripe` or `Segment`. */
  name: string;
  /** The vendor's discipline, e.g. `payments`, `analytics`, `monitoring`. */
  category: string;
  /**
   * The top-level keys observed being sent to the vendor: the request body's
   * JSON field names plus the query parameter names, sorted and deduplicated.
   */
  payloadKeys: string[];
}

/**
 * A p50/p95/max summary of a set of numeric observations — response time in
 * milliseconds, or a payload size in bytes. Percentiles use the nearest-rank
 * method, so every value is one that was actually observed rather than an
 * interpolation between two of them.
 */
export interface PercentileStats {
  /** Median observation. */
  p50: number;
  /** 95th-percentile observation. */
  p95: number;
  /** Largest observation. */
  max: number;
}

/**
 * Cache-relevant response headers observed for an endpoint. Only the headers
 * that were present are set, so an absent field means the endpoint did not
 * advertise it — not that caching was disabled.
 */
export interface CacheInfo {
  /** `cache-control`, e.g. `public, max-age=60`. */
  control?: string;
  /** Entity validator, e.g. `W/"abc123"`. */
  etag?: string;
  /** `last-modified` as observed. */
  lastModified?: string;
  /** `age` in seconds, when numeric. */
  age?: number;
  /** `vary`, which affects cache correctness. */
  vary?: string;
  /** Edge cache status, from `x-cache` or `cf-cache-status`. */
  status?: string;
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
  /**
   * Present only when the request schema is absent or was observed from an
   * incomplete body, explaining the gap. Omitted when the schema is complete.
   */
  requestBodySchemaReason?: SchemaGapReason;
  responseSchema: JsonSchemaLike | null;
  /**
   * Present only when the response schema is absent or was observed from an
   * incomplete body, explaining the gap. Omitted when the schema is complete.
   */
  responseSchemaReason?: SchemaGapReason;
  /**
   * One entry per error status (4xx/5xx) observed, so the failure contract is
   * documented rather than folded into the success shape. Omitted entirely when
   * every sample succeeded.
   */
  errorResponses?: ErrorResponse[];
  /** MIME types observed across samples. */
  mimeTypes: string[];
  triggeredBy: string[];
  /**
   * Response-time summary over every captured sample, in milliseconds. Present
   * on every observed endpoint, so the report doubles as a performance view.
   */
  timing?: PercentileStats;
  /**
   * Request-body size summary in bytes, over the samples that carried one.
   * Omitted when no request body was captured.
   */
  requestBytes?: PercentileStats;
  /**
   * Response-body size summary in bytes, over the samples that carried one.
   * Omitted when no response body was captured.
   */
  responseBytes?: PercentileStats;
  /** Cache-relevant response headers, when any were present. */
  cache?: CacheInfo;
  /** GraphQL detection; omitted when this endpoint is not GraphQL. */
  graphql?: GraphQLInfo;
  /**
   * The recognized third-party/analytics vendor, when the endpoint's host
   * matches one. Omitted for first-party traffic and unknown hosts, so a host
   * that is not a known vendor stays a hostname rather than a guess.
   */
  vendor?: VendorAttribution;
}

export interface QueryParam {
  name: string;
  sampleValues: string[];
}

/** The response contract observed for one error status (4xx or 5xx). */
export interface ErrorResponse {
  /** The HTTP status this contract belongs to. */
  status: number;
  /** How many samples returned this status. */
  count: number;
  /** A redacted, size-capped body sample; `null` when the response had no body. */
  bodySample: string | null;
  /** Inferred shape of the bodies seen with this status, merged across them. */
  schema: JsonSchemaLike | null;
  /** Present when this status's schema is absent or only partly observed. */
  schemaReason?: SchemaGapReason;
  /** MIME types observed with this status. */
  mimeTypes: string[];
}

/**
 * The verbs observed for one path of a resource, and the conventional ones the
 * path did not exhibit.
 */
export interface ResourceEndpoint {
  /** The path as observed, e.g. `/api/orders/{id}`. */
  path: string;
  /** Uppercase HTTP verbs observed for this path, sorted. */
  methods: string[];
  /**
   * REST-conventional verbs this path did not exhibit: a collection is expected
   * to support `GET` and `POST`, an item path `GET`, `PUT`, `PATCH`, and
   * `DELETE`. Empty for a resource that does not look like CRUD (see
   * `Resource`).
   */
  missingMethods: string[];
}

/**
 * A collection root (`/api/orders`) and every path observed beneath it
 * (`/api/orders/{id}`, `/api/orders/{id}/items`), so the flat endpoint list
 * reads as a coverage view. `missingMethods` is only filled in for resources
 * that expose an item path, since only those are expected to be CRUD — a
 * one-off action endpoint is not asked for a verb it was never meant to have.
 */
export interface Resource {
  /** The collection root, e.g. `/api/orders`. */
  path: string;
  /** Categories seen among the resource's endpoints, sorted. */
  categories: Category[];
  /** The resource's paths, ordered from the root outward. */
  paths: ResourceEndpoint[];
}

/** The kind of a GraphQL operation definition. */
export type GraphQLOperationType = 'query' | 'mutation' | 'subscription' | 'unknown';

/** One operation observed on a GraphQL endpoint. */
export interface GraphQLOperation {
  /** The operation's name, or `null` for an anonymous operation. */
  name: string | null;
  type: GraphQLOperationType;
  /**
   * The fields selected at the operation's top level — what a client reads
   * from the response. Present only when a query document was captured, and
   * omitted when the operation had no top-level fields (a persisted-query
   * call carries only the operation name).
   */
  selections?: string[];
  /** The argument names passed to those top-level fields; omitted when none. */
  arguments?: string[];
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

/**
 * Why a body (or frame) yielded no schema, or only a partial one:
 *
 * - `no-body`   no payload was captured at all (a `204`, a `GET`, a navigated-away body)
 * - `not-json`  a payload was captured but was not a JSON object or array
 * - `truncated` the payload was cut off at the capture size cap, so its shape is partial
 * - `binary`    the payload is not text (an image, download, or binary socket frame)
 *
 * Recorded beside a `null` (or possibly incomplete) schema so a reader can tell
 * a contract from a gap in the capture.
 */
export type SchemaGapReason = 'no-body' | 'not-json' | 'truncated' | 'binary';

/** Minimal JSON-Schema-like object produced by the inference engine. */
export interface JsonSchemaLike {
  type?: string;
  /**
   * A value-format hint (`uuid`, `email`, `uri`, `date-time`, `date`, `time`,
   * `duration`, `currency`) that a reporter maps to OpenAPI's `format`.
   */
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  required?: string[];
  /**
   * The distinct values seen for a string field when they form a small closed
   * set. Absent for prose, for identifiers that only repeat by coincidence, and
   * for fields whose values carried a format hint of their own.
   */
  enum?: (string | number | boolean)[];
  /** Smallest number observed for a numeric field, when a range was seen. */
  minimum?: number;
  /** Largest number observed for a numeric field, when a range was seen. */
  maximum?: number;
  /**
   * Present when samples disagreed on the type, so the value is one of these
   * shapes; `type` is then absent. A single `type` is used when they agree.
   */
  oneOf?: JsonSchemaLike[];
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
  /** Inferred shape of the JSON frames the page sent; null when none were JSON. */
  sentSchema: JsonSchemaLike | null;
  /** Present when the sent-message schema is absent or only partly observed. */
  sentSchemaReason?: SchemaGapReason;
  /** Inferred shape of the JSON frames the page received. */
  receivedSchema: JsonSchemaLike | null;
  /** Present when the received-message schema is absent or only partly observed. */
  receivedSchemaReason?: SchemaGapReason;
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

/** The rule that produced a finding. */
export type FindingKind =
  | 'unauthenticated'
  | 'pii'
  | 'missing-security-header'
  | 'verbose-error'
  | 'inconsistent-shape';

/** How much attention a finding deserves, from `high` to `info`. */
export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

/**
 * A review cue derived from a scan — something a reader should act on. Findings
 * are heuristics over the captured traffic, not a security audit: each says
 * "look here", not "this is exploitable".
 */
export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** What to act on, in one line. */
  title: string;
  /** Endpoint ids the finding concerns; empty for a site-wide finding. */
  endpoints: string[];
  /** Supporting evidence, one line each. */
  details: string[];
}

/**
 * Version of the `report.json` shape, published as `schema/report.schema.json`
 * and stamped into every report. Bumped when a field is renamed or its meaning
 * changes, so a consumer — and `loadBaseline` — can reject a report it cannot
 * read. Independent of the tool version in `meta.apiReconVersion`.
 */
export const REPORT_SCHEMA_VERSION = 1;

/** The single source-of-truth report. All other formats derive from it. */
export interface ReconReport {
  /** The `report.json` shape version this document conforms to. */
  schemaVersion: number;
  meta: ReportMeta;
  technologies: Technology[];
  endpoints: Endpoint[];
  /**
   * The endpoints clustered into resources with their observed and missing
   * verbs, for a coverage view. Absent on reports written before it was added.
   */
  resources?: Resource[];
  pages: CapturedPage[];
  /** WebSocket connections observed during the scan, with their frames. */
  webSockets: CapturedWebSocket[];
  safety: SafetyInfo;
  /** Present only when the scan was run with a baseline to compare against. */
  diff?: ReportDiff;
  /**
   * Review cues derived from the scan, so a capture ends with what to act on.
   * Always present on a report this build writes; absent on older reports.
   */
  findings?: Finding[];
}

/** One anonymized categorization decision in a telemetry payload. */
export interface TelemetrySignal {
  category: Category;
  /** The heuristic that produced the category. */
  heuristic: CategorizationHeuristic;
  /** HTTP method, as observed. */
  method: string;
  /** Whether the representative response was JSON. */
  json: boolean;
}

/**
 * An opt-in, local-only diagnostics payload: categorization decisions with no
 * host, path, query value, header, or body. Never sent over the network — it is
 * written to `telemetry.json` for a human to review and forward.
 */
export interface TelemetryPayload {
  version: 1;
  apiReconVersion: string;
  generatedAt: string;
  endpointCount: number;
  /** A plain-language reminder of the privacy boundary, shipped with the data. */
  contains: string;
  signals: TelemetrySignal[];
}

import type { Logger } from './utils/logger.js';

/** Options accepted by `scan()` (library) and the CLI. */
/**
 * What a running scan hands to a progress reporter.
 *
 * The scan pushes a state on each phase change and each page visited, and the
 * reporter decides how to draw it — a live table on a terminal, JSON lines for
 * a machine, or nothing at all. The scan never knows which.
 */
export interface ScanProgressState {
  phase: 'crawling' | 'recording' | 'analyzing';
  seedUrl: string;
  /** Pages recorded so far. */
  pages: CapturedPage[];
  maxPages: number;
  /** Every captured call so far — the endpoints are grouped only after the run. */
  calls: readonly CapturedCall[];
  /** When the scan began, so the reporter can show a live elapsed time. */
  startedAt: number;
}

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
  /**
   * Write an anonymized `telemetry.json` next to the reports. Off by default;
   * no host, path, or body data is included and nothing is sent over the
   * network.
   */
  telemetry?: boolean;
  /**
   * Build the anonymized payload and expose it as `ScanResult.telemetry`, but
   * never write `telemetry.json`. Off by default; use it to inspect exactly
   * what telemetry would contain before opting in. Combine with `telemetry` to
   * also write the file.
   */
  telemetryPreview?: boolean;
  /** Injectable logger (used by the CLI for progress output and tests). */
  logger?: Logger;
  /**
   * Called with the scan's state as it changes: once per phase, and once per
   * page visited. Purely observational — throwing here does not stop the scan.
   */
  onProgress?: (state: ScanProgressState) => void;
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
  /** The anonymized payload, present when telemetry was enabled or previewed. */
  telemetry?: TelemetryPayload;
}
