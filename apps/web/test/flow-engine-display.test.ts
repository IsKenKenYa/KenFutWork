import type { FlowEngineStackContainer } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { resolveFlowEngineDisplayState } from "@/components/workbench/zcode/host/FlowSurface";

function container(service: string, state: string): FlowEngineStackContainer {
  return { service, name: `dify-${service}`, state, health: null, ports: [] };
}

function engineInfo(containers: FlowEngineStackContainer[], error?: string) {
  return {
    install: { state: "ready" as const, logTail: [] },
    stack: { containers, ...(error ? { error } : {}) },
  };
}

it("容器事实覆盖已结束的安装状态", () => {
  expect(resolveFlowEngineDisplayState("ready", engineInfo([]))).toBe("idle");
  expect(
    resolveFlowEngineDisplayState("ready", engineInfo([], "Docker 不可用")),
  ).toBe("unreachable");
  expect(
    resolveFlowEngineDisplayState(
      "ready",
      engineInfo([
        container("api", "exited"),
        container("db_postgres", "running"),
      ]),
    ),
  ).toBe("stopped");
});

it("初始化容器正常退出时仍可显示运行中的引擎", () => {
  const info = engineInfo([
    container("init_permissions", "exited"),
    container("api", "running"),
  ]);
  expect(resolveFlowEngineDisplayState("idle", info)).toBe("ready");
  expect(resolveFlowEngineDisplayState("installing", info)).toBe("installing");
});

it("手动停止后即使清单为空或 Docker 离线也可以手动启动", () => {
  const info = engineInfo([]);
  const stack = { ...info.stack, stoppedByUser: true as const };
  expect(resolveFlowEngineDisplayState("idle", { ...info, stack })).toBe(
    "stopped",
  );
  expect(
    resolveFlowEngineDisplayState("idle", {
      ...info,
      stack: { ...stack, error: "Docker 不可用" },
    }),
  ).toBe("stopped");
});
