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

/** Write a telemetry payload to `<outDir>/telemetry.json`. */
export async function writeTelemetryFile(payload: TelemetryPayload, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, TELEMETRY_FILENAME);
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}
