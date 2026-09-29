import { describe, expect, it } from 'vitest';
import { toOpenApiSchema } from '../../src/reporters/openapi.js';

describe('toOpenApiSchema', () => {
  it('maps a plain schema, including nested fields and format hints', () => {
    expect(
      toOpenApiSchema({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'uuid' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    });
  });

  it('carries a merged union through as oneOf', () => {
    expect(
      toOpenApiSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }] }),
    ).toEqual({ oneOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('renders a null schema as a nullable string', () => {
    expect(toOpenApiSchema({ type: 'null' })).toEqual({ type: 'string', nullable: true });
  });

  it('returns an empty object for no schema at all', () => {
    expect(toOpenApiSchema(null)).toEqual({});
  });
});
