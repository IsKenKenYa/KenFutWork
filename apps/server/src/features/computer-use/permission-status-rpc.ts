import { z } from "zod";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";
import type { LocalActor } from "../local-instance/types.js";
import type { ComputerUseExecutor } from "./executor.js";
import type { CuGateVerdict } from "./tools.js";

/** 原权限service消费本机preflight，设置页不触发截图或输入。 */
export function createMacosPermissionStatusRpc(deps: {
  gate(): Promise<CuGateVerdict>;
  executor(): ComputerUseExecutor;
  timeoutMs(actor: LocalActor): Promise<number>;
}): CodeUiHostRpcHandler {
  return {
    async call(actor, args) {
      // 原RPC的undefined数组项经JSON传输会变成null。
      z.tuple([
        z.string().min(1),
        z.string().nullish(),
        z.record(z.string(), z.unknown()).nullish(),
      ]).parse(args);
      const verdict = await deps.gate();
      const executor = deps.executor();
      if (!verdict.ok || !executor.available) {
        return {
          available: false,
          reason: !verdict.ok ? verdict.message : executor.unavailableReason,
        };
      }
      const timeoutMs = await deps.timeoutMs(actor);
      const status = await executor.accessStatus({
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs,
      });
      const state = (value: string) =>
        value === "granted" || value === "denied" ? value : "unknown";
      return {
        available: true,
        platform: "darwin",
        grantOwner: null,
        // AX和事件注入共用辅助功能面板，任一未获准都不能控制桌面。
        accessibility: state(
          status.accessibility === "granted" && status.postEvents === "denied"
            ? "denied"
            : status.accessibility,
        ),
        screenRecording: state(status.screen),
        reason: status.hint,
      };
    },
  };
}
