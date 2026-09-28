/** Infer a compact JSON-Schema-like shape from sample payloads (depth-capped). */

import type { JsonSchemaLike } from '../types.js';

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

function stringFormatHint(value: string): Pick<JsonSchemaLike, 'description'> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return { description: 'uuid' };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return { description: 'date-time' };
  if (/^https?:\/\//.test(value)) return { description: 'uri' };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { description: 'email' };
  return {};
}
