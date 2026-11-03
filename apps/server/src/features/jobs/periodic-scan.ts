/**
 * 进程内周期扫描：`setInterval` 到点触发，上一轮没跑完就跳过，不叠加执行；
 * 单轮失败交给 `onError` 记录后继续下一轮。返回的函数停止定时器。
 */
export function startPeriodicScan(options: {
  scan: () => Promise<void>;
  onError?: (error: unknown) => void;
  /** 来自治理设置（设置页可调），调用方必须显式传入。 */
  intervalMs: number;
}): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void options
      .scan()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  // 后台维护定时器不阻止进程退出。
  timer.unref?.();
  return () => clearInterval(timer);
}
