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
    expect(props(inferSchemaFromBodies(['{"n":1}', '{"n":1.5}']))['n']).toEqual({
      type: 'number',
      minimum: 1,
      maximum: 1.5,
    });
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

  it('tags ISO-8601 timestamps, durations, and currencies', () => {
    const schema = inferSchemaFromBodies([
      '{"at":"2026-01-01T09:30:00.000Z","day":"2026-01-01","clock":"09:30:00",' +
        '"ttl":"PT1H30M","code":"USD","amount":"$1,299.00"}',
    ]);
    expect(props(schema)['at']).toEqual({ type: 'string', description: 'date-time' });
    expect(props(schema)['day']).toEqual({ type: 'string', description: 'date' });
    expect(props(schema)['clock']).toEqual({ type: 'string', description: 'time' });
    expect(props(schema)['ttl']).toEqual({ type: 'string', description: 'duration' });
    expect(props(schema)['code']).toEqual({ type: 'string', description: 'currency' });
    expect(props(schema)['amount']).toEqual({ type: 'string', description: 'currency' });
  });

  it('does not mistake ordinary words for durations or currencies', () => {
    const schema = inferSchemaFromBodies(['{"a":"PT","b":"P","c":"Cat","d":"try"}']);
    expect(props(schema)['a']).toEqual({ type: 'string' });
    expect(props(schema)['b']).toEqual({ type: 'string' });
    expect(props(schema)['c']).toEqual({ type: 'string' });
    expect(props(schema)['d']).toEqual({ type: 'string' });
  });

  it('collects a small closed set of strings into an enum', () => {
    const schema = inferSchemaFromBodies([
      '{"status":"shipped"}',
      '{"status":"processing"}',
      '{"status":"shipped"}',
    ]);
    expect(props(schema)['status']).toEqual({
      type: 'string',
      enum: ['shipped', 'processing'],
    });
  });

  it('does not call prose or an identifier-shaped value an enum', () => {
    const prose = inferSchemaFromBodies(['{"name":"Widget 1"}', '{"name":"Widget 2"}']);
    expect(props(prose)['name']).toEqual({ type: 'string' });

    // Two uuids still describe a uuid field, not a closed set of two values.
    const uuid = inferSchemaFromBodies([
      `{"id":"${UUID}"}`,
      '{"id":"9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5c"}',
    ]);
    expect(props(uuid)['id']).toEqual({ type: 'string', description: 'uuid' });
  });

  it('gives up on an enum once the set grows too large', () => {
    const bodies = Array.from({ length: 11 }, (_, i) => `{"state":"s${i}"}`);
    const schema = inferSchemaFromBodies(bodies);
    expect(props(schema)['state']).toEqual({ type: 'string' });
  });

  it('derives numeric bounds from the observed range', () => {
    const schema = inferSchemaFromBodies(['{"price":9.99}', '{"price":12.5}', '{"price":4.5}']);
    expect(props(schema)['price']).toEqual({ type: 'number', minimum: 4.5, maximum: 12.5 });
  });

  it('omits bounds when every sample held the same number', () => {
    const schema = inferSchemaFromBodies(['{"total":2}', '{"total":2}']);
    expect(props(schema)['total']).toEqual({ type: 'integer' });
  });

  it('annotates array items across every element and sample', () => {
    const schema = inferSchemaFromBodies(['{"tags":["tools","sale"]}', '{"tags":["tools","new"]}']);
    expect(props(schema)['tags']!.items).toEqual({
      type: 'string',
      enum: ['tools', 'sale', 'new'],
    });
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
