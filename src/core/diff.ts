/**
 * Compare two scans and report endpoint-level API changes.
 *
 * Classification is deliberately conservative. A scan samples whatever traffic
 * the crawl happened to trigger, so "not seen this time" is not proof that an
 * endpoint is gone — removals are still reported, but the evidence is spelled
 * out in `details` so a human can judge. Only changes that would plausibly
 * break an existing client are flagged `breaking`.
 *
 * A shape that was only partly observed — because a body was truncated, was
 * not JSON, or was never captured — is not compared field-by-field: a gap is
 * reported as such rather than mistaken for a removed field.
 *
 * WebSocket connections are compared too. They have no HTTP status or method,
 * so they ride in the same change list under a `WS `-prefixed pseudo-id; that
 * keeps one set of counts, one summary, and the dashboard's existing change
 * column and removed-row rendering working without a second code path.
 */

import { readFile } from 'node:fs/promises';
import type {
  CapturedWebSocket,
  Endpoint,
  EndpointChange,
  ErrorResponse,
  GraphQLInfo,
  GraphQLOperation,
  JsonSchemaLike,
  ReconReport,
  ReportDiff,
  ScanRef,
  SchemaGapReason,
} from '../types.js';
import { describeGapReason, inferSchemaFromFrames } from './schemaInference.js';
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

  const baselineSockets = new Map((baseline.webSockets ?? []).map((ws) => [socketId(ws), ws]));
  const currentSockets = new Map((current.webSockets ?? []).map((ws) => [socketId(ws), ws]));

  for (const [id, socket] of currentSockets) {
    const before = baselineSockets.get(id);
    if (!before) {
      changes.push({
        id,
        kind: 'added',
        breaking: false,
        details: [`new WebSocket connection (observed ${describeFrameCount(socket.frameCount)})`],
      });
      continue;
    }

    const details = compareSockets(before, socket);
    if (details.length > 0) {
      changes.push({
        id,
        kind: 'changed',
        breaking: details.some((d) => d.breaking),
        details: details.map((d) => d.text),
      });
    }
  }

  for (const [id, socket] of baselineSockets) {
    if (currentSockets.has(id)) continue;
    changes.push({
      id,
      kind: 'removed',
      breaking: true,
      details: [`not observed in this scan (was ${describeFrameCount(socket.frameCount)})`],
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

/** A stable id for a WebSocket connection, so it can share the change list. */
function socketId(socket: CapturedWebSocket): string {
  return `WS ${socket.url}`;
}

/**
 * Compare the frames exchanged on the same WebSocket connection.
 *
 * Raw frame streams are noisy — a scan records whatever the crawl happened to
 * trigger — so only the message *shape* is compared: the top-level fields a
 * client would read out of sent and received JSON frames. A field that
 * disappears is flagged breaking, exactly as a removed response field is.
 */
function compareSockets(before: CapturedWebSocket, after: CapturedWebSocket): Detail[] {
  const details: Detail[] = [];
  details.push(
    ...diffSchema(
      inferSchemaFromFrames(before.frames, 'sent'),
      inferSchemaFromFrames(after.frames, 'sent'),
      'WebSocket sent message',
      { before: before.sentSchemaReason, after: after.sentSchemaReason },
    ),
  );
  details.push(
    ...diffSchema(
      inferSchemaFromFrames(before.frames, 'received'),
      inferSchemaFromFrames(after.frames, 'received'),
      'WebSocket received message',
      { before: before.receivedSchemaReason, after: after.receivedSchemaReason },
    ),
  );
  return details;
}

function describeFrameCount(count: number): string {
  return `${count} frame(s)`;
}

/**
 * Compare the error body shapes by status. A status appearing or disappearing is
 * already covered by the status-code comparison, so this only looks at statuses
 * seen on both sides — where a changed error body is otherwise invisible.
 */
function diffErrorResponses(
  before: ErrorResponse[] | undefined,
  after: ErrorResponse[] | undefined,
): Detail[] {
  if (!before?.length || !after?.length) return [];
  const beforeBy = new Map(before.map((error) => [error.status, error]));
  const details: Detail[] = [];

  for (const error of after) {
    const previous = beforeBy.get(error.status);
    if (previous) {
      details.push(
        ...diffSchema(previous.schema, error.schema, `error response ${error.status}`, {
          before: previous.schemaReason,
          after: error.schemaReason,
        }),
      );
    }
  }
  return details;
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

  details.push(
    ...diffSchema(before.responseSchema, after.responseSchema, 'response', {
      before: before.responseSchemaReason,
      after: after.responseSchemaReason,
    }),
  );
  details.push(
    ...diffSchema(before.requestBodySchema, after.requestBodySchema, 'request body', {
      before: before.requestBodySchemaReason,
      after: after.requestBodySchemaReason,
    }),
  );
  details.push(...diffErrorResponses(before.errorResponses, after.errorResponses));

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
  gap: { before?: SchemaGapReason; after?: SchemaGapReason } = {},
): Detail[] {
  if (!before && !after) return [];
  const gapNote = gap.after ?? gap.before;
  if (!before) return [{ text: `${label} schema newly inferred`, breaking: false }];
  if (!after) {
    const suffix = gapNote ? ` (${describeGapReason(gapNote)})` : '';
    return [{ text: `${label} schema no longer inferred${suffix}`, breaking: false }];
  }
  // Both shapes exist, but a truncated or uncaptured sample can hide a field,
  // so a field-level comparison against an incomplete observation would be a
  // guess. Say the comparison was skipped rather than report a false removal.
  if (gapNote) {
    return [
      {
        text: `${label} not fully observed (${describeGapReason(gapNote)}); shape not compared`,
        breaking: false,
      },
    ];
  }
  return diffSchemaNode(before, after, label, '');
}

function diffSchemaNode(
  before: JsonSchemaLike,
  after: JsonSchemaLike,
  label: string,
  path: string,
): Detail[] {
  const details: Detail[] = [];
  const where = path === '' ? '(root)' : path;

  // Compared as type sets so a field that gained (or lost) a union member reads
  // as a type change rather than being missed because neither side has a single
  // `type`.
  const beforeTypes = typeNames(before);
  const afterTypes = typeNames(after);
  if (beforeTypes.join('|') !== afterTypes.join('|')) {
    details.push({
      text: `${label} ${where}: type ${beforeTypes.join('|') || 'unknown'} → ${afterTypes.join('|') || 'unknown'}`,
      breaking: true,
    });
  }

  // A narrowed enum or a tightened numeric range rejects values a client may
  // rely on, so both are breaking; widening the set is reported as additive.
  // Only compared when the type itself is unchanged — a type change is already
  // reported above, and an enum/bound diff beside it would just be noise.
  if (beforeTypes.join('|') === afterTypes.join('|')) {
    details.push(...diffEnum(before, after, label, where));
    details.push(...diffNumericBounds(before, after, label, where));
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
 * Compare the closed sets of two enum-bearing schemas. Losing a value (or
 * gaining an enum where none was inferred) narrows what a client can send or
 * expect, so it is breaking; gaining a value widens the set and is not.
 */
function diffEnum(
  before: JsonSchemaLike,
  after: JsonSchemaLike,
  label: string,
  where: string,
): Detail[] {
  const beforeEnum = before.enum;
  const afterEnum = after.enum;
  if (!beforeEnum && !afterEnum) return [];

  if (!beforeEnum) {
    return [
      {
        text: `${label} ${where}: enum added (${afterEnum!.map(showValue).join(', ')})`,
        breaking: true,
      },
    ];
  }
  if (!afterEnum) {
    return [
      {
        text: `${label} ${where}: enum no longer inferred (was ${beforeEnum.map(showValue).join(', ')})`,
        breaking: false,
      },
    ];
  }

  const beforeSet = new Set(beforeEnum);
  const afterSet = new Set(afterEnum);
  const removed = beforeEnum.filter((value) => !afterSet.has(value));
  const added = afterEnum.filter((value) => !beforeSet.has(value));
  const details: Detail[] = [];
  if (removed.length > 0) {
    details.push({
      text: `${label} ${where}: enum values removed: ${removed.map(showValue).join(', ')}`,
      breaking: true,
    });
  }
  if (added.length > 0) {
    details.push({
      text: `${label} ${where}: enum values added: ${added.map(showValue).join(', ')}`,
      breaking: false,
    });
  }
  return details;
}

/**
 * Compare the observed numeric bounds. A bound that appears or moves inward
 * narrows the range and is breaking; one that disappears or moves outward only
 * widens it.
 */
function diffNumericBounds(
  before: JsonSchemaLike,
  after: JsonSchemaLike,
  label: string,
  where: string,
): Detail[] {
  return [
    ...diffBound('minimum', before.minimum, after.minimum, label, where),
    ...diffBound('maximum', before.maximum, after.maximum, label, where),
  ];
}

function diffBound(
  name: 'minimum' | 'maximum',
  before: number | undefined,
  after: number | undefined,
  label: string,
  where: string,
): Detail[] {
  if (before === after) return [];
  // `minimum` narrows when it rises (or newly appears); `maximum` when it
  // falls. A missing bound is unbounded, so appearing is always a narrowing.
  const narrows =
    before === undefined || (after !== undefined && (name === 'minimum' ? after > before : after < before));
  return [
    {
      text: `${label} ${where}: ${name} ${before ?? 'unbounded'} → ${after ?? 'unbounded'}`,
      breaking: narrows,
    },
  ];
}

/** Render an enum value so a string is quoted and a number is not. */
function showValue(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/** The type names a schema node can take, flattening a `oneOf` union. */
function typeNames(schema: JsonSchemaLike): string[] {
  if (schema.type) return [schema.type];
  return (schema.oneOf ?? []).flatMap(typeNames);
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
  const engineNote = engineDifferenceNote(diff);

  if (!diff.hasChanges) {
    return [
      'No endpoint changes since the baseline.',
      ...(engineNote ? [engineNote] : []),
    ];
  }

  const { added, removed, changed, breaking } = diff.counts;
  const lines = [
    `API changes since baseline: ${added} added, ${removed} removed, ${changed} changed` +
      ` (${breaking} breaking).`,
  ];

  // Say so before the change list: an engine difference can explain changes
  // that have nothing to do with the API.
  if (engineNote) lines.push(engineNote);

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

/**
 * A caution for when the two scans did not run in the same engine — sites can
 * serve different responses per engine, so a change may not be an API change.
 * Returns null when the engines match or either scan predates the field.
 */
function engineDifferenceNote(diff: ReportDiff): string | null {
  const before = diff.baseline.engine;
  const after = diff.current.engine;
  if (!before || !after || before === after) return null;
  return (
    `Note: the baseline ran in ${before} and this scan in ${after} — ` +
    'some differences may be engine-specific.'
  );
}

function scanRef(report: ReconReport): ScanRef {
  return {
    seedUrl: report.meta.seedUrl,
    startedAt: report.meta.startedAt,
    apiReconVersion: report.meta.apiReconVersion,
    // Absent on reports written before the engine was recorded.
    ...(report.meta.engine ? { engine: report.meta.engine } : {}),
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
