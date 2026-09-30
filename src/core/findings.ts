/**
 * Derive the review cues that close a report: what a reader should act on.
 *
 * Every finding is a heuristic over the data already in the report — nothing
 * extra is captured to produce it — and each says "look here", not "this is a
 * vulnerability". A scan samples whatever traffic it triggered, so a finding is
 * a prompt for a human, which is exactly what turns a capture into a review
 * artifact rather than a data dump.
 */

import type { Endpoint, Finding, FindingSeverity, JsonSchemaLike, ReconReport } from '../types.js';

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Paths that usually carry per-user or privileged data. */
const SENSITIVE_PATH_RE =
  /(^|\/)(user|users|account|accounts|admin|profile|settings|billing|invoice|payment|me)(\/|$)/i;

/** Field names that usually hold personal data, as opposed to secrets. */
const PII_FIELD_RE =
  /(e-?mail|phone|mobile|ssn|social_security|passport|national_id|date_of_birth|birth_?date|address|postal|zip|credit_?card|card_number|iban)/i;

/** Response headers a hardened site is expected to send. */
const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
] as const;

/** Error-body shapes that suggest internals leaked. */
const VERBOSE_ERROR_RE =
  /(stack trace|traceback|node_modules|sqlstate|syntax error at or near|java\.lang\.|sequelize|prisma|mongodb|internal server error|\/usr\/src\/app|\/var\/www)/i;

/** Every review cue a report can carry, highest severity first. */
export function collectFindings(report: ReconReport): Finding[] {
  const findings = [
    ...unauthenticated(report.endpoints),
    ...piiFields(report.endpoints),
    ...verboseErrors(report.endpoints),
    ...missingSecurityHeaders(report.endpoints),
    ...inconsistentShapes(report.endpoints),
  ];
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Sensitive-looking endpoints that answered without a credential. Analytics,
 * third-party, and authentication endpoints are excluded: they are expected to
 * be anonymous, and flagging them would bury the ones that matter.
 */
function unauthenticated(endpoints: Endpoint[]): Finding[] {
  const matches = endpoints.filter((endpoint) => {
    if (endpoint.category === 'analytics' || endpoint.category === 'third-party') return false;
    if (endpoint.category === 'authentication') return false;
    if (!SENSITIVE_PATH_RE.test(endpoint.urlPattern)) return false;
    if (!endpoint.statusCodes.some((status) => status >= 200 && status < 300)) return false;
    return !hasHeader(endpoint.requestHeaders, 'authorization') && !hasHeader(endpoint.requestHeaders, 'cookie');
  });
  if (matches.length === 0) return [];

  return [
    {
      kind: 'unauthenticated',
      severity: 'high',
      title: 'Sensitive-looking endpoints answered without credentials',
      endpoints: matches.map((endpoint) => endpoint.id),
      details: matches.map(
        (endpoint) =>
          `${endpoint.id} — no Authorization or Cookie header; observed ${describeStatuses(endpoint.statusCodes)}`,
      ),
    },
  ];
}

/** Field paths whose names look like personal data, across request, response, and error shapes. */
function piiFields(endpoints: Endpoint[]): Finding[] {
  const details: string[] = [];
  const ids: string[] = [];

  for (const endpoint of endpoints) {
    const fields = new Set<string>();
    collectPiiPaths(endpoint.requestBodySchema, '', fields);
    collectPiiPaths(endpoint.responseSchema, '', fields);
    for (const error of endpoint.errorResponses ?? []) collectPiiPaths(error.schema, '', fields);
    if (fields.size === 0) continue;
    ids.push(endpoint.id);
    details.push(`${endpoint.id} — ${[...fields].sort().join(', ')}`);
  }

  if (ids.length === 0) return [];
  return [
    {
      kind: 'pii',
      severity: 'medium',
      title: 'PII-shaped fields appear in captured samples',
      endpoints: ids,
      details,
    },
  ];
}

/** Error bodies that look like they returned internals rather than a clean contract. */
function verboseErrors(endpoints: Endpoint[]): Finding[] {
  const details: string[] = [];
  const ids: string[] = [];

  for (const endpoint of endpoints) {
    for (const error of endpoint.errorResponses ?? []) {
      if (error.bodySample === null) continue;
      const matched = VERBOSE_ERROR_RE.exec(error.bodySample)?.[0];
      if (!matched) continue;
      if (!ids.includes(endpoint.id)) ids.push(endpoint.id);
      details.push(`${endpoint.id} — ${error.status} body exposed internals ("${matched}")`);
    }
  }

  if (ids.length === 0) return [];
  return [
    {
      kind: 'verbose-error',
      severity: 'medium',
      title: 'Error bodies exposed internal detail',
      endpoints: ids,
      details,
    },
  ];
}

/** Security headers that no captured response sent. Site-wide, so it lists no endpoints. */
function missingSecurityHeaders(endpoints: Endpoint[]): Finding[] {
  if (endpoints.length === 0) return [];

  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    for (const name of Object.keys(endpoint.responseHeaders)) seen.add(name.toLowerCase());
  }

  const missing = SECURITY_HEADERS.filter((name) => !seen.has(name));
  if (missing.length === 0) return [];
  return [
    {
      kind: 'missing-security-header',
      severity: 'low',
      title: 'Security headers not observed on any response',
      endpoints: [],
      details: missing.map((name) => `${name} was not present on any captured response`),
    },
  ];
}

