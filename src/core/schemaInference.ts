/** Infer a compact JSON-Schema-like shape from sample payloads (depth-capped). */

import type { JsonSchemaLike, WebSocketDirection, WebSocketFrame } from '../types.js';

const MAX_DEPTH = 4;
const MAX_PROPERTIES = 50;
/**
 * The most distinct string values still treated as a closed set. A field with
 * more variety than this is prose or an identifier, not an enum, so none is
 * emitted. It also bounds the memory the statistics pass retains per field.
 */
const MAX_ENUM_VALUES = 10;
/** Longest string still eligible to be an enum member. */
const MAX_ENUM_LENGTH = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
// ISO-8601 durations, e.g. `P3D`, `PT1H30M`, `P1Y2M3DT4H5M6S`.
const DURATION_RE =
  /^-?P(?=\d|T\d)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;
const URI_RE = /^https?:\/\//;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CURRENCY_AMOUNT_RE = /^[\u20ac\u00a3$\u00a5\u20b9]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;
/** Common ISO-4217 codes, so a stray three-letter token is not read as money. */
const CURRENCY_CODES = new Set([
  'AED',
  'ARS',
  'AUD',
  'BGN',
  'BRL',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'HKD',
  'HRK',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NZD',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'RON',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'UAH',
  'USD',
  'VND',
  'ZAR',
]);

export function inferSchema(value: unknown, depth = 0): JsonSchemaLike {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { type: 'array' };
    const first = value.find((v) => v !== null && v !== undefined);
    return first === undefined ? { type: 'array', items: { type: 'any' } } : { type: 'array', items: inferSchema(first, depth + 1) };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string', ...stringFormatHint(value) };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      if (depth >= MAX_DEPTH) return { type: 'object' };
      const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_PROPERTIES);
      const properties: Record<string, JsonSchemaLike> = {};
      const required: string[] = [];
      for (const [k, v] of entries) {
        properties[k] = inferSchema(v, depth + 1);
        if (v !== undefined && v !== null) required.push(k);
      }
      return { type: 'object', properties, required };
    }
    default:
      return { type: 'any' };
  }
}

export function inferSchemaFromBody(body: string | null | undefined): JsonSchemaLike | null {
  const value = parseBody(body);
  return value === undefined ? null : inferSchema(value);
}

/**
 * Parse a body expected to carry a JSON object or array; `undefined` when it is
 * absent, not JSON, or a scalar (a scalar body has no fields to describe).
 */
function parseBody(body: string | null | undefined): unknown {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Infer one schema from several sample bodies, so the result describes every
 * observation rather than whichever body happened to come first. A field seen
 * in any sample is present, and it is `required` only when every sample had it.
 * Bodies that are absent or not JSON contribute nothing; the result is null
 * when no usable body was seen.
 *
 * A second, value-level pass annotates the merged shape with the hints a single
 * observation cannot give: a `format` for well-known string values (from
 * `inferSchema`), an `enum` when a string field only ever held a small closed
 * set of values, and `minimum`/`maximum` for a numeric field whose samples
 * spanned a range.
 */
export function inferSchemaFromBodies(
  bodies: readonly (string | null | undefined)[],
): JsonSchemaLike | null {
  const values: unknown[] = [];
  for (const body of bodies) {
    const value = parseBody(body);
    if (value !== undefined) values.push(value);
  }
  if (values.length === 0) return null;

  let merged: JsonSchemaLike | null = null;
  for (const value of values) {
    const schema = inferSchema(value);
    merged = merged ? mergeSchema(merged, schema) : schema;
  }
  return annotate(merged!, collectStats(values));
}

/** Observed values at one schema position, used to derive enums and bounds. */
interface ValueStats {
  /** Distinct string values seen (counted), until the enum cap is exceeded. */
  strings?: Map<string, number>;
  /** True once more distinct strings were seen than an enum could hold. */
  tooManyStrings?: boolean;
  /** Range of the numbers seen at this position. */
  numbers?: { min: number; max: number };
  properties?: Map<string, ValueStats>;
  items?: ValueStats;
}

/** Walk the parsed samples once, gathering the values behind each schema node. */
function collectStats(values: readonly unknown[]): ValueStats {
  const root: ValueStats = {};
  for (const value of values) collectValue(value, root, 0);
  return root;
}

function collectValue(value: unknown, stats: ValueStats, depth: number): void {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return;
    const items = (stats.items ??= {});
    for (const element of value) collectValue(element, items, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return;
    const properties = (stats.properties ??= new Map());
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      let childStats = properties.get(key);
      if (!childStats) {
        childStats = {};
        properties.set(key, childStats);
      }
      collectValue(child, childStats, depth + 1);
    }
    return;
  }
  if (typeof value === 'string') {
    if (stats.tooManyStrings) return;
    const strings = (stats.strings ??= new Map());
    strings.set(value, (strings.get(value) ?? 0) + 1);
    // Once the set is too large to be an enum, stop retaining its values.
    if (strings.size > MAX_ENUM_VALUES) {
      stats.tooManyStrings = true;
      stats.strings = undefined;
    }
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const numbers = (stats.numbers ??= { min: value, max: value });
    if (value < numbers.min) numbers.min = value;
    if (value > numbers.max) numbers.max = value;
  }
}

