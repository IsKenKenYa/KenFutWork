import { describe, expect, it } from "vitest";

import { createCuLease, toActionSentError } from "./lease.js";

describe("createCuLease（run 级单会话独占）", () => {
  it("首个 run 获得租约；持有期间第二个 run 报 controller_busy 并透出持有方", () => {
    const lease = createCuLease();
    expect(lease.acquire("run-A").ok).toBe(true);
    const second = lease.acquire("run-B");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("controller_busy");
      expect(second.owner).toBe("run-A");
      expect(second.retry).toBe("never");
    }
  });

  it("释放后可被下一个 run 获取；重复释放幂等", () => {
    const lease = createCuLease();
    lease.acquire("run-A");
    lease.release("run-A");
    lease.release("run-A");
    expect(lease.acquire("run-B").ok).toBe(true);
  });

  it("非持有方不能释放他人的租约", () => {
    const lease = createCuLease();
    lease.acquire("run-A");
    lease.release("run-B");
    expect(lease.current()).toBe("run-A");
  });

  it("current 反映持有方与空态", () => {
    const lease = createCuLease();
    expect(lease.current()).toBeUndefined();
    lease.acquire("run-A");
    expect(lease.current()).toBe("run-A");
  });
});

describe("toActionSentError（可能已下发的失败语义）", () => {
  it("底层报错时带上 actionSent 与 retry 档位", () => {
    const err = toActionSentError({
      code: "timeout",
      message: "点击超时",
      actionSent: true,
    });
    expect(err.code).toBe("timeout");
    expect(err.actionSent).toBe(true);
    // 已下发的动作不允许盲目重试（非幂等）
    expect(err.retry).toBe("reobserve");
  });

  it("未下发（actionSent:false）才允许 retry", () => {
    const err = toActionSentError({
      code: "launch_failed",
      message: "应用启动失败",
      actionSent: false,
    });
    expect(err.retry).toBe("retry");
  });
});
