import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseWindowsResponse, WindowsHost } from "./windows-host.js";

// 用真实子进程充当后端：验证进程复用、串行、退出与超时行为，不使用 mock。
const BACKEND = `
const readline = require("node:readline");
const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
  if (request.operation === "hang") return;
  if (request.operation === "crash") {
    process.stderr.write("backend crashed");
    process.exit(3);
  }
  if (request.operation === "slow") {
    setTimeout(() => send({ ok: true, id: request.id, result: { pid: process.pid, echo: request.operation } }), 120);
    return;
  }
  if (request.operation === "noisy") process.stdout.write("starting back\\n");
  send({ ok: true, id: request.id, result: { pid: process.pid, echo: request.operation } });
});
`;

const BOOT_FAILURE = `
process.stdout.write(JSON.stringify({ ok: false, error: "permission_denied: 没有可交互Windows登录桌面" }) + "\\n");
process.exit(1);
`;

function createHost(script = BACKEND) {
  return new WindowsHost(() =>
    spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

describe("parseWindowsResponse（后端输出解析）", () => {
  it("解析正常 JSON 结果", () => {
    expect(
      parseWindowsResponse('{"ok":true,"result":{"accessibility":"granted"}}'),
    ).toEqual({ ok: true, result: { accessibility: "granted" } });
  });

  it("容忍 UTF-8 BOM 与 JSON 前的杂讯", () => {
    expect(
      parseWindowsResponse('\uFEFF警告：首次编译\n{"ok":true,"result":1}\n'),
    ).toEqual({ ok: true, result: 1 });
  });

  it("容忍 JSON 后追加的杂讯", () => {
    expect(parseWindowsResponse('{"ok":true,"result":2} trailing')).toEqual({
      ok: true,
      result: 2,
    });
  });

  it("空输出与纯空白抛出可读错误", () => {
    expect(() => parseWindowsResponse("")).toThrow("stdout 中没有 JSON 对象");
    expect(() => parseWindowsResponse("   \r\n")).toThrow(
      "stdout 中没有 JSON 对象",
    );
  });

  it("非 JSON 输出抛出", () => {
    expect(() => parseWindowsResponse("not json")).toThrow(
      "stdout 中没有 JSON 对象",
    );
  });

  it("错误响应保留错误文本与 actionSent", () => {
    expect(
      parseWindowsResponse(
        '{"ok":false,"error":"element_stale: 窗口已变化","actionSent":false}',
      ),
    ).toEqual({
      ok: false,
      error: "element_stale: 窗口已变化",
      actionSent: false,
    });
  });
});

describe("WindowsHost（常驻后端客户端）", () => {
  it("复用同一个后端进程连续执行请求", async () => {
    const host = createHost();
    try {
      const first = await host.call<{ pid: number; echo: string }>(
        { operation: "apps" },
        { timeoutMs: 5000 },
      );
      const second = await host.call<{ pid: number; echo: string }>(
        { operation: "windows" },
        { timeoutMs: 5000 },
      );
      expect(first.ok).toBe(true);
      expect(first.result?.pid).toBe(second.result?.pid);
      expect(second.result?.echo).toBe("windows");
    } finally {
      await host.stop();
    }
  });

  it("串行执行：后一个请求等前一个完成", async () => {
    const host = createHost();
    const order: string[] = [];
    try {
      const slow = host
        .call({ operation: "slow" }, { timeoutMs: 5000 })
        .then(() => order.push("slow"));
      const fast = host
        .call({ operation: "apps" }, { timeoutMs: 5000 })
        .then(() => order.push("fast"));
      await Promise.all([slow, fast]);
      expect(order).toEqual(["slow", "fast"]);
    } finally {
      await host.stop();
    }
  });

  it("超时按 native_timeout 失败，下一次调用重新拉起进程", async () => {
    const host = createHost();
    try {
      const first = await host.call<{ pid: number }>(
        { operation: "apps" },
        { timeoutMs: 5000 },
      );
      await expect(
        host.call({ operation: "hang" }, { timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: "native_timeout" });
      const next = await host.call<{ pid: number }>(
        { operation: "apps" },
        { timeoutMs: 5000 },
      );
      expect(next.result?.pid).not.toBe(first.result?.pid);
    } finally {
      await host.stop();
    }
  });

  it("后端退出时报告退出码与 stderr", async () => {
    const host = createHost();
    try {
      await expect(
        host.call({ operation: "crash" }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({
        code: "native_failed",
        message: expect.stringMatching(/退出：3.*backend crashed/u),
      });
    } finally {
      await host.stop();
    }
  });

  it("取消信号立即结束等待，之后仍可重新拉起", async () => {
    const host = createHost();
    try {
      await expect(
        host.call(
          { operation: "hang" },
          { timeoutMs: 5000, signal: AbortSignal.timeout(100) },
        ),
      ).rejects.toMatchObject({ code: "cancelled" });
      const next = await host.call<{ echo: string }>(
        { operation: "apps" },
        { timeoutMs: 5000 },
      );
      expect(next.result?.echo).toBe("apps");
    } finally {
      await host.stop();
    }
  });

  it("忽略启动杂讯行", async () => {
    const host = createHost();
    try {
      const response = await host.call<{ echo: string }>(
        { operation: "noisy" },
        { timeoutMs: 5000 },
      );
      expect(response.result?.echo).toBe("noisy");
    } finally {
      await host.stop();
    }
  });

  it("启动错误行（无 id）立即使当前等待失败", async () => {
    const host = createHost(BOOT_FAILURE);
    try {
      await expect(
        host.call({ operation: "status" }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    } finally {
      await host.stop();
    }
  });
});
