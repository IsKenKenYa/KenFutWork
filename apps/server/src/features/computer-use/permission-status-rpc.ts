import { z } from "zod";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";
import type { LocalActor } from "../local-instance/types.js";
import type { ComputerUseExecutor } from "./executor.js";
import {
  buildPermissionStatus,
  resolveGrantOwner,
} from "./permission-status.js";
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
      // 授权主体取自当前进程所在的应用包：设置页要告诉用户勾选哪个应用，
      // 前端缓存也要求它是字符串（null 会让整条缓存判失效）。
      return buildPermissionStatus({
        accessibility: status.accessibility,
        screen: status.screen,
        postEvents: status.postEvents,
        automation: status.automation,
        hint: status.hint,
        owner: resolveGrantOwner(process.execPath),
      });
    },
  };
}
