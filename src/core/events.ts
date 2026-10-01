/**
 * A promise that is also an async iterator.
 *
 * `scan()` has to serve two callers with one call: the one that wants the
 * finished result (`await scan(opts)`) and the one that wants to watch it happen
 * (`for await (const event of scan(opts))`). Rather than run the scan twice, the
 * handle is a real promise with an iterator attached, backed by a queue. The
 * scan pushes events as they occur; an iterator drains the queue and blocks when
 * it is empty. A caller that only awaits still gets the result, and the events
 * it never read are simply dropped when the handle is collected.
 *
 * The run function's rejection is rethrown by `await` *and* by the iterator, and
 * a defensive `catch` keeps an unattended rejection from surfacing as an
 * unhandled rejection when the caller only ever iterates.
 */

export interface EventHandle<T, E> extends Promise<T> {
  [Symbol.asyncIterator](): AsyncIterator<E>;
}

export function createEventHandle<T, E>(
  run: (emit: (event: E) => void) => Promise<T>,
  finish: (result: T) => E,
): EventHandle<T, E> {
  const queue: E[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failed = false;
  let failure: unknown = null;

  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const emit = (event: E): void => {
    queue.push(event);
    notify();
  };

  const promise = (async (): Promise<T> => {
    try {
      const result = await run(emit);
      emit(finish(result));
      return result;
    } catch (err) {
      failed = true;
      failure = err;
      throw err;
    } finally {
      finished = true;
      notify();
    }
  })();

  // An iterator that never awaits the handle must not leave the rejection
  // unobserved.
  promise.catch(() => {});

  const iterator = async function* (): AsyncGenerator<E> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as E;
      if (finished) {
        if (failed) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  const handle = promise as EventHandle<T, E>;
  Object.defineProperty(handle, Symbol.asyncIterator, { value: iterator, enumerable: false });
  return handle;
}
