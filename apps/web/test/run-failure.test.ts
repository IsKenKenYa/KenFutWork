import { describe, expect, it } from "vitest";

import {
  ACK_POLL_MS,
  ACK_TIMEOUT_MS,
  decideAckTimeout,
  describeRunFailure,
  GENERIC_RUN_FAILURE_TEXT,
} from "../src/lib/run-failure.js";

/**
 * 回归：`run.failed` 曾把服务端给的可读原因整个丢掉，只显示固定的
 * 「运行失败，请重试。」——用户因此不知道是上游停滞、要换模型，还是没绑定项目。
 */
describe("run.failed 的失败说明", () => {
  it("透出服务端 error.message（上游停滞这类原因要能读到）", () => {
    expect(
      describeRunFailure({
        type: "run.failed",
        error: {
          code: "run_failed",
          message: "模型流已 180 秒没有任何输出（上游停滞），本轮已终止。",
        },
      }),
    ).toBe("模型流已 180 秒没有任何输出（上游停滞），本轮已终止。");
  });

  it("透出「未绑定项目」这类可操作原因", () => {
    expect(
      describeRunFailure({
        error: {
          code: "run_failed",
          message:
            "canvasId is required for production (state) backend mode. Each agent run must be scoped to a project.",
        },
      }),
    ).toContain("canvasId is required");
  });

  it("原因两侧空白被裁掉", () => {
    expect(describeRunFailure({ error: { message: "  失败原因  " } })).toBe(
      "失败原因",
    );
  });

  it("缺原因/形状异常 → 回落到通用文案（不显示空白气泡）", () => {
    expect(describeRunFailure(undefined)).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure(null)).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({})).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({ error: {} })).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({ error: { message: "" } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure({ error: { message: "   " } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure({ error: { message: 42 } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure("boom")).toBe(GENERIC_RUN_FAILURE_TEXT);
  });

  it("有错误码但没文案时带上错误码（不再只说「运行失败」）", () => {
    expect(describeRunFailure({ error: { code: "run_failed" } })).toBe(
      `${GENERIC_RUN_FAILURE_TEXT}（错误码 run_failed）`,
    );
  });

  /** 服务端的「通用文案 + 原始错误」要原样进对话气泡（用户要求能看到上游原文）。 */
  it("多行原文（通用文案 + 原始错误）原样透出", () => {
    const message =
      'AI 服务暂时不可用，请稍后重试。\n\n原始错误：400 {"error":{"message":"model not found"}}';
    expect(describeRunFailure({ error: { code: "run_failed", message } })).toBe(
      message,
    );
  });
});

/**
 * 回归背景（自建等效实例 + 真实模型实测）：服务端那侧连接已注销、客户端这侧 socket
 * 还开着（半开连接）时，`ws.connected` 仍是 true、命令发得出去、服务端真的把 run 跑了，
 * 但 ack 与随后所有事件都推不回来。旧实现在 12 秒后直接报「请求未被确认，请重试。」
 * ——用户照着提示重发会造出**重复 run**，而那一轮其实已经在执行。
 */
describe("ack 超时的处置口径", () => {
  it("还没到总上限且「看着连着」→ 换一条连接，不报失败", () => {
    expect(
      decideAckTimeout({ connected: true, waitedMs: ACK_TIMEOUT_MS }),
    ).toEqual({ action: "reconnect" });
    expect(
      decideAckTimeout({ connected: true, waitedMs: ACK_TIMEOUT_MS * 3 }),
    ).toEqual({ action: "reconnect" });
  });

  it("连接断着 → 继续等（服务端按 lastSeq 重放，本轮能自己接上）", () => {
    expect(
      decideAckTimeout({ connected: false, waitedMs: ACK_TIMEOUT_MS }),
    ).toEqual({ action: "wait" });
  });

  it("到了总上限才判失败，且「服务端没确认」与「连接没恢复」分开说", () => {
    expect(
      decideAckTimeout({
        connected: true,
        waitedMs: 90_000,
        maxWaitMs: 90_000,
      }),
    ).toEqual({ action: "fail", text: "请求未被确认，请重试。" });
    const offline = decideAckTimeout({
      connected: false,
      waitedMs: 90_000,
      maxWaitMs: 90_000,
    });
    expect(offline.action).toBe("fail");
    if (offline.action !== "fail") return;
    expect(offline.text).toContain("连接长时间未恢复");
  });

  it("节拍常量是正整数（免得 0 间隔把定时器打成忙等）", () => {
    expect(ACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ACK_POLL_MS).toBeGreaterThan(0);
    expect(ACK_POLL_MS).toBeLessThan(ACK_TIMEOUT_MS);
  });
});
