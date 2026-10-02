/**
 * A small schema walker for user-supplied config files (action scripts and
 * login flows).
 *
 * The shapes are tiny, so a general-purpose validator would be more machinery
 * than the problem needs. What matters is the message: a malformed step should
 * name the path (`steps[2].click`) and, where it can be found in the source, the
 * line — before a browser ever launches. A syntax error is reported with its
 * exact line and column by the loader; a structural error gets a best-effort
 * line from a small locator that understands the list-of-steps shape these
 * files all share.
 */

import type { SourceDocument, SourceFormat } from './config.js';
import { SafetyError } from './errors.js';

export type Path = ReadonlyArray<string | number>;

export interface FieldSpec {
  name: string;
  kind: ValueKind;
  /** Absent or false means the field must be present. */
  optional?: boolean;
}

/** One kind of step, identified by the single key it is written under. */
export interface StepSpec {
  key: string;
  kind: ValueKind;
}

export type ValueKind =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; of: ValueKind }
  | { kind: 'object'; fields: FieldSpec[]; allowExtra?: boolean }
  | { kind: 'step'; specs: StepSpec[] }
  | { kind: 'union'; of: ValueKind[] };

/** An object kind whose fields are all required strings. */
export function stringObject(fields: Record<string, 'string'>): ValueKind {
  return {
    kind: 'object',
    fields: Object.entries(fields).map(([name, type]) => ({ name, kind: { kind: type } })),
  };
}

/** One required enum field, for a small closed set such as scroll targets. */
export function enumField(name: string, values: readonly string[]): FieldSpec {
  return { name, kind: { kind: 'enum', values } };
}

type Check = { ok: true } | { ok: false; path: Path; message: string };

const OK: Check = { ok: true };

function bad(path: Path, message: string): Check {
  return { ok: false, path, message };
}

/** A dotted/indexed path: `steps[2].fill.selector`, or `<root>`. */
export function describePath(path: Path): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out === '' ? '<root>' : out;
}

/**
 * Validate a parsed document against a kind. Throws a `SafetyError` naming the
 * file, the line, and the offending path; returns normally when it is valid.
 */
export function checkDocument(doc: SourceDocument, kind: ValueKind): void {
  const result = checkValue(doc.value, [], kind);
  if (result.ok) return;
  const at = locate(doc, result.path);
  const where = at ? `${doc.filePath}:${at.line}:${at.column}` : doc.filePath;
  throw new SafetyError(`${where}: ${describePath(result.path)}: ${result.message}`, {
    hint: 'The login and actions files are checked before the browser opens — fix the file and run again.',
  });
}

function checkValue(value: unknown, path: Path, kind: ValueKind): Check {
  switch (kind.kind) {
    case 'string':
      return typeof value === 'string' && value.trim() !== ''
        ? OK
        : bad(path, `expected a non-empty string, got ${typeName(value)}`);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? OK
        : bad(path, `expected a non-negative number, got ${typeName(value)}`);
    case 'enum':
      return typeof value === 'string' && kind.values.includes(value)
        ? OK
        : bad(path, `expected one of ${kind.values.join(', ')}, got ${JSON.stringify(value)}`);
    case 'array': {
      if (!Array.isArray(value)) return bad(path, `expected a list, got ${typeName(value)}`);
      for (let index = 0; index < value.length; index += 1) {
        const result = checkValue(value[index], [...path, index], kind.of);
        if (!result.ok) return result;
      }
      return OK;
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return bad(path, `expected an object, got ${typeName(value)}`);
      }
      const object = value as Record<string, unknown>;
      for (const field of kind.fields) {
        if (!(field.name in object)) {
          if (field.optional) continue;
          return bad([...path, field.name], `missing required field "${field.name}"`);
        }
        const result = checkValue(object[field.name], [...path, field.name], field.kind);
        if (!result.ok) return result;
      }
      if (!kind.allowExtra) {
        const allowed = new Set(kind.fields.map((field) => field.name));
        const extra = Object.keys(object).find((key) => !allowed.has(key));
        if (extra !== undefined) return bad([...path, extra], `unexpected field "${extra}"`);
      }
      return OK;
    }
    case 'step':
      return checkStep(value, path, kind.specs);
    case 'union': {
      const results = kind.of.map((option) => checkValue(value, path, option));
      if (results.some((result) => result.ok)) return OK;
      // Prefer the most specific failure: a bad step inside a list should name
      // the step, not just "expected a list or an object".
      const failures = results.filter(
        (result): result is { ok: false; path: Path; message: string } => !result.ok,
      );
      failures.sort((a, b) => b.path.length - a.path.length);
      return failures[0] ?? bad(path, `expected ${describeKind(kind)}, got ${typeName(value)}`);
    }
  }
}

function checkStep(value: unknown, path: Path, specs: StepSpec[]): Check {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return bad(path, `expected a step object, got ${typeName(value)}`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  const allowed = specs.map((spec) => spec.key);
  if (keys.length === 0) {
    return bad(path, `expected one of ${allowed.join(', ')}, got an empty object`);
  }
  if (keys.length > 1) {
    return bad(path, `expected a single step key, got ${keys.join(', ')}`);
  }
  const key = keys[0]!;
  const spec = specs.find((candidate) => candidate.key === key);
  if (!spec) {
    return bad([...path, key], `unknown step "${key}"; expected one of ${allowed.join(', ')}`);
  }
  return checkValue(object[key], [...path, key], spec.kind);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return typeof value;
  }
}

function describeKind(kind: ValueKind): string {
  switch (kind.kind) {
    case 'string':
      return 'a non-empty string';
    case 'number':
      return 'a non-negative number';
    case 'enum':
      return `one of ${kind.values.join(', ')}`;
    case 'array':
      return `a list of ${describeKind(kind.of)}`;
    case 'object':
      return 'an object';
    case 'step':
      return `a step (${kind.specs.map((spec) => spec.key).join(', ')})`;
    case 'union':
      return kind.of.map(describeKind).join(' or ');
  }
}

// ---- locating a path in the source ----------------------------------------

/**
 * The best-effort line/column of a path in the document's text. It understands
 * a key (`steps:`), a list item (`- fill:`), and their nesting, which is the
 * shape every step file has; a path it cannot pin down falls back to the
 * nearest ancestor it could.
 */
function locate(doc: SourceDocument, path: Path): { line: number; column: number } | null {
  if (path.length === 0) return null;
  const lines = doc.text.split(/\r?\n/);
  let from = 0;
  let found: number | null = null;

  for (const segment of path) {
    const index =
      typeof segment === 'number'
        ? nthListItem(lines, from, segment)
        : findKey(lines, from, segment, doc.format);
    if (index === null) break;
    found = index;
    from = index + 1;
  }

  if (found === null) return null;
  const indent = lines[found]!.search(/\S/);
  return { line: found + 1, column: (indent < 0 ? 0 : indent) + 1 };
}

function nthListItem(lines: string[], from: number, n: number): number | null {
  let seen = 0;
  for (let index = from; index < lines.length; index += 1) {
    if (/^\s*-(\s|$)/.test(lines[index]!)) {
      if (seen === n) return index;
      seen += 1;
    }
  }
  return null;
}

function findKey(lines: string[], from: number, key: string, format: SourceFormat): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern =
    format === 'yaml'
      ? new RegExp(`^\\s*(?:-\\s*)?${escaped}\\s*:`)
      : new RegExp(`"${escaped}"\\s*:`);
  for (let index = from; index < lines.length; index += 1) {
    if (pattern.test(lines[index]!)) return index;
  }
  return null;
}
