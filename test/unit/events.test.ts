import { describe, expect, it } from 'vitest';
import { createEventHandle } from '../../src/core/events.js';

describe('createEventHandle', () => {
  it('is awaitable and iterable, ending the stream with the finish event', async () => {
    const handle = createEventHandle<number, string>(
      async (emit) => {
        emit('a');
        emit('b');
        return 7;
      },
      (result) => `done:${result}`,
    );

    const seen: string[] = [];
    for await (const event of handle) seen.push(event);

    expect(seen).toEqual(['a', 'b', 'done:7']);
    // The very same handle still resolves to the result.
    await expect(handle).resolves.toBe(7);
  });

  it('buffers events emitted before anyone iterates', async () => {
    const handle = createEventHandle<number, string>(
      async (emit) => {
        emit('early');
        return 1;
      },
      () => 'done',
    );

    await expect(handle).resolves.toBe(1);
    const seen: string[] = [];
    for await (const event of handle) seen.push(event);

    expect(seen).toEqual(['early', 'done']);
  });

  it('surfaces a failure through both await and the iterator', async () => {
    const handle = createEventHandle<number, string>(
      async () => {
        throw new Error('boom');
      },
      () => 'done',
    );

    await expect(handle).rejects.toThrow('boom');

    const consume = async (): Promise<string[]> => {
      const seen: string[] = [];
      for await (const event of handle) seen.push(event);
      return seen;
    };
    await expect(consume()).rejects.toThrow('boom');
  });

  it('resolves without an iterator ever attaching', async () => {
    const handle = createEventHandle<number, string>(
      async (emit) => {
        emit('x');
        return 3;
      },
      () => 'done',
    );

    expect(await handle).toBe(3);
  });
});
