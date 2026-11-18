/**
 * CUA 控制租约与动作下发语义（Computer Use 插件）。
 *
 * - **单会话独占（controller lease）**：同一时刻只允许一个 run 持有桌面控制权，
 *   后来者报 `controller_busy`（不可重试，透出持有方让用户处置）——对齐 ZCode
 *   「另一个活跃会话 owns input」的事故语义；
 * - **actionSent**：动作失败必须区分「可能已到达 app」与「确定未下发」，
 *   前者只允许先重观察再决定（非幂等动作盲目重试 = 双击/双输）。
 */

export interface LeaseAcquireOk {
  ok: true;
  release: () => void;
}

export interface LeaseAcquireBusy {
  ok: false;
  code: "controller_busy";
  owner: string;
  retry: "never";
  message: string;
}

export type LeaseAcquire = LeaseAcquireOk | LeaseAcquireBusy;

export interface CuActionError extends Error {
  code: string;
  /** 动作是否可能已到达目标 app——决定重试档位。 */
  actionSent: boolean;
  retry: "reobserve" | "retry" | "never";
}

export function createCuLease(): {
  acquire(runId: string): LeaseAcquire;
  release(runId: string): void;
  current(): string | undefined;
} {
  let owner: string | undefined;

  const release = (runId: string): void => {
    // 只有持有方能释放；他人释放是 no-op（防串扰）
    if (owner === runId) {
      owner = undefined;
    }
  };

  return {
    acquire(runId: string): LeaseAcquire {
      if (owner !== undefined && owner !== runId) {
        return {
          ok: false,
          code: "controller_busy",
          owner,
          retry: "never",
          message: `桌面控制权正被会话 ${owner} 持有。请等它结束（或让用户停止该会话）后再试。`,
        };
      }
      owner = runId;
      return { ok: true, release: () => release(runId) };
    },
    release,
    current: () => owner,
  };
}

export function toActionSentError(input: {
  code: string;
  message: string;
  actionSent: boolean;
}): CuActionError {
  const error = new Error(input.message) as CuActionError;
  error.name = "CuActionError";
  error.code = input.code;
  error.actionSent = input.actionSent;
  // 已下发：动作可能已生效，先重观察确认现场再决定下一步；
  // 未下发：可安全重试。
  error.retry = input.actionSent ? "reobserve" : "retry";
  return error;
}
