import { describe, expect, it } from 'vitest';
import {
  inferSchemaFromBodies,
  inferSchemaFromBody,
  inferSchemaFromFrames,
  mergeSchema,
} from '../../src/core/schemaInference.js';
import type { JsonSchemaLike, WebSocketDirection, WebSocketFrame } from '../../src/types.js';

const UUID = '9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

/** The property map of an object schema, or an empty map. */
function props(schema: JsonSchemaLike | null): Record<string, JsonSchemaLike> {
  return schema?.properties ?? {};
}

function frame(direction: WebSocketDirection, payload: string): WebSocketFrame {
  return {
    direction,
    type: 'text',
    payloadSample: payload,
    size: payload.length,
    truncated: false,
    at: 0,
  };
}

describe('inferSchemaFromBodies', () => {
  it('returns null when no body is usable', () => {
    expect(inferSchemaFromBodies([null, undefined, '', 'not json'])).toBeNull();
  });

  it('returns a single body unchanged', () => {
    expect(inferSchemaFromBodies(['{"a":1}'])).toEqual(inferSchemaFromBody('{"a":1}'));
  });

  it('unions the fields of every sample', () => {
    const schema = inferSchemaFromBodies(['{"a":1}', '{"b":"x"}']);
    expect(Object.keys(props(schema)).sort()).toEqual(['a', 'b']);
    expect(props(schema)['a']).toEqual({ type: 'integer' });
    expect(props(schema)['b']).toEqual({ type: 'string' });
  });

  it('requires a field only when every sample had it', () => {
    const schema = inferSchemaFromBodies(['{"a":1,"b":2}', '{"a":3}']);
    expect(schema?.required).toEqual(['a']);
  });

  it('omits `required` entirely when no field is shared', () => {
    expect(inferSchemaFromBodies(['{"a":1}', '{"b":2}'])?.required).toBeUndefined();
  });

  it('widens integer and number to number', () => {
    expect(props(inferSchemaFromBodies(['{"n":1}', '{"n":1.5}']))['n']).toEqual({ type: 'number' });
  });

  it('represents conflicting types as a union', () => {
    const schema = inferSchemaFromBodies(['{"v":"x"}', '{"v":2}']);
    expect(props(schema)['v']).toEqual({ oneOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('accumulates a union across three or more samples', () => {
    const schema = inferSchemaFromBodies(['{"v":"x"}', '{"v":1}', '{"v":true}']);
    expect(props(schema)['v']?.oneOf?.map((variant) => variant.type)).toEqual([
      'string',
      'integer',
      'boolean',
    ]);
  });

  it('merges nested objects rather than replacing them', () => {
    const schema = inferSchemaFromBodies(['{"o":{"a":1}}', '{"o":{"b":2}}']);
    expect(Object.keys(props(props(schema)['o']!)).sort()).toEqual(['a', 'b']);
  });

  it('merges array items across samples', () => {
    const schema = inferSchemaFromBodies(['{"t":[{"a":1}]}', '{"t":[{"b":2}]}']);
    expect(Object.keys(props(props(schema)['t']!.items!)).sort()).toEqual(['a', 'b']);
  });

  it('keeps the informative shape when one sample is null', () => {
    const schema = inferSchemaFromBodies(['{"v":null}', '{"v":"x"}']);
    expect(props(schema)['v']).toEqual({ type: 'string' });
    // A null sample does not count as the field being present.
    expect(schema?.required).toBeUndefined();
  });

  it('drops a format hint the samples disagree on', () => {
    const disagreed = inferSchemaFromBodies([`{"id":"${UUID}"}`, '{"id":"plain"}']);
    expect(props(disagreed)['id']).toEqual({ type: 'string' });

    const agreed = inferSchemaFromBodies([`{"id":"${UUID}"}`, `{"id":"${UUID}"}`]);
    expect(props(agreed)['id']).toEqual({ type: 'string', description: 'uuid' });
  });
});

describe('mergeSchema', () => {
  it('lets a known shape win over an uninformative one', () => {
    expect(mergeSchema({ type: 'any' }, { type: 'string' })).toEqual({ type: 'string' });
    expect(mergeSchema({ type: 'string' }, { type: 'any' })).toEqual({ type: 'string' });
  });

  it('adds a conflicting type to an existing union', () => {
    const merged = mergeSchema(
      { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      { type: 'boolean' },
    );
    expect(merged.oneOf?.map((variant) => variant.type)).toEqual(['string', 'integer', 'boolean']);
  });

  it('absorbs a compatible type into an existing variant', () => {
    const merged = mergeSchema(
      { oneOf: [{ type: 'number' }, { type: 'boolean' }] },
      { type: 'integer' },
    );
    expect(merged.oneOf?.map((variant) => variant.type)).toEqual(['number', 'boolean']);
  });

  it('does not grow a union when a type repeats', () => {
    const merged = mergeSchema(
      { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      { type: 'integer' },
    );
    expect(merged.oneOf?.map((variant) => variant.type)).toEqual(['string', 'integer']);
  });
});

describe('inferSchemaFromFrames', () => {
  it('merges only the frames of the requested direction', () => {
    const schema = inferSchemaFromFrames(
      [frame('sent', '{"a":1}'), frame('received', '{"z":9}'), frame('sent', '{"b":2}')],
      'sent',
    );
    expect(Object.keys(props(schema)).sort()).toEqual(['a', 'b']);
  });

  it('requires a message field only when every frame had it', () => {
    const schema = inferSchemaFromFrames(
      [frame('received', '{"type":"welcome"}'), frame('received', '{"type":"ack","id":7}')],
      'received',
    );
    expect(schema?.required).toEqual(['type']);
  });

  it('returns null when the direction has no JSON frame', () => {
    expect(inferSchemaFromFrames([frame('sent', '{"a":1}')], 'received')).toBeNull();
  });
});
