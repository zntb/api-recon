/**
 * Compare two scans and report endpoint-level API changes.
 *
 * Classification is deliberately conservative. A scan samples whatever traffic
 * the crawl happened to trigger, so "not seen this time" is not proof that an
 * endpoint is gone — removals are still reported, but the evidence is spelled
 * out in `details` so a human can judge. Only changes that would plausibly
 * break an existing client are flagged `breaking`.
 */

import { readFile } from 'node:fs/promises';
import type {
  Endpoint,
  EndpointChange,
  GraphQLInfo,
  GraphQLOperation,
  JsonSchemaLike,
  ReconReport,
  ReportDiff,
  ScanRef,
} from '../types.js';
import { SafetyError } from '../utils/safety.js';

interface Detail {
  text: string;
  breaking: boolean;
}

/** Compare a current scan against a baseline report. */
export function diffReports(baseline: ReconReport, current: ReconReport): ReportDiff {
  const baselineById = new Map(baseline.endpoints.map((e) => [e.id, e]));
  const currentById = new Map(current.endpoints.map((e) => [e.id, e]));
  const changes: EndpointChange[] = [];

  for (const [id, endpoint] of currentById) {
    const before = baselineById.get(id);

    if (!before) {
      changes.push({
        id,
        kind: 'added',
        breaking: false,
        details: [`new endpoint (observed ${describeStatuses(endpoint.statusCodes)})`],
      });
      continue;
    }

    const details = compareEndpoints(before, endpoint);
    if (details.length > 0) {
      changes.push({
        id,
        kind: 'changed',
        breaking: details.some((d) => d.breaking),
        details: details.map((d) => d.text),
      });
    }
  }

  for (const [id, endpoint] of baselineById) {
    if (currentById.has(id)) continue;
    changes.push({
      id,
      kind: 'removed',
      breaking: true,
      details: [`not observed in this scan (was ${describeStatuses(endpoint.statusCodes)})`],
    });
  }

  changes.sort((a, b) => a.id.localeCompare(b.id));

  const counts = {
    added: changes.filter((c) => c.kind === 'added').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    changed: changes.filter((c) => c.kind === 'changed').length,
    breaking: changes.filter((c) => c.breaking).length,
  };

  return {
    baseline: scanRef(baseline),
    current: scanRef(current),
    changes,
    counts,
    hasChanges: changes.length > 0,
  };
}

function compareEndpoints(before: Endpoint, after: Endpoint): Detail[] {
  const details: Detail[] = [];

  const beforeStatuses = [...before.statusCodes].sort((a, b) => a - b);
  const afterStatuses = [...after.statusCodes].sort((a, b) => a - b);
  if (beforeStatuses.join(',') !== afterStatuses.join(',')) {
    // Losing every 2xx is the one status change that is clearly breaking.
    const hadSuccess = beforeStatuses.some(isSuccess);
    const hasSuccess = afterStatuses.some(isSuccess);
    details.push({
      text:
        `status codes ${describeStatuses(beforeStatuses)} → ${describeStatuses(afterStatuses)}` +
        (hadSuccess && !hasSuccess ? ' (no longer returns 2xx)' : ''),
      breaking: hadSuccess && !hasSuccess,
    });
  }

  if (before.category !== after.category) {
    details.push({ text: `category ${before.category} → ${after.category}`, breaking: false });
  }

  details.push(...diffSchema(before.responseSchema, after.responseSchema, 'response'));
  details.push(...diffSchema(before.requestBodySchema, after.requestBodySchema, 'request body'));

  const beforeParams = new Set(before.queryParams.map((q) => q.name));
  const afterParams = new Set(after.queryParams.map((q) => q.name));
  const addedParams = [...afterParams].filter((p) => !beforeParams.has(p));
  const removedParams = [...beforeParams].filter((p) => !afterParams.has(p));
  if (addedParams.length > 0) {
    details.push({ text: `new query parameters: ${addedParams.join(', ')}`, breaking: false });
  }
  if (removedParams.length > 0) {
    details.push({
      text: `query parameters not observed this time: ${removedParams.join(', ')}`,
      breaking: false,
    });
  }

  details.push(...diffGraphQL(before.graphql, after.graphql));

  return details;
}

/**
 * Compare the GraphQL operations observed on an endpoint.
 *
 * An operation that is new or whose introspection status flipped is additive;
 * an operation that is no longer seen is treated like a removed response field
 * or endpoint — the crawl may simply not have exercised it, but a client that
 * calls it would break, so it is flagged breaking and the evidence is spelled
 * out.
 */
