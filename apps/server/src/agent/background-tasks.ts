/**
 * 统一后台任务注册表（DEC-15）：后台子代理与 Code 长命令共用同一份状态机。
 *
 * 职责边界：这里只管**状态与通知队列**，不管异步操作本身——派生方（task /
 * execute_background 工具）负责挂起 promise 并在结算时调 `settle`。三条不变量：
 * 1. 结算幂等，首次获胜（被 abort 的迟到回调不复活任务、不重复通知）；
 * 2. 通知按结算顺序出队（drain 清空），注入下一轮模型输入后不重放；
 * 3. `hasPending` 只看在跑任务——它是 run 轮末闸门（run 等全部结算）的唯一判据。
 *
 * 治理数值（并发上限等）由调用方从 settings 传入，本模块不读 env（DEC-18）。
 */

export type BackgroundTaskKind = "subagent" | "command";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface BackgroundTaskSnapshot {
  taskId: string;
  kind: BackgroundTaskKind;
  label: string;
  status: BackgroundTaskStatus;
  /** 结果摘要（终态填充，已由调用方截断）。 */
  summary?: string;
  /** 失败/取消时的下一步建议（DEC-17）。 */
  nextStep?: string;
  startedAt: string;
  endedAt?: string;
}

export interface BackgroundTaskNotification {
  taskId: string;
  kind: BackgroundTaskKind;
  label: string;
  status: "completed" | "failed" | "canceled";
  summary: string;
  nextStep?: string;
}

export type BackgroundTaskSettleOutcome = {
  status: "completed" | "failed" | "canceled";
  summary: string;
  nextStep?: string;
};

export interface BackgroundTaskRegistry {
  /**
   * 登记一个后台任务（即进入 running）。并发闸门超限时返回 `ok: false` 与
   * **模型可读**的拒绝理由（含当前上限与建议动作），不是错误码。
   */
  register(input: {
    kind: BackgroundTaskKind;
    label: string;
    /** 取消回调（如 AbortController.abort）；`abortAll` 时逐个调用。 */
    abort?: () => void;
  }): { ok: true; taskId: string } | { ok: false; error: string };

  /** 结算：终态落快照并进入通知队列。幂等，首次获胜。 */
  settle(taskId: string, outcome: BackgroundTaskSettleOutcome): void;

  /** 取出并清空已结算未消费的通知（按结算顺序）。 */
  drainNotifications(): BackgroundTaskNotification[];

  /** 是否还有在跑任务（run 轮末闸门的唯一判据）。 */
  hasPending(): boolean;

  /** 取消全部在跑任务：逐个调 abort、按 canceled 结算并入队通知。 */
  abortAll(reason: string): void;

  get(taskId: string): BackgroundTaskSnapshot | undefined;
  list(): BackgroundTaskSnapshot[];
}

export function createBackgroundTaskRegistry(options: {
  maxConcurrent: number;
  now?: () => Date;
  idFactory?: () => string;
}): BackgroundTaskRegistry {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const now = options.now ?? (() => new Date());
  const idFactory =
    options.idFactory ??
    (() =>
      `task_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);

  const tasks = new Map<string, BackgroundTaskSnapshot>();
  const aborts = new Map<string, () => void>();
  const pendingNotifications: BackgroundTaskNotification[] = [];

  return {
    register({ kind, label, abort }) {
      const running = [...tasks.values()].filter(
        (task) => task.status === "running",
      ).length;
      if (running >= maxConcurrent) {
        return {
          ok: false,
          error:
            `后台任务并发已满（${running}/${maxConcurrent}）。` +
            "请等在跑任务结算后再派生，或先用 task_output 读取已完成任务的结果、" +
            "直接沿用其结论而不派生新任务。",
        };
      }
      const taskId = idFactory();
      tasks.set(taskId, {
        taskId,
        kind,
        label,
        status: "running",
        startedAt: now().toISOString(),
      });
      if (abort) aborts.set(taskId, abort);
      return { ok: true, taskId };
    },

    settle(taskId, outcome) {
      const task = tasks.get(taskId);
      if (task?.status !== "running") return;
      task.status = outcome.status;
      task.summary = outcome.summary;
      if (outcome.nextStep !== undefined) task.nextStep = outcome.nextStep;
      task.endedAt = now().toISOString();
      aborts.delete(taskId);
      pendingNotifications.push({
        taskId: task.taskId,
        kind: task.kind,
        label: task.label,
        status: outcome.status,
        summary: outcome.summary,
        ...(outcome.nextStep !== undefined
          ? { nextStep: outcome.nextStep }
          : {}),
      });
    },

    drainNotifications() {
      return pendingNotifications.splice(0, pendingNotifications.length);
    },

    hasPending() {
      return [...tasks.values()].some((task) => task.status === "running");
    },

    abortAll(reason) {
      for (const [taskId, abort] of [...aborts]) {
        aborts.delete(taskId);
        try {
          abort();
        } catch {
          // 取消回调失败不阻断其余任务取消
        }
        const task = tasks.get(taskId);
        if (task?.status === "running") {
          this.settle(taskId, {
            status: "canceled",
            summary: `已取消（${reason}）`,
          });
        }
      }
    },

    get(taskId) {
      return tasks.get(taskId);
    },

    list() {
      return [...tasks.values()];
    },
  };
}
