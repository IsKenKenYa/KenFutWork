import type { OpenDesignHostStatusResponse } from "@kenfutwork/shared";

import {
  type OpenDesignCompanionSnapshot,
  resolveOpenDesignCarrierMode,
} from "./companion.js";

/**
 * 探活超时。
 *
 * OpenDesign 的承载是**独立服务**（自托管 Docker 栈 / 桌面 sidecar），不是本进程内的能力，
 * 所以「配了地址」不等于「能用」。这里做一次真实可达性探测，并且必须**快速**给出结论——
 * status 是前端门控的同步依赖，探不通时要把原因写清楚而不是把面板挂起。
 */
export const OPEN_DESIGN_PROBE_TIMEOUT_MS = 1500;

/**
 * 探活打上游免鉴权健康端点（`{origin}/api/health`），不是 origin 根路径：
 * 真机实证（2026-10-15 伴随容器冒烟）——daemon 配了 `OD_API_TOKEN` 时 `GET /` 回
 * Basic Auth 401，探 origin 会把「活着的服务」判成不可用；`/api/health` 是上游
 * 自身 healthcheck 的口径（免鉴权、语义 = 就绪）。
 */
export const OPEN_DESIGN_HEALTH_PATH = "/api/health";

/**
 * OpenDesign 宿主状态（`GET /api/open-design/host/status` 的取值来源）。
 *
 * 两级判定，缺哪级写哪级原因：
 * 1. 配置——未配前端地址直接 `enabled: false`；
 * 2. 可达——配了地址但服务不通 / 回非 2xx，同样 `enabled: false` 并给出可读原因。
 *
 * `fetchImpl` 可注入（测试不真发网络请求）。
 *
 * `companion`：伴随容器快照（§9-3 承载=伴随容器）。探活不通时把「容器侧在发生什么」
 * 拼进原因——拉镜像中的「等」与启动失败的「坏」是两种不同的等待，界面得说清。
 */
export async function resolveOpenDesignHostStatus(input: {
  frontendUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  companion?: OpenDesignCompanionSnapshot | undefined;
}): Promise<OpenDesignHostStatusResponse> {
  const frontendUrl = input.frontendUrl?.trim() || null;
  if (!frontendUrl) {
    return {
      enabled: false,
      frontendUrl: null,
      reasons: ["未配置 OpenDesign 前端地址。"],
    };
  }

  const companionReasons = companionDetailReasons(frontendUrl, input.companion);
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? OPEN_DESIGN_PROBE_TIMEOUT_MS;
  const probeUrl = `${frontendUrl.replace(/\/$/u, "")}${OPEN_DESIGN_HEALTH_PATH}`;
  try {
    const response = await fetchImpl(probeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        enabled: false,
        frontendUrl,
        reasons: [
          `OpenDesign 服务返回 HTTP ${response.status}，未就绪。`,
          ...companionReasons,
        ],
      };
    }
  } catch (error) {
    return {
      enabled: false,
      frontendUrl,
      reasons: [
        `OpenDesign 服务不可达：${describeProbeFailure(error)}`,
        ...companionReasons,
      ],
    };
  }

  return { enabled: true, frontendUrl, reasons: [] };
}

/**
 * 伴随容器侧的补充原因：仅托管模式（地址=伴随 origin）且给了快照时产出。
 * starting=还在拉镜像；error=透传摘要（文案自带主语：未配密钥/找不到文件/docker 失败）；
 * ready/idle 不补——基线原因已说明 HTTP 层事实。
 */
function companionDetailReasons(
  frontendUrl: string,
  companion: OpenDesignCompanionSnapshot | undefined,
): string[] {
  if (!companion || resolveOpenDesignCarrierMode(frontendUrl) !== "managed") {
    return [];
  }
  if (companion.state === "starting") {
    return ["伴随容器正在启动（首次需拉取镜像，可能要几分钟）。"];
  }
  if (companion.state === "error") {
    return [companion.error ?? "伴随容器状态异常。"];
  }
  return [];
}

/** 把探活失败压成一句可读原因（超时与连接拒绝要能区分开）。 */
function describeProbeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `连接超时（超过 ${OPEN_DESIGN_PROBE_TIMEOUT_MS}ms）。`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 200) || "连接失败。";
}
