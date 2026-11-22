/**
 * 同键串行写入器：同一键的写入按调用顺序依次执行（后写覆盖先写，避免乱序落盘），
 * 跨键互不阻塞；单次失败不阻断后续写入，链在最后一次写入落定后清理。
 */
export type SerializedKeyWrite = (
  key: string,
  write: () => Promise<unknown>,
  onError?: (err: unknown) => void,
) => Promise<void>;

export function createSerializedKeyWriter(): SerializedKeyWrite {
  const chains = new Map<string, Promise<void>>();
  return (key, write, onError) => {
    const task = (chains.get(key) ?? Promise.resolve())
      .then(() => write())
      .then(
        () => undefined,
        (err: unknown) => {
          onError?.(err);
        },
      );
    chains.set(key, task);
    void task.then(() => {
      if (chains.get(key) === task) chains.delete(key);
    });
    return task;
  };
}
