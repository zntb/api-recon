/**
 * Turn raw captured calls into deduplicated, categorized endpoints.
 *
 * Category precedence (first match wins):
 *   authentication -> analytics -> third-party -> graphql -> mutations
 *   -> data-fetching -> uncategorized
 */

import type {
  CacheInfo,
  CapturedCall,
  CapturedWebSocket,
  CategorizationHeuristic,
  Category,
  Endpoint,
  ErrorResponse,
  JsonSchemaLike,
  PercentileStats,
  QueryParam,
  SchemaGapReason,
  VendorAttribution,
} from '../types.js';
import { analyzeGraphQL, mergeGraphQL } from './graphql.js';
import { summarize } from './performance.js';
import { attributeVendor, isTrackingHost, trackingVendorDomains } from './vendors.js';
import {
  absentBodyReason,
  framesGapReason,
  inferSchemaFromBodies,
  inferSchemaFromFrames,
  stringBodyGapReason,
  worstGapReason,
} from './schemaInference.js';
import { isSameDomain, toUrlPattern } from '../utils/url.js';
import { isSensitiveParamName, REDACTED, type SecretRecorder } from '../utils/redact.js';

/**
 * Host suffixes of the tracking vendors in the shared catalog, so the list of
 * hosts that categorize as `analytics` stays in step with the vendor names
 * attributed to their traffic.
 */
export const ANALYTICS_HOSTS: string[] = trackingVendorDomains();

const AUTH_PATH_RE =
  /(^|\/)(login|logout|signin|signout|sign-in|sign-out|auth|authorize|oauth|token|tokens|session|register|signup|sign-up|sso|password|mfa|otp)(\/|$)/;

const ANALYTICS_PATH_RE =
  /(\/track|\/collect|\/beacon|\/telemetry|\/analytics|\/event|\/events|\/pixel|\/pageview|\/impression)/;

