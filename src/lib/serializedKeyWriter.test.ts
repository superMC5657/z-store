import { describe, expect, it, vi } from 'vitest';
import { createSerializedKeyWriter } from './serializedKeyWriter';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSerializedKeyWriter', () => {
  it('同键按调用顺序串行，跨键并行', async () => {
    const write = createSerializedKeyWriter();
    const order: string[] = [];
    const first = deferred();
    const a1 = write('a', async () => {
      await first.promise;
      order.push('a1');
    });
    const a2 = write('a', async () => {
      order.push('a2');
    });
    const b1 = write('b', async () => {
      order.push('b1');
    });
    await b1;
    expect(order).toEqual(['b1']);
    first.resolve();
    await Promise.all([a1, a2]);
    expect(order).toEqual(['b1', 'a1', 'a2']);
  });

  it('失败交给 onError 且不阻断后续写入', async () => {
    const write = createSerializedKeyWriter();
    const onError = vi.fn();
    const second = vi.fn(async () => {});
    await expect(write('k', () => Promise.reject(new Error('disk')), onError)).resolves.toBeUndefined();
    await write('k', second);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk' }));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
