/** Infer a compact JSON-Schema-like shape from sample payloads (depth-capped). */

import type { JsonSchemaLike, WebSocketDirection, WebSocketFrame } from '../types.js';

const MAX_DEPTH = 4;
const MAX_PROPERTIES = 50;

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
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return inferSchema(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Infer one schema from several sample bodies, so the result describes every
 * observation rather than whichever body happened to come first. A field seen
 * in any sample is present, and it is `required` only when every sample had it.
 * Bodies that are absent or not JSON contribute nothing; the result is null
 * when no usable body was seen.
 */
export function inferSchemaFromBodies(
  bodies: readonly (string | null | undefined)[],
): JsonSchemaLike | null {
  let merged: JsonSchemaLike | null = null;
  for (const body of bodies) {
    const schema = inferSchemaFromBody(body);
    if (!schema) continue;
    merged = merged ? mergeSchema(merged, schema) : schema;
  }
  return merged;
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

function stringFormatHint(value: string): Pick<JsonSchemaLike, 'description'> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return { description: 'uuid' };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return { description: 'date-time' };
  if (/^https?:\/\//.test(value)) return { description: 'uri' };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { description: 'email' };
  return {};
}
