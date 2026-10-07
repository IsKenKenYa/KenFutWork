export type ResourceDisposer = (() => void) | (() => Promise<void>);

/** 同步资源即时注销；遇异步资源等待真正完成，失败时保留该项供重试。 */
export function createResourceDisposer(
  stack: ResourceDisposer[],
  complete: () => void = () => {},
) {
  let pending: Promise<void> | undefined;
  return (): Promise<void> => {
    if (pending) return pending;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    pending = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const current = pending;
    const fail = (error: unknown) => {
      pending = undefined;
      reject(error);
    };
    const drain = () => {
      try {
        while (stack.length) {
          const result = stack[stack.length - 1]!();
          if (result && typeof result.then === "function") {
            void result.then(() => {
              stack.pop();
              drain();
            }, fail);
            return;
          }
          stack.pop();
        }
        complete();
        resolve();
      } catch (error) {
        fail(error);
      }
    };
    drain();
    return current;
  };
}
