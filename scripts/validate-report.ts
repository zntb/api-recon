/**
 * Report-schema guard.
 *
 * `meta.apiReconVersion` names the tool build that wrote a report, not the shape
 * of the document. `schemaVersion` names the shape, and `schema/report.schema.json`
 * is that shape written down. Validating the committed example report against
 * the schema means a renamed, dropped, or retyped field fails CI here instead of
 * breaking a downstream consumer silently — and it keeps the schema honest
 * against real output rather than a hand-maintained ideal.
 *
 *   npm run check:schema
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

export const SCHEMA_PATH = resolve(ROOT, 'schema/report.schema.json');
export const EXAMPLE_REPORT_PATH = resolve(ROOT, 'examples/output/report.json');

export interface SchemaValidation {
  valid: boolean;
  /** One `path: message` line per violation; empty when the document is valid. */
  errors: string[];
}

/** Read and parse a JSON file, letting the caller decide how to report failure. */
export function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Validate a parsed report document against the published JSON Schema. */
export function validateReport(report: unknown, schema: object): SchemaValidation {
  // `strict: false` because the schema's `$id`/`$schema` keywords are dialect
  // metadata, not something this project wants to police.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(report) as boolean;
  const errors = (validate.errors ?? []).map(describeError);
  return { valid, errors };
}

/** Render an ajv error as a single readable line, naming an extra property. */
function describeError(error: ErrorObject): string {
  const path = error.instancePath || '(root)';
  const property =
    error.keyword === 'additionalProperties'
      ? ` '${String(error.params['additionalProperty'])}'`
      : '';
  return `${path}: ${error.message}${property}`;
}

function main(): void {
  let schema: object;
  let report: unknown;
  try {
    schema = readJson(SCHEMA_PATH) as object;
    report = readJson(EXAMPLE_REPORT_PATH);
  } catch (err) {
    console.error('check-report-schema: cannot read the schema or the example report.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const result = validateReport(report, schema);

  if (!result.valid) {
    console.error(
      '\n::error::examples/output/report.json does not match schema/report.schema.json:\n',
    );
    for (const error of result.errors) console.error(`  • ${error}`);
    console.error(
      '\nIf a field legitimately changed, update schema/report.schema.json and bump' +
        ' REPORT_SCHEMA_VERSION in src/types.ts.\n',
    );
    process.exit(1);
  }

  console.log(
    'Report schema OK — examples/output/report.json matches schema/report.schema.json.',
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