/**
 * Attach the value-level hints to a merged schema, walking it in step with the
 * statistics the samples produced. A string is an enum only when it held a
 * small closed set of short values and carried no format hint of its own; a
 * number gets bounds only when its samples actually spanned a range.
 */
function annotate(schema: JsonSchemaLike, stats: ValueStats): JsonSchemaLike {
  const out: JsonSchemaLike = { ...schema };

  if (out.type === 'string' && !out.description && stats.strings && stats.strings.size >= 2) {
    const values = [...stats.strings.keys()];
    if (values.every(isEnumMember)) out.enum = values;
  }

  if (
    out.type &&
    isNumericType(out.type) &&
    stats.numbers &&
    stats.numbers.min < stats.numbers.max
  ) {
    out.minimum = stats.numbers.min;
    out.maximum = stats.numbers.max;
  }

  if (out.properties) {
    const properties: Record<string, JsonSchemaLike> = {};
    for (const [key, child] of Object.entries(out.properties)) {
      const childStats = stats.properties?.get(key);
      properties[key] = childStats ? annotate(child, childStats) : child;
    }
    out.properties = properties;
  }

  if (out.items) {
    out.items = stats.items ? annotate(out.items, stats.items) : out.items;
  }

  // Each variant of a union sees the same observations and keeps only what fits
  // its own type: strings take an enum, numbers take bounds.
  if (out.oneOf) {
    out.oneOf = out.oneOf.map((variant) => annotate(variant, stats));
  }

  return out;
}

/**
 * A plausible enum member: short, and not prose. A value with whitespace is far
 * more likely to be a name or message than a member of a closed set.
 */
function isEnumMember(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ENUM_LENGTH &&
    !/\s/.test(value) &&
    !hasFormatHint(value)
  );
}

/**
 * Merge two inferred schemas into one that describes both observations: the
 * union of their fields, a field required only when both listed it, and a
 * `oneOf` when their types genuinely conflict. `integer` and `number` widen to
 * `number`, and a `null` observation just means the field was sometimes null.
 * A format hint (`description`) survives only when both sides agreed on it.
 */
export function mergeSchema(a: JsonSchemaLike, b: JsonSchemaLike): JsonSchemaLike {
  const variants = [...(a.oneOf ?? [a])];
  for (const incoming of b.oneOf ?? [b]) {
    let merged: JsonSchemaLike | null = null;
    let index = -1;
    for (let i = 0; i < variants.length; i += 1) {
      const combined = combineCompatible(variants[i]!, incoming);
      if (combined) {
        merged = combined;
        index = i;
        break;
      }
    }
    if (index >= 0) variants[index] = merged!;
    else variants.push(incoming);
  }

  // An `any` variant adds nothing once a real shape is known.
  const distinct = dedupe(variants);
  const known = distinct.filter((variant) => !isUninformative(variant));
  const kept = known.length > 0 ? known : distinct;
  return kept.length === 1 ? kept[0]! : { oneOf: kept };
}

