/**
 * Turn raw captured calls into deduplicated, categorized endpoints.
 *
 * Category precedence (first match wins):
 *   authentication -> analytics -> third-party -> graphql -> mutations
 *   -> data-fetching -> uncategorized
 */

import type {
  CapturedCall,
  CapturedWebSocket,
  CategorizationHeuristic,
  Category,
  Endpoint,
  ErrorResponse,
  QueryParam,
} from '../types.js';
import { analyzeGraphQL, mergeGraphQL } from './graphql.js';
import { inferSchemaFromBodies, inferSchemaFromFrames } from './schemaInference.js';
import { isSameDomain, toUrlPattern } from '../utils/url.js';

/** Hosts that are almost always telemetry/analytics vendors. */
export const ANALYTICS_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'fullstory.com',
  'clarity.ms',
  'plausible.io',
  'posthog.com',
  'matomo.cloud',
  'sentry.io',
  'snowplow',
  'datadoghq.com',
  'newrelic.com',
];

const AUTH_PATH_RE =
  /(^|\/)(login|logout|signin|signout|sign-in|sign-out|auth|authorize|oauth|token|tokens|session|register|signup|sign-up|sso|password|mfa|otp)(\/|$)/;

const ANALYTICS_PATH_RE =
  /(\/track|\/collect|\/beacon|\/telemetry|\/analytics|\/event|\/events|\/pixel|\/pageview|\/impression)/;

export function analyzeCalls(calls: CapturedCall[], opts: { seedUrl: string }): Endpoint[] {
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
    endpoints.push(buildEndpoint(id, samples, opts.seedUrl));
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
  return webSockets.map((socket) => ({
    ...socket,
    sentSchema: inferSchemaFromFrames(socket.frames, 'sent'),
    receivedSchema: inferSchemaFromFrames(socket.frames, 'received'),
  }));
}

function buildEndpoint(id: string, samples: CapturedCall[], seedUrl: string): Endpoint {
  const first = samples[0]!;
  const representative = samples[samples.length - 1]!;
  const pattern = id.slice(id.indexOf(' ') + 1);
  const graphql = mergeGraphQL(samples.map((s) => analyzeGraphQL(s)));
  const errors = collectErrorResponses(samples);

  return {
    id,
    method: first.method,
    urlPattern: pattern,
    origins: unique(samples.map((s) => safeOrigin(s.url))),
    category: categorize(first, seedUrl, graphql !== null),
    count: samples.length,
    statusCodes: unique(samples.map((s) => s.status)).sort((a, b) => a - b),
    requestHeaders: representative.requestHeaders,
    responseHeaders: representative.responseHeaders,
    requestBodySample: firstNonNull(samples.map((s) => s.requestBodySample)),
    responseBodySample: firstNonNull(samples.map((s) => s.responseBodySample)),
    pathParams: uniquePathParams(pattern),
    queryParams: collectQueryParams(samples),
    requestBodySchema: inferSchemaFromBodies(samples.map((s) => s.requestBodySample)),
    responseSchema: inferSchemaFromBodies(responseBodies(samples)),
    ...(errors.length ? { errorResponses: errors } : {}),
    mimeTypes: unique(samples.map((s) => s.mimeType).filter(Boolean)),
    triggeredBy: unique(samples.map((s) => s.triggeredBy)),
    ...(graphql ? { graphql } : {}),
  };
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
  if (ANALYTICS_HOSTS.some((h) => host.includes(h))) {
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

function collectQueryParams(samples: CapturedCall[]): QueryParam[] {
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
  return [...byName.entries()].map(([name, values]) => ({
    name,
    sampleValues: [...values].slice(0, 5),
  }));
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
 * The bodies the response schema is inferred from: every successful response
 * when there is one, so an error page cannot masquerade as the contract, and
 * every response otherwise.
 */
function responseBodies(samples: CapturedCall[]): (string | null)[] {
  const ok = samples
    .filter((s) => s.status >= 200 && s.status < 300)
    .map((s) => s.responseBodySample);
  return ok.some((body) => body !== null) ? ok : samples.map((s) => s.responseBodySample);
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
    .map(([status, group]) => ({
      status,
      count: group.length,
      bodySample: firstNonNull(group.map((s) => s.responseBodySample)),
      schema: inferSchemaFromBodies(group.map((s) => s.responseBodySample)),
      mimeTypes: unique(group.map((s) => s.mimeType).filter(Boolean)),
    }));
}

function firstNonNull(values: (string | null)[]): string | null {
  return values.find((v): v is string => v !== null && v !== undefined) ?? null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
