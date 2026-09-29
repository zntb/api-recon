/**
 * Turn raw captured calls into deduplicated, categorized endpoints.
 *
 * Category precedence (first match wins):
 *   authentication -> analytics -> third-party -> graphql -> mutations
 *   -> data-fetching -> uncategorized
 */

import type { CapturedCall, Category, Endpoint, QueryParam } from '../types.js';
import { analyzeGraphQL, mergeGraphQL } from './graphql.js';
import { inferSchemaFromBody } from './schemaInference.js';
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

function buildEndpoint(id: string, samples: CapturedCall[], seedUrl: string): Endpoint {
  const first = samples[0]!;
  const representative = samples[samples.length - 1]!;
  const pattern = id.slice(id.indexOf(' ') + 1);
  const graphql = mergeGraphQL(samples.map((s) => analyzeGraphQL(s)));

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
    requestBodySchema: inferSchemaFromBody(firstNonNull(samples.map((s) => s.requestBodySample))),
    responseSchema: inferSchemaFromBody(
      firstNonNull(samples.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.responseBodySample)) ??
        firstNonNull(samples.map((s) => s.responseBodySample)),
    ),
    mimeTypes: unique(samples.map((s) => s.mimeType).filter(Boolean)),
    triggeredBy: unique(samples.map((s) => s.triggeredBy)),
    ...(graphql ? { graphql } : {}),
  };
}

export function categorize(call: CapturedCall, seedUrl: string, isGraphQL = false): Category {
  let parsed: URL;
  try {
    parsed = new URL(call.url);
  } catch {
    return 'uncategorized';
  }
  const path = parsed.pathname.toLowerCase();
  const host = parsed.host.toLowerCase();

  if (AUTH_PATH_RE.test(path)) return 'authentication';
  if (ANALYTICS_HOSTS.some((h) => host.includes(h)) || ANALYTICS_PATH_RE.test(path)) return 'analytics';
  if (!isSameDomain(call.url, seedUrl)) return 'third-party';
  // A GraphQL endpoint is recognized by its request, not its path, so it wins
  // over the method-based buckets below.
  if (isGraphQL) return 'graphql';
  if (call.method !== 'GET' && call.method !== 'HEAD' && call.method !== 'OPTIONS') return 'mutations';
  if ((call.mimeType ?? '').toLowerCase().includes('json')) return 'data-fetching';
  return 'uncategorized';
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

function firstNonNull(values: (string | null)[]): string | null {
  return values.find((v): v is string => v !== null && v !== undefined) ?? null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
