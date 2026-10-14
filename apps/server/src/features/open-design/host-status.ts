import type { OpenDesignHostStatusResponse } from "@kenfutwork/shared";

/**
 * 探活超时。
 *
 * OpenDesign 的承载是**独立服务**（自托管 Docker 栈 / 桌面 sidecar），不是本进程内的能力，
 * 所以「配了地址」不等于「能用」。这里做一次真实可达性探测，并且必须**快速**给出结论——
 * status 是前端门控的同步依赖，探不通时要把原因写清楚而不是把面板挂起。
 */
export const OPEN_DESIGN_PROBE_TIMEOUT_MS = 1500;

/**
 * OpenDesign 宿主状态（`GET /api/open-design/host/status` 的取值来源）。
 *
 * 两级判定，缺哪级写哪级原因：
 * 1. 配置——未配前端地址直接 `enabled: false`；
 * 2. 可达——配了地址但服务不通 / 回非 2xx，同样 `enabled: false` 并给出可读原因。
 *
 * `fetchImpl` 可注入（测试不真发网络请求）。
 */
export async function resolveOpenDesignHostStatus(input: {
  frontendUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<OpenDesignHostStatusResponse> {
  const frontendUrl = input.frontendUrl?.trim() || null;
  if (!frontendUrl) {
    return {
      enabled: false,
      frontendUrl: null,
      reasons: ["未配置 OpenDesign 前端地址。"],
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? OPEN_DESIGN_PROBE_TIMEOUT_MS;
  try {
    const response = await fetchImpl(frontendUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        enabled: false,
        frontendUrl,
        reasons: [`OpenDesign 服务返回 HTTP ${response.status}，未就绪。`],
      };
    }
  } catch (error) {
    return {
      enabled: false,
      frontendUrl,
      reasons: [`OpenDesign 服务不可达：${describeProbeFailure(error)}`],
    };
  }

  return { enabled: true, frontendUrl, reasons: [] };
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
