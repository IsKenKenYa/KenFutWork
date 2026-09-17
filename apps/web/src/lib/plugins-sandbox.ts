import type { CompatReport, SandboxPluginBundle } from "@kenfutwork/shared";

/**
 * 「从工作目录安装插件」的客户端调用：列出当前画布沙箱里的 bundle 候选，并把选中的安装到本实例。
 *
 * 沙箱目录由**服务端**解析（工作目录映射优先，否则 `<沙箱根>/<画布UUID>`）；前端只传
 * canvasId 与相对路径。安装与「从链接安装」同一条服务端事务：管理员门 + 兼容性门禁都不绕过。
 */

export type SandboxPluginInstallResult =
  | { ok: true; name: string; version: string }
  | { ok: false; reason: string; report: CompatReport | null };

async function readError(
  response: Response,
  fallback: string,
): Promise<{ reason: string; report: CompatReport | null }> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    report?: CompatReport;
  } | null;
  return {
    reason: payload?.error?.message ?? fallback,
    report: payload?.report ?? null,
  };
}

export async function listSandboxPluginBundles(input: {
  baseUrl: string;
  token: string | null;
  canvasId: string | null;
}): Promise<{ bundles: SandboxPluginBundle[]; error: string | null }> {
  if (!input.canvasId) {
    return { bundles: [], error: "请先在工作台选中一个项目（工作目录）。" };
  }
  try {
    const response = await fetch(
      `${input.baseUrl}/api/plugins/sandbox-bundles?canvasId=${encodeURIComponent(input.canvasId)}`,
      {
        headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
      },
    );
    if (!response.ok) {
      const { reason } = await readError(response, "扫描工作目录失败。");
      return { bundles: [], error: reason };
    }
    const payload = (await response.json()) as {
      bundles: SandboxPluginBundle[];
    };
    return { bundles: payload.bundles, error: null };
  } catch {
    return { bundles: [], error: "扫描工作目录失败（网络错误）。" };
  }
}

export async function installSandboxPlugin(input: {
  baseUrl: string;
  token: string | null;
  canvasId: string | null;
  path: string;
}): Promise<SandboxPluginInstallResult> {
  if (!input.canvasId) {
    return {
      ok: false,
      reason: "请先在工作台选中一个项目（工作目录）。",
      report: null,
    };
  }
  try {
    const response = await fetch(
      `${input.baseUrl}/api/plugins/sandbox-install`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        body: JSON.stringify({ canvasId: input.canvasId, path: input.path }),
      },
    );
    if (!response.ok) {
      const { reason, report } = await readError(
        response,
        "从工作目录安装失败。",
      );
      return { ok: false, reason, report };
    }
    // 与 /api/plugins/install 同形状：{installed, report}
    const payload = (await response.json()) as {
      installed?: { name?: string; version?: string };
    };
    if (!payload.installed?.name) {
      return { ok: false, reason: "安装响应缺少插件信息。", report: null };
    }
    return {
      ok: true,
      name: payload.installed.name,
      version: payload.installed.version ?? "",
    };
  } catch {
    return {
      ok: false,
      reason: "从工作目录安装失败（网络错误）。",
      report: null,
    };
  }
}
