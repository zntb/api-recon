/**
 * Shared types for api-recon. The JSON report schema is defined here once and
 * every reporter (md/html/pdf/openapi) derives from it.
 */

export type ReportFormat = 'json' | 'md' | 'html' | 'pdf' | 'openapi';

export const REPORT_FORMATS: readonly ReportFormat[] = ['json', 'md', 'html', 'pdf', 'openapi'];

export type Category =
  | 'authentication'
  | 'data-fetching'
  | 'mutations'
  | 'analytics'
  | 'third-party'
  | 'uncategorized';

export const CATEGORIES: readonly Category[] = [
  'authentication',
  'data-fetching',
  'mutations',
  'analytics',
  'third-party',
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
}

export interface QueryParam {
  name: string;
  sampleValues: string[];
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
}

/** The single source-of-truth report. All other formats derive from it. */
export interface ReconReport {
  meta: ReportMeta;
  technologies: Technology[];
  endpoints: Endpoint[];
  pages: CapturedPage[];
  safety: SafetyInfo;
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
}
