/**
 * 流空闲看门狗（stream idle watchdog）。
 *
 * 背景（GUI 实测复现）：上游（one-api 代理 + glm）偶发「首 token 后停滞」——
 * LangChain 的流不再产出任何事件，消费侧的 `for await` 永久阻塞，run 卡在
 * running 数分钟；更糟的是此时**取消也不生效**：中止信号只在「下一个事件到达」
 * 后才被检查，而事件永远不会到，用户只能重启进程。
 *
 * 修法：把「取下一个事件」这一步与**空闲超时**和**中止信号**赛跑，二者任一
 * 先到即结束等待：
 * - 空闲超时 → 抛 `StreamIdleTimeoutError`，本轮按有界失败收尾（不再无限挂），
 *   同时回调 `onIdle` 中止底层请求（释放上游连接）；
 * - 中止 → 结束迭代，适配器照旧走 canceled 分支（界面「停止」按钮真正生效）。
 *
 * 阈值依据：流事件在工具执行期间也会发（tools 的 start/end），最长静默发生在
 * 单个工具执行期间——沙箱命令超时为 120s，故默认 180s 留出余量。
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/** 面向用户的错误（文案可直接展示）：error-sanitizer 据此透传而非套用通用文案。 */
export class StreamIdleTimeoutError extends Error {
  readonly exposeToClient = true;

  constructor(readonly idleMs: number) {
    super(
      `模型流已 ${Math.round(idleMs / 1000)} 秒没有任何输出（上游停滞），本轮已终止。请重试或更换模型。`,
    );
    this.name = "StreamIdleTimeoutError";
  }
}

export interface StreamIdleGuardOptions {
  /** 空闲上限（毫秒）；<= 0 或非有限值表示不启用超时。 */
  idleMs?: number;
  signal?: AbortSignal;
  /** 空闲超时触发时调用（用于中止底层请求）。抛错不影响终止。 */
  onIdle?: () => void;
}

const ABORTED = Symbol("stream-aborted");

type Step<T> =
  | { kind: "value"; value: T }
  | { kind: "end" }
  | { kind: "aborted" };

async function stepWithGuard<T>(
  iterator: AsyncIterator<T>,
  idleMs: number,
  options: StreamIdleGuardOptions,
): Promise<Step<T>> {
  const signal = options.signal;
  if (signal?.aborted) {
    return { kind: "aborted" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  /** 停滞错误：`onIdle` 会中止同一信号，须让「停滞」优先于「取消」胜出。 */
  let idleError: StreamIdleTimeoutError | undefined;
  try {
    const racers: Array<Promise<IteratorResult<T> | typeof ABORTED>> = [
      iterator.next(),
    ];

    if (idleMs > 0 && Number.isFinite(idleMs)) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            idleError = new StreamIdleTimeoutError(idleMs);
            try {
              options.onIdle?.();
            } catch {
              // 中止回调失败不改变「本轮已停滞」的结论
            }
            reject(idleError);
          }, idleMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      );
    }

    if (signal) {
      racers.push(
        new Promise<typeof ABORTED>((resolve) => {
          onAbort = () => resolve(ABORTED);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }

    const result = await Promise.race(racers);
    if (result === ABORTED) {
      // onIdle 中止了同一信号：这是「上游停滞」而非「用户取消」，语义不能混
      if (idleError) {
        throw idleError;
      }
      return { kind: "aborted" };
    }
    return result.done
      ? { kind: "end" }
      : { kind: "value", value: result.value };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * 把源迭代器包成「空闲超时 + 中止可控」的迭代器。
 * 超时抛 `StreamIdleTimeoutError`；中止/下游提前退出则以正常结束收场
 * （调用方据 `signal.aborted` 判定是取消而非完成）。
 */
export async function* withStreamIdleGuard<T>(
  source: AsyncIterable<T>,
  options: StreamIdleGuardOptions = {},
): AsyncGenerator<T> {
  const idleMs = options.idleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = await stepWithGuard(iterator, idleMs, options);
      if (step.kind !== "value") {
        return;
      }
      yield step.value;
    }
  } finally {
    // 提前退出（超时/中止/下游 break）时释放上游
    try {
      await iterator.return?.();
    } catch {
      // 上游清理失败不影响收尾
    }
  }
}
