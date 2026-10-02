/**
 * Opt-in telemetry.
 *
 * A scan usually targets a private system, so the only thing worth collecting
 * is *why* each endpoint was categorized the way it was — never the endpoint
 * itself. A payload therefore carries the category, the heuristic that matched,
 * the HTTP method, and whether the response was JSON; no host, path, query
 * value, header, or body ever enters it.
 *
 * Nothing is sent over the network. The payload is written to a local
 * `telemetry.json` that the user can read first and forward by hand, and it is
 * inert unless telemetry is explicitly enabled (`--telemetry`, the library
 * `telemetry` option, or `API_RECON_TELEMETRY=1`).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CapturedCall,
  CategorizationHeuristic,
  ReconReport,
  TelemetryPayload,
  TelemetrySignal,
} from '../types.js';
import { categorizeWithReason } from './analyzer.js';
import { toUrlPattern } from '../utils/url.js';
import { TOOL_VERSION } from '../version.js';

export const TELEMETRY_FILENAME = 'telemetry.json';

/**
 * The exact fields a payload may carry. This is the privacy boundary written
 * down: `test/unit/telemetry.test.ts` asserts a built payload has exactly these
 * keys, so a field added to the interface or the builder fails the build until
 * it is deliberately added here.
 */
export const TELEMETRY_PAYLOAD_KEYS: readonly string[] = [
  'version',
  'apiReconVersion',
  'generatedAt',
  'endpointCount',
  'contains',
  'signals',
];

/** The exact fields one signal may carry, pinned the same way. */
export const TELEMETRY_SIGNAL_KEYS: readonly string[] = ['category', 'heuristic', 'method', 'json'];

const PAYLOAD_KEY_SET = new Set<string>(TELEMETRY_PAYLOAD_KEYS);
const SIGNAL_KEY_SET = new Set<string>(TELEMETRY_SIGNAL_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStructural(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

/**
 * One line per way a payload widens the boundary; empty when it is exactly the
 * documented shape. It checks the key sets at both levels and refuses any nested
 * object or array other than the `signals` list itself, since a nested value is
 * where a captured host or path could hide behind an allowed field name.
 *
 * Exported rather than merely used by the test so an embedding application can
 * assert the same contract on a payload it receives.
 */
export function telemetryBoundaryViolations(payload: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(payload)) return ['$: the payload must be a JSON object'];

  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEY_SET.has(key)) problems.push(`$: unexpected field "${key}"`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'signals' && isStructural(value)) {
      problems.push(`$.${key}: must be a scalar, not a nested value`);
    }
  }

  const signals = payload['signals'];
  if (!Array.isArray(signals)) {
    problems.push('$.signals: must be an array');
    return problems;
  }
  signals.forEach((signal, index) => {
    const path = `$.signals[${index}]`;
    if (!isPlainObject(signal)) {
      problems.push(`${path}: must be an object`);
      return;
    }
    for (const key of Object.keys(signal)) {
      if (!SIGNAL_KEY_SET.has(key)) problems.push(`${path}: unexpected field "${key}"`);
    }
    for (const [key, value] of Object.entries(signal)) {
      if (isStructural(value)) {
        problems.push(`${path}.${key}: must be a scalar, not a nested value`);
      }
    }
  });

  return problems;
}

const CONTAINS =
  'categorization decisions only: category, heuristic, HTTP method, and whether ' +
  'the response was JSON. No host, path, query values, headers, or bodies.';

/** Build the anonymized signal set from a finished scan. */
export function buildTelemetry(report: ReconReport, calls: CapturedCall[]): TelemetryPayload {
  // Map each endpoint back to one of the calls that produced it, so the
  // heuristic can be re-evaluated. I only need the call's shape for that — the
  // URL is read and immediately discarded.
  const representative = new Map<string, CapturedCall>();
  for (const call of calls) {
    const key = `${call.method} ${toUrlPattern(call.url)}`;
    if (!representative.has(key)) representative.set(key, call);
  }

  const signals: TelemetrySignal[] = report.endpoints.map((endpoint) => {
    const call = representative.get(endpoint.id);
    const heuristic: CategorizationHeuristic = call
      ? categorizeWithReason(call, report.meta.seedUrl, endpoint.graphql !== undefined).heuristic
      : 'fallback';
    return {
      category: endpoint.category,
      heuristic,
      method: endpoint.method,
      json: endpoint.mimeTypes.some((mime) => mime.toLowerCase().includes('json')),
    };
  });

  signals.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.heuristic.localeCompare(b.heuristic) ||
      a.method.localeCompare(b.method),
  );

  return {
    version: 1,
    apiReconVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    endpointCount: signals.length,
    contains: CONTAINS,
    signals,
  };
}

/** The exact text written to `telemetry.json` and shown by a preview. */
export function formatTelemetry(payload: TelemetryPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** Write a telemetry payload to `<outDir>/telemetry.json`. */
export async function writeTelemetryFile(payload: TelemetryPayload, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, TELEMETRY_FILENAME);
  await writeFile(file, formatTelemetry(payload), 'utf8');
  return file;
}

/** What a scan should do with telemetry: build it, write it, and/or show it. */
export interface TelemetryPlan {
  /** Build the payload at all — true when telemetry is enabled or previewed. */
  build: boolean;
  /** Write `telemetry.json` to disk — only on an explicit opt-in. */
  write: boolean;
  /** Print the payload to stdout (preview). */
  print: boolean;
}

/**
 * Resolve the telemetry options to the actions a scan takes. A preview builds
 * the payload so it can be shown, but never writes a file: the disk write is
 * reserved for an explicit opt-in, which is the whole point of previewing.
 */
export function resolveTelemetryPlan(opts: {
  telemetry?: boolean;
  telemetryPreview?: boolean;
}): TelemetryPlan {
  const write = opts.telemetry ?? false;
  const print = opts.telemetryPreview ?? false;
  return { build: write || print, write, print };
}
