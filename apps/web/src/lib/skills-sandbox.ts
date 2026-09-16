import type {
  SandboxSkillPackage,
  SkillDetail,
} from "@kenfutwork/shared";

/**
 * 「从工作目录导入」的客户端调用：列出当前画布沙箱里的技能包候选，并把选中的导入工作区。
 *
 * 沙箱目录由**服务端**解析（工作目录映射优先，否则 `<沙箱根>/<画布UUID>`）——前端只传
 * canvasId 与相对路径，读盘与校验都在服务端，避免前端伪造路径。
 */

export type SandboxImportResult =
  | { ok: true; skill: SkillDetail }
  | { ok: false; reason: string };

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return payload?.error?.message ?? fallback;
}

/** 列出工作目录里的技能包候选（找不到画布 / 网络失败都返回可读原因）。 */
export async function listSandboxSkillPackages(input: {
  baseUrl: string;
  token: string | null;
  canvasId: string | null;
}): Promise<{ packages: SandboxSkillPackage[]; error: string | null }> {
  if (!input.canvasId) {
    return { packages: [], error: "请先在工作台选中一个项目（工作目录）。" };
  }
  try {
    const response = await fetch(
      `${input.baseUrl}/api/skills/sandbox-packages?canvasId=${encodeURIComponent(input.canvasId)}`,
      {
        headers: input.token
          ? { Authorization: `Bearer ${input.token}` }
          : {},
      },
    );
    if (!response.ok) {
      return {
        packages: [],
        error: await readError(response, "扫描工作目录失败。"),
      };
    }
    const payload = (await response.json()) as {
      packages: SandboxSkillPackage[];
    };
    return { packages: payload.packages, error: null };
  } catch {
    return { packages: [], error: "扫描工作目录失败（网络错误）。" };
  }
}

/** 把工作目录里的技能包导入当前工作区（服务端读取磁盘内容）。 */
export async function importSandboxSkill(input: {
  baseUrl: string;
  token: string | null;
  canvasId: string | null;
  path: string;
}): Promise<SandboxImportResult> {
  if (!input.canvasId) {
    return { ok: false, reason: "请先在工作台选中一个项目（工作目录）。" };
  }
  try {
    const response = await fetch(`${input.baseUrl}/api/skills/sandbox-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({ canvasId: input.canvasId, path: input.path }),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: await readError(response, "从工作目录导入失败。"),
      };
    }
    const payload = (await response.json()) as { skill: SkillDetail };
    return { ok: true, skill: payload.skill };
  } catch {
    return { ok: false, reason: "从工作目录导入失败（网络错误）。" };
  }
}