function diffGraphQL(before: GraphQLInfo | undefined, after: GraphQLInfo | undefined): Detail[] {
  if (!before && !after) return [];

  if (before && !after) {
    return [{ text: 'GraphQL requests no longer observed on this endpoint', breaking: false }];
  }

  if (!before && after) {
    const details: Detail[] = [];
    const operations = describeOperations(after.operations);
    if (operations) {
      details.push({ text: `GraphQL operations newly observed: ${operations}`, breaking: false });
    }
    if (after.introspection) {
      details.push({ text: 'GraphQL introspection newly observed', breaking: false });
    }
    return details;
  }

  const beforeOps = before!.operations;
  const afterOps = after!.operations;
  const beforeKeys = new Set(beforeOps.map(operationKey));
  const afterKeys = new Set(afterOps.map(operationKey));
  const added = afterOps.filter((op) => !beforeKeys.has(operationKey(op)));
  const removed = beforeOps.filter((op) => !afterKeys.has(operationKey(op)));

  const details: Detail[] = [];
  if (added.length > 0) {
    details.push({ text: `new GraphQL operations: ${describeOperations(added)}`, breaking: false });
  }
  if (removed.length > 0) {
    details.push({
      text: `GraphQL operations not observed this time: ${describeOperations(removed)}`,
      breaking: true,
    });
  }
  if (!before!.introspection && after!.introspection) {
    details.push({ text: 'GraphQL introspection newly observed', breaking: false });
  } else if (before!.introspection && !after!.introspection) {
    details.push({ text: 'GraphQL introspection no longer observed', breaking: false });
  }

  return details;
}

function operationKey(operation: GraphQLOperation): string {
  return `${operation.type}:${operation.name ?? ''}`;
}

function describeOperations(operations: GraphQLOperation[]): string {
  return operations.map((op) => `${op.name ?? 'anonymous'} (${op.type})`).join(', ');
}

function diffSchema(
  before: JsonSchemaLike | null,
  after: JsonSchemaLike | null,
  label: string,
): Detail[] {
  if (!before && !after) return [];
  if (before && !after) return [{ text: `${label} schema no longer inferred`, breaking: false }];
  if (!before && after) return [{ text: `${label} schema newly inferred`, breaking: false }];
  return diffSchemaNode(before!, after!, label, '');
}

function diffSchemaNode(
  before: JsonSchemaLike,
  after: JsonSchemaLike,
  label: string,
  path: string,
): Detail[] {
  const details: Detail[] = [];
  const where = path === '' ? '(root)' : path;

  if (before.type && after.type && before.type !== after.type) {
    details.push({
      text: `${label} ${where}: type ${before.type} → ${after.type}`,
      breaking: true,
    });
  }

  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};

  for (const key of Object.keys(beforeProps)) {
    if (!(key in afterProps)) {
      details.push({ text: `${label} field removed: ${joinPath(path, key)}`, breaking: true });
    }
  }
  for (const key of Object.keys(afterProps)) {
    if (!(key in beforeProps)) {
      details.push({ text: `${label} field added: ${joinPath(path, key)}`, breaking: false });
    }
  }
  for (const key of Object.keys(beforeProps)) {
    const beforeChild = beforeProps[key];
    const afterChild = afterProps[key];
    if (beforeChild && afterChild) {
      details.push(...diffSchemaNode(beforeChild, afterChild, label, joinPath(path, key)));
    }
  }

  if (before.items && after.items) {
    details.push(...diffSchemaNode(before.items, after.items, label, `${path}[]`));
  }

  return details;
}

/**
 * Read a baseline report from disk.
 *
 * Errors here are user-input mistakes (a wrong path, or a file that is not a
 * report), so they are raised as `SafetyError` — the same class the CLI already
 * uses for invalid flags — which maps to exit code 2.
 */
export async function loadBaseline(filePath: string): Promise<ReconReport> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new SafetyError(`baseline report not found or unreadable: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SafetyError(`baseline report is not valid JSON: ${filePath}`);
  }

  const shape = parsed as Partial<ReconReport> | null;
  if (!shape || typeof shape !== 'object' || !shape.meta || !Array.isArray(shape.endpoints)) {
    throw new SafetyError(
      `baseline report must be an api-recon report.json with 'meta' and 'endpoints': ${filePath}`,
    );
  }

  return shape as ReconReport;
}

/** Console-friendly summary of a diff, one line per change. */
export function formatDiffSummary(diff: ReportDiff, maxItems = 25): string[] {
  if (!diff.hasChanges) {
    return ['No endpoint changes since the baseline.'];
  }

  const { added, removed, changed, breaking } = diff.counts;
  const lines = [
    `API changes since baseline: ${added} added, ${removed} removed, ${changed} changed` +
      ` (${breaking} breaking).`,
  ];

  for (const change of diff.changes.slice(0, maxItems)) {
    const marker = change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : '~';
    lines.push(`  ${marker} ${change.id}${change.breaking ? ' [breaking]' : ''}`);
    for (const detail of change.details) lines.push(`      ${detail}`);
  }

  if (diff.changes.length > maxItems) {
    lines.push(`  … and ${diff.changes.length - maxItems} more (full list in report.json)`);
  }

  return lines;
}

function scanRef(report: ReconReport): ScanRef {
  return {
    seedUrl: report.meta.seedUrl,
    startedAt: report.meta.startedAt,
    apiReconVersion: report.meta.apiReconVersion,
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeStatuses(statuses: number[]): string {
  return statuses.length > 0 ? statuses.join(', ') : 'no response';
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}