/**
 * Endpoints whose shape disagreed with itself inside one run: the merge had to
 * fall back to a `oneOf` union, which means a client cannot rely on one shape.
 */
function inconsistentShapes(endpoints: Endpoint[]): Finding[] {
  const details: string[] = [];
  const ids: string[] = [];

  for (const endpoint of endpoints) {
    const labels: string[] = [];
    const response = unionPaths(endpoint.responseSchema);
    if (response.length > 0) labels.push(`response at ${response.join(', ')}`);
    const request = unionPaths(endpoint.requestBodySchema);
    if (request.length > 0) labels.push(`request body at ${request.join(', ')}`);
    for (const error of endpoint.errorResponses ?? []) {
      const paths = unionPaths(error.schema);
      if (paths.length > 0) labels.push(`error ${error.status} at ${paths.join(', ')}`);
    }
    if (labels.length === 0) continue;
    ids.push(endpoint.id);
    details.push(`${endpoint.id} — shape varied across samples (${labels.join('; ')})`);
  }

  if (ids.length === 0) return [];
  return [
    {
      kind: 'inconsistent-shape',
      severity: 'low',
      title: 'Endpoint shapes were inconsistent within a single scan',
      endpoints: ids,
      details,
    },
  ];
}

/** Collect the dotted paths at which a schema had to use a `oneOf` union. */
function unionPaths(schema: JsonSchemaLike | null, prefix = '', out: string[] = []): string[] {
  if (!schema) return out;
  if (schema.oneOf && schema.oneOf.length > 0) out.push(prefix === '' ? '(root)' : prefix);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    unionPaths(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  if (schema.items) unionPaths(schema.items, `${prefix}[]`, out);
  for (const variant of schema.oneOf ?? []) unionPaths(variant, prefix, out);
  return out;
}

/** Collect the paths whose field name looks like personal data, recursing into objects and arrays. */
function collectPiiPaths(
  schema: JsonSchemaLike | null,
  prefix: string,
  out: Set<string>,
): void {
  if (!schema) return;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (PII_FIELD_RE.test(key)) out.add(path);
    collectPiiPaths(child, path, out);
  }
  if (schema.items) collectPiiPaths(schema.items, `${prefix}[]`, out);
  for (const variant of schema.oneOf ?? []) collectPiiPaths(variant, prefix, out);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function describeStatuses(statuses: number[]): string {
  return statuses.length > 0 ? statuses.join(', ') : 'no response';
}