/**
 * Merge the JSON frames in one direction into a single inferred shape, so a
 * socket's messages are described exactly like a request or response body.
 */
export function inferSchemaFromFrames(
  frames: WebSocketFrame[],
  direction: WebSocketDirection,
): JsonSchemaLike | null {
  return inferSchemaFromBodies(
    frames
      .filter((frame) => frame.direction === direction && frame.type === 'text')
      .map((frame) => frame.payloadSample),
  );
}

/** A schema that says nothing about the value (`any`, or no type at all). */
function isUninformative(schema: JsonSchemaLike): boolean {
  return schema.type === undefined || schema.type === 'any';
}

function isNumericType(type: string | undefined): boolean {
  return type === 'integer' || type === 'number';
}

/**
 * Merge two schemas whose types are compatible, or return null when they
 * genuinely conflict (the caller then keeps both as a union).
 */
function combineCompatible(a: JsonSchemaLike, b: JsonSchemaLike): JsonSchemaLike | null {
  // One side carries no shape, so the informative one wins.
  if (isUninformative(a)) return isUninformative(b) ? { type: 'any' } : b;
  if (isUninformative(b)) return a;
  // A null observation only means the value was sometimes null; the shape
  // survives, and `required` records that it was not always present.
  if (a.type === 'null') return b;
  if (b.type === 'null') return a;

  const numeric = isNumericType(a.type) && isNumericType(b.type);
  if (a.type !== b.type && !numeric) return null;

  const merged: JsonSchemaLike = { type: numeric && a.type !== b.type ? 'number' : a.type };
  // A format hint survives only when every observation agreed on it.
  if (a.description && a.description === b.description) merged.description = a.description;

  if (a.properties || b.properties) {
    const aProps = a.properties ?? {};
    const bProps = b.properties ?? {};
    const properties: Record<string, JsonSchemaLike> = {};
    for (const key of new Set([...Object.keys(aProps), ...Object.keys(bProps)])) {
      const av = aProps[key];
      const bv = bProps[key];
      properties[key] = av && bv ? mergeSchema(av, bv) : (av ?? bv)!;
    }
    merged.properties = properties;
    // Required only when both observations agreed the field was present.
    const required = (a.required ?? []).filter((key) => (b.required ?? []).includes(key));
    if (required.length) merged.required = required;
  }

  const items = a.items && b.items ? mergeSchema(a.items, b.items) : a.items ?? b.items;
  if (items) merged.items = items;

  return merged;
}

/** Drop identical variants so a union never repeats itself. */
function dedupe(schemas: JsonSchemaLike[]): JsonSchemaLike[] {
  const seen = new Set<string>();
  const out: JsonSchemaLike[] = [];
  for (const schema of schemas) {
    const key = JSON.stringify(schema);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(schema);
  }
  return out;
}

/**
 * A `format` hint for a string value, or nothing when it looks like prose. The
 * order matters: a timestamp contains a date, and an email contains an `@`, so
 * the more specific shapes are tested first.
 */
function stringFormatHint(value: string): Pick<JsonSchemaLike, 'description'> {
  if (UUID_RE.test(value)) return { description: 'uuid' };
  if (DATE_TIME_RE.test(value)) return { description: 'date-time' };
  if (DATE_RE.test(value)) return { description: 'date' };
  if (TIME_RE.test(value)) return { description: 'time' };
  if (DURATION_RE.test(value)) return { description: 'duration' };
  if (URI_RE.test(value)) return { description: 'uri' };
  if (EMAIL_RE.test(value)) return { description: 'email' };
  if (CURRENCY_CODES.has(value) || CURRENCY_AMOUNT_RE.test(value)) {
    return { description: 'currency' };
  }
  return {};
}

/** Whether a value already says enough about its shape to rule out an enum. */
function hasFormatHint(value: string): boolean {
  return stringFormatHint(value).description !== undefined;
}