export function analyzeCalls(
  calls: CapturedCall[],
  opts: { seedUrl: string; redact?: boolean; onSecret?: SecretRecorder },
): Endpoint[] {
  const redact = opts.redact ?? true;
  const groups = new Map<string, CapturedCall[]>();
  for (const call of calls) {
    const pattern = toUrlPattern(call.url);
    const key = `${call.method} ${pattern}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(call);
    else groups.set(key, [call]);
  }

  const endpoints: Endpoint[] = [];
  for (const [id, samples] of groups) {
    endpoints.push(buildEndpoint(id, samples, opts.seedUrl, redact, opts.onSecret));
  }
  endpoints.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  return endpoints;
}

/**
 * Attach an inferred message schema to each WebSocket connection, once its
 * frames are all in, so a socket is described the same way an HTTP endpoint is
 * (sent ≈ request body, received ≈ response body).
 */
export function analyzeWebSockets(webSockets: CapturedWebSocket[]): CapturedWebSocket[] {
  return webSockets.map((socket) => {
    const sentSchema = inferSchemaFromFrames(socket.frames, 'sent');
    const receivedSchema = inferSchemaFromFrames(socket.frames, 'received');
    const sentReason = framesGapReason(socket.frames, 'sent', socket.framesTruncated, sentSchema);
    const receivedReason = framesGapReason(
      socket.frames,
      'received',
      socket.framesTruncated,
      receivedSchema,
    );
    return {
      ...socket,
      sentSchema,
      receivedSchema,
      ...(sentReason ? { sentSchemaReason: sentReason } : {}),
      ...(receivedReason ? { receivedSchemaReason: receivedReason } : {}),
    };
  });
}

function buildEndpoint(
  id: string,
  samples: CapturedCall[],
  seedUrl: string,
  redact: boolean,
  onSecret?: SecretRecorder,
): Endpoint {
  const first = samples[0]!;
  const representative = samples[samples.length - 1]!;
  const pattern = id.slice(id.indexOf(' ') + 1);
  const graphql = mergeGraphQL(samples.map((s) => analyzeGraphQL(s)));
  const errors = collectErrorResponses(samples);
  const responseSamples = responseSampleSet(samples);
  const requestReason = worstGapReason(samples.map(requestGapReason));
  const responseReason = worstGapReason(responseSamples.map(responseGapReason));
  const origins = unique(samples.map((s) => safeOrigin(s.url)));
  const category = categorize(first, seedUrl, graphql !== null);
  const queryParams = collectQueryParams(samples, redact, onSecret);
  const requestSchema = inferSchemaFromBodies(samples.map((s) => s.requestBodySample));
  const vendor = vendorFor(category, origins, requestSchema, queryParams);
  const timing = summarize(samples.map((s) => s.durationMs));
  const requestBytes = sizeStats(samples.map((s) => s.requestBodySample));
  const responseBytes = sizeStats(samples.map((s) => s.responseBodySample));
  const cache = firstCache(samples);
  const requestBodyFile = firstNonNull(samples.map((s) => s.requestBodyFile));
  const responseBodyFile = firstNonNull(samples.map((s) => s.responseBodyFile));

  return {
    id,
    method: first.method,
    urlPattern: pattern,
    origins,
    category,
    count: samples.length,
    statusCodes: unique(samples.map((s) => s.status)).sort((a, b) => a - b),
    requestHeaders: representative.requestHeaders,
    responseHeaders: representative.responseHeaders,
    requestBodySample: firstNonNull(samples.map((s) => s.requestBodySample)),
    responseBodySample: firstNonNull(samples.map((s) => s.responseBodySample)),
    ...(requestBodyFile ? { requestBodyFile } : {}),
    ...(responseBodyFile ? { responseBodyFile } : {}),
    pathParams: uniquePathParams(pattern),
    queryParams,
    requestBodySchema: requestSchema,
    ...(requestReason ? { requestBodySchemaReason: requestReason } : {}),
    responseSchema: inferSchemaFromBodies(responseSamples.map((s) => s.responseBodySample)),
    ...(responseReason ? { responseSchemaReason: responseReason } : {}),
    ...(errors.length ? { errorResponses: errors } : {}),
    mimeTypes: unique(samples.map((s) => s.mimeType).filter(Boolean)),
    triggeredBy: unique(samples.map((s) => s.triggeredBy)),
    timing,
    ...(requestBytes ? { requestBytes } : {}),
    ...(responseBytes ? { responseBytes } : {}),
    ...(cache ? { cache } : {}),
    ...(graphql ? { graphql } : {}),
    ...(vendor ? { vendor } : {}),
  };
}

/**
 * p50/p95/max body size in bytes, or null when no sample carried a body. A
 * captured body may be capped, so a size can be a lower bound — the report says
 * as much rather than implying every body fits the cap.
 */
function sizeStats(samples: (string | null)[]): PercentileStats | null {
  const sizes = samples
    .filter((sample): sample is string => sample !== null)
    .map((sample) => Buffer.byteLength(sample, 'utf8'));
  return sizes.length > 0 ? summarize(sizes) : null;
}

/** The first sample whose response headers say anything about caching. */
function firstCache(samples: CapturedCall[]): CacheInfo | null {
  for (const sample of samples) {
    const cache = cacheFromHeaders(sample.responseHeaders);
    if (cache) return cache;
  }
  return null;
}

function cacheFromHeaders(headers: Record<string, string>): CacheInfo | null {
  const control = headerValue(headers, 'cache-control');
  const etag = headerValue(headers, 'etag');
  const lastModified = headerValue(headers, 'last-modified');
  const vary = headerValue(headers, 'vary');
  const status = headerValue(headers, 'x-cache') ?? headerValue(headers, 'cf-cache-status');
  const ageText = headerValue(headers, 'age');
  const age = ageText !== undefined && Number.isFinite(Number(ageText)) ? Number(ageText) : undefined;

  if (
    control === undefined &&
    etag === undefined &&
    lastModified === undefined &&
    vary === undefined &&
    status === undefined &&
    age === undefined
  ) {
    return null;
  }
  return {
    ...(control !== undefined ? { control } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...(age !== undefined ? { age } : {}),
    ...(vary !== undefined ? { vary } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** Case-insensitive header lookup, since capture casing is not guaranteed. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * Attribute an endpoint to a vendor, but only for the categories whose traffic
 * is third-party or analytics — a first-party endpoint that happens to sit on a
 * vendor's host is not an integration worth naming.
 */
function vendorFor(
  category: Category,
  origins: string[],
  requestSchema: JsonSchemaLike | null,
  queryParams: QueryParam[],
): VendorAttribution | null {
  if (category !== 'analytics' && category !== 'third-party') return null;
  return attributeVendor(origins, vendorPayloadKeys(requestSchema, queryParams));
}

/**
 * The keys a vendor receives: the request body's top-level JSON field names
 * plus the query parameter names. An empty list means the payload keys were
 * not observed (no body, or a non-JSON body), not that none were sent.
 */
function vendorPayloadKeys(schema: JsonSchemaLike | null, queryParams: QueryParam[]): string[] {
  const keys = new Set<string>(Object.keys(schema?.properties ?? {}));
  for (const param of queryParams) keys.add(param.name);
  return [...keys].sort();
}

export interface Categorization {
  category: Category;
  heuristic: CategorizationHeuristic;
}

export function categorize(call: CapturedCall, seedUrl: string, isGraphQL = false): Category {
  return categorizeWithReason(call, seedUrl, isGraphQL).category;
}

/** Like `categorize`, but also reports which heuristic matched. */
export function categorizeWithReason(
  call: CapturedCall,
  seedUrl: string,
  isGraphQL = false,
): Categorization {
  let parsed: URL;
  try {
    parsed = new URL(call.url);
  } catch {
    return { category: 'uncategorized', heuristic: 'invalid-url' };
  }
  const path = parsed.pathname.toLowerCase();
  const host = parsed.host.toLowerCase();

  if (AUTH_PATH_RE.test(path)) return { category: 'authentication', heuristic: 'auth-path' };
  if (isTrackingHost(host)) {
    return { category: 'analytics', heuristic: 'analytics-host' };
  }
  if (ANALYTICS_PATH_RE.test(path)) return { category: 'analytics', heuristic: 'analytics-path' };
  if (!isSameDomain(call.url, seedUrl)) return { category: 'third-party', heuristic: 'third-party' };
  // A GraphQL endpoint is recognized by its request, not its path, so it wins
  // over the method-based buckets below.
  if (isGraphQL) return { category: 'graphql', heuristic: 'graphql' };
  if (call.method !== 'GET' && call.method !== 'HEAD' && call.method !== 'OPTIONS') {
    return { category: 'mutations', heuristic: 'mutation-method' };
  }
  if ((call.mimeType ?? '').toLowerCase().includes('json')) {
    return { category: 'data-fetching', heuristic: 'json-response' };
  }
  return { category: 'uncategorized', heuristic: 'fallback' };
}

function collectQueryParams(
  samples: CapturedCall[],
  redact: boolean,
  onSecret?: SecretRecorder,
): QueryParam[] {
  const byName = new Map<string, Set<string>>();
  for (const s of samples) {
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      continue;
    }
    for (const [k, v] of u.searchParams) {
      if (!byName.has(k)) byName.set(k, new Set());
      if (v) byName.get(k)!.add(v);
    }
  }
  return [...byName.entries()].map(([name, values]) => {
    // A sensitive name keeps its presence and the fact that it carried a value,
    // but not the value itself; an ordinary name keeps its samples. The masked
    // originals are reported so the report can be checked for them afterward.
    if (redact && isSensitiveParamName(name)) {
      if (onSecret) for (const value of values) onSecret(value);
      return { name, sampleValues: values.size > 0 ? [REDACTED] : [] };
    }
    return { name, sampleValues: [...values].slice(0, 5) };
  });
}

function uniquePathParams(pattern: string): string[] {
  return unique([...pattern.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The samples the response schema is inferred from: every successful response
 * when there is one, so an error page cannot masquerade as the contract, and
 * every response otherwise.
 */
function responseSampleSet(samples: CapturedCall[]): CapturedCall[] {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  return ok.some((s) => s.responseBodySample !== null) ? ok : samples;
}

/** Why one response body observation yielded no schema, or only a partial one. */
function responseGapReason(sample: CapturedCall): SchemaGapReason | null {
  return sample.responseBodySample !== null
    ? stringBodyGapReason(sample.responseBodySample, sample.responseBodyTruncated)
    : absentBodyReason(sample.mimeType);
}

/** Why one request body observation yielded no schema. */
function requestGapReason(sample: CapturedCall): SchemaGapReason | null {
  return sample.requestBodySample !== null
    ? stringBodyGapReason(sample.requestBodySample)
    : 'no-body';
}

/**
 * Group the failed samples by status so each error the endpoint can return is
 * described by its own body and shape, rather than borrowing the success schema.
 */
function collectErrorResponses(samples: CapturedCall[]): ErrorResponse[] {
  const byStatus = new Map<number, CapturedCall[]>();
  for (const sample of samples) {
    if (sample.status < 400) continue;
    const bucket = byStatus.get(sample.status);
    if (bucket) bucket.push(sample);
    else byStatus.set(sample.status, [sample]);
  }

  return [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, group]) => {
      const reason = worstGapReason(group.map(responseGapReason));
      const bodyFile = firstNonNull(group.map((s) => s.responseBodyFile));
      return {
        status,
        count: group.length,
        bodySample: firstNonNull(group.map((s) => s.responseBodySample)),
        ...(bodyFile ? { bodyFile } : {}),
        schema: inferSchemaFromBodies(group.map((s) => s.responseBodySample)),
        ...(reason ? { schemaReason: reason } : {}),
        mimeTypes: unique(group.map((s) => s.mimeType).filter(Boolean)),
      };
    });
}

function firstNonNull(values: (string | null | undefined)[]): string | null {
  return values.find((v): v is string => v !== null && v !== undefined) ?? null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
