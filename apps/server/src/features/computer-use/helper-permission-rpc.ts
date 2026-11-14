import { basename } from "node:path";
import {
  type ComputerUseHelperPermissionStatus,
  computerUseHelperPermissionRequestKindSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";
import type { HelperProcessManager } from "./helper-manager.js";
import type { CuGateVerdict } from "./tools.js";

export type ComputerUseHelperRuntime =
  | { available: true; manager: HelperProcessManager }
  | { available: false; reason: string };

/**
 * 权限状态与重启只调用 Helper；主应用与 Node 进程不得再成为 TCC 授权主体。
 * Helper 缺失或启动失败时如实返回 unavailable，让设置页显示可处理的缺失原因。
 */
export function createHelperPermissionRpc(deps: {
  gate(): Promise<CuGateVerdict>;
  helper(): ComputerUseHelperRuntime;
}): CodeUiHostRpcHandler {
  return {
    async call(_actor, args) {
      z.tuple([
        z.string().min(1),
        z.string().nullish(),
        z.record(z.string(), z.unknown()).nullish(),
      ]).parse(args);
      const verdict = await deps.gate();
      if (!verdict.ok) return { available: false, reason: verdict.message };
      const helper = deps.helper();
      if (!helper.available) return { available: false, reason: helper.reason };
      const probe =
        ((args[2] as Record<string, unknown> | undefined)
          ?.includeFunctionalProbes ?? false) === true;
      try {
        const status = await helper.manager.status(probe);
        return toWebPermissionStatus(status);
      } catch (error) {
        return {
          available: false,
          reason: `Computer Use Helper 状态查询失败：${errorMessage(error)}`,
        };
      }
    },
  };
}

export function createHelperRestartRpc(deps: {
  gate(): Promise<CuGateVerdict>;
  helper(): ComputerUseHelperRuntime;
}): CodeUiHostRpcHandler {
  return {
    async call(_actor, args) {
      z.tuple([
        z.string().min(1).optional(),
        z.string().nullish(),
        z.record(z.string(), z.unknown()).nullish(),
      ]).parse(args);
      const verdict = await deps.gate();
      if (!verdict.ok) return { ok: false, reason: verdict.message };
      const helper = deps.helper();
      if (!helper.available) return { ok: false, reason: helper.reason };
      try {
        await helper.manager.restart();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Computer Use Helper 重启失败：${errorMessage(error)}`,
        };
      }
    },
  };
}

/**
 * 让 Helper 自己触发系统权限框。只有 Helper 进程被 TCC 记录后，用户授予的权限才会
 * 落在 Helper 上；主应用代弹不会产生这个效果。
 */
export function createHelperPermissionRequestRpc(deps: {
  gate(): Promise<CuGateVerdict>;
  helper(): ComputerUseHelperRuntime;
}): CodeUiHostRpcHandler {
  return {
    async call(_actor, args) {
      const [{ kind }] = z
        .tuple([
          z
            .object({
              kind: computerUseHelperPermissionRequestKindSchema,
            })
            .strict(),
        ])
        .parse(args);
      const verdict = await deps.gate();
      if (!verdict.ok) return { requested: false, reason: verdict.message };
      const helper = deps.helper();
      if (!helper.available) return { requested: false, reason: helper.reason };
      try {
        const result = await helper.manager.requestPermission(kind);
        return {
          requested: result.requested !== false,
          ...(typeof result.granted === "boolean"
            ? { granted: result.granted }
            : {}),
          ...(typeof result.reason === "string"
            ? { reason: result.reason }
            : {}),
        };
      } catch (error) {
        return {
          requested: false,
          reason: `Computer Use Helper 无法请求权限：${errorMessage(error)}`,
        };
      }
    },
  };
}

function toWebPermissionStatus(
  status: ComputerUseHelperPermissionStatus,
): Record<string, unknown> {
  return {
    available: true,
    platform: "darwin",
    grantOwner: status.grantOwner ?? status.helperPath,
    grantOwnerDisplayName: basename(status.helperPath, ".app"),
    accessibility: status.accessibility,
    ...(status.accessibilityProbeOk === undefined
      ? {}
      : { accessibilityProbeOk: status.accessibilityProbeOk }),
    screenRecording: status.screenRecording,
    ...(status.screenCaptureProbeOk === undefined
      ? {}
      : { screenCaptureProbeOk: status.screenCaptureProbeOk }),
    ...(status.automation === undefined
      ? {}
      : { automation: status.automation }),
    ...(status.reason === undefined ? {} : { reason: status.reason }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
