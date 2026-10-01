/**
 * Share-safe summary reporter — a one-page Markdown brief you can paste into a
 * ticket.
 *
 * `report.json`, the Markdown report, the dashboard, and OpenAPI all keep
 * *redacted* samples: a request body, a header, a socket frame. That is right
 * for the person who ran the scan and wrong for a ticket, a chat, or a shared
 * drive, because redaction masks secrets it recognizes and leaves the rest.
 * This reporter reads the same `ReconReport` but touches only the parts that
 * cannot carry a captured value — request patterns, categories, status codes,
 * call counts, and inferred schemas — so the output cannot leak what the scan
 * saw. `--share` writes this *instead of* the full reports, rather than beside
 * them, so the safe artifact is the only one on disk.
 *
 * The rule is structural, not a redaction pass: the fields that hold samples
 * (`requestHeaders`, `responseHeaders`, `requestBodySample`, `responseBodySample`,
 * an error's `bodySample`, a socket frame's `payloadSample`, a query parameter's
 * `sampleValues`) are simply never read here. Finding `details` are omitted too:
 * the verbose-error cue quotes a slice of a captured body.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Endpoint, ReconReport } from '../types.js';
import { describeGapReason } from '../core/schemaInference.js';
import { scorecardSummary } from './markdown.js';
import { FORMAT_FILENAMES } from './json.js';

/** Escape a value for a Markdown table cell and neutralise raw HTML. */
function cell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline code that still renders when the value contains its own backticks. */
function inline(value: string): string {
  const longest = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** The host of the seed URL: name the site, but not a deep path that could hold a token. */
function hostOf(seedUrl: string): string {
  try {
    return new URL(seedUrl).host;
  } catch {
    return seedUrl;
  }
}

/** Only the path of a URL: a query string can carry a session token. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** True when an endpoint has anything to say in the contracts section. */
function hasContract(endpoint: Endpoint): boolean {
  return Boolean(
    endpoint.requestBodySchema ||
      endpoint.responseSchema ||
      endpoint.requestBodySchemaReason ||
      endpoint.responseSchemaReason ||
      endpoint.errorResponses?.length ||
      endpoint.pathParams.length ||
      endpoint.queryParams.length ||
      endpoint.graphql,
  );
}

function contractBlock(endpoint: Endpoint): string[] {
  const out: string[] = [];
  out.push(`### ${inline(`${endpoint.method} ${endpoint.urlPattern}`)}`);
  out.push('');

  if (endpoint.pathParams.length) {
    out.push(`- Path parameters: ${endpoint.pathParams.map(inline).join(', ')}`);
  }
  // Parameter names are part of the contract; the sampled values are not.
  if (endpoint.queryParams.length) {
    out.push(`- Query parameters: ${endpoint.queryParams.map((param) => inline(param.name)).join(', ')}`);
  }
  if (endpoint.vendor) {
    out.push(`- Vendor: ${cell(endpoint.vendor.name)} (${cell(endpoint.vendor.category)})`);
  }
  if (endpoint.graphql) {
    const operations = endpoint.graphql.operations.map((op) => {
      const fields = op.selections?.length ? ` → ${op.selections.join(', ')}` : '';
      return `${inline(op.name ?? 'anonymous')} (${op.type})${fields}`;
    });
    out.push(`- GraphQL introspection: ${endpoint.graphql.introspection ? 'observed' : 'not observed'}`);
    if (operations.length) out.push(`- GraphQL operations: ${operations.join('; ')}`);
  }

  if (endpoint.requestBodySchema) {
    out.push(`- Request body: ${inline(JSON.stringify(endpoint.requestBodySchema))}`);
  } else if (endpoint.requestBodySchemaReason) {
    out.push(`- Request body: _not observed — ${describeGapReason(endpoint.requestBodySchemaReason)}_`);
  }
  if (endpoint.responseSchema) {
    out.push(`- Response: ${inline(JSON.stringify(endpoint.responseSchema))}`);
  } else if (endpoint.responseSchemaReason) {
    out.push(`- Response: _not observed — ${describeGapReason(endpoint.responseSchemaReason)}_`);
  }
  for (const error of endpoint.errorResponses ?? []) {
    if (error.schema) {
      out.push(`- Error ${error.status}: ${inline(JSON.stringify(error.schema))}`);
    } else if (error.schemaReason) {
      out.push(`- Error ${error.status}: _not observed — ${describeGapReason(error.schemaReason)}_`);
    } else {
      out.push(`- Error ${error.status}: _no schema_`);
    }
  }

  out.push('');
  return out;
}

/**
 * Render the summary. Only the report's sample-free fields are read; see the
 * module comment for the list this deliberately never touches.
 */
export function renderShareSummary(report: ReconReport): string {
  const { meta } = report;
  const out: string[] = [];

  out.push(`# API surface — ${cell(hostOf(meta.seedUrl))}`);
  out.push('');
  out.push(
    `_Share-safe summary of an **api-recon** v${meta.apiReconVersion} scan on ${cell(meta.startedAt)} ` +
      `(${cell(meta.engine)}). It keeps request patterns, categories, and schemas only — no request ` +
      'or response bodies, headers, or captured samples._',
  );
  out.push('');
  out.push(`_${scorecardSummary(report)}._`);
  out.push('');

  if (report.technologies.length > 0) {
    out.push(
      `**Technologies:** ${report.technologies
        .map((tech) => `${cell(tech.name)} (${cell(tech.category)})`)
        .join(', ')}`,
    );
    out.push('');
  }

  out.push('## Endpoints');
  out.push('');
  if (report.endpoints.length === 0) {
    out.push('_No XHR/fetch traffic was captured._');
    out.push('');
  } else {
    out.push('| Method | Path | Category | Status | Calls |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const endpoint of report.endpoints) {
      out.push(
        `| ${cell(endpoint.method)} | ${inline(endpoint.urlPattern)} | ${cell(endpoint.category)} | ` +
          `${endpoint.statusCodes.join(', ') || '—'} | ${endpoint.count} |`,
      );
    }
    out.push('');
  }

  const contracts = report.endpoints.filter(hasContract);
  if (contracts.length > 0) {
    out.push('## Contracts');
    out.push('');
    for (const endpoint of contracts) out.push(...contractBlock(endpoint));
  }

  if (report.webSockets.length > 0) {
    out.push('## WebSockets');
    out.push('');
    for (const ws of report.webSockets) {
      out.push(
        `- ${inline(pathOf(ws.url))} — ${ws.frameCount} frame(s) ` +
          `(${ws.sentCount} sent, ${ws.receivedCount} received)`,
      );
      if (ws.sentSchema) out.push(`  - Sent: ${inline(JSON.stringify(ws.sentSchema))}`);
      if (ws.receivedSchema) out.push(`  - Received: ${inline(JSON.stringify(ws.receivedSchema))}`);
    }
    out.push('');
  }

  if (report.diff) {
    out.push('## Changes since baseline');
    out.push('');
    if (!report.diff.hasChanges) {
      out.push('_No endpoint changes were detected._');
    } else {
      const { added, removed, changed, breaking } = report.diff.counts;
      out.push(
        `**${added}** added, **${removed}** removed, **${changed}** changed — ` +
          `**${breaking}** classified as breaking.`,
      );
      out.push('');
      for (const change of report.diff.changes) {
        out.push(`- ${change.kind} ${inline(change.id)}${change.breaking ? ' **(breaking)**' : ''}`);
      }
    }
    out.push('');
  }

  if (report.findings?.length) {
    out.push('## Findings');
    out.push('');
    // Titles and the endpoints they concern are patterns; the details are not
    // included because one cue quotes a slice of an error body.
    for (const finding of report.findings) {
      const scope = finding.endpoints.length
        ? ` — ${finding.endpoints.map(inline).join(', ')}`
        : ' (site-wide)';
      out.push(`- **${cell(finding.severity)}** ${cell(finding.title)}${scope}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    '_Share-safe: built only from request patterns, categories, and schemas — ' +
      'no request or response body, header, or sample is included._',
  );
  out.push('');

  return out.join('\n');
}

export async function writeShareReport(report: ReconReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, FORMAT_FILENAMES.share);
  await writeFile(file, renderShareSummary(report), 'utf8');
  return file;
}
