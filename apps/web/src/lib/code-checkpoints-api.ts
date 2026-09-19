import type {
  CheckpointFileChange,
  CheckpointSummary,
} from "@kenfutwork/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

// ── Helpers（与本目录其它 *-api 一致：各自持有，不走共享导出） ──

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  throw new ApiApplicationError(
    body?.error?.code ?? "application_error",
    body?.error?.message ?? "请求失败，请重试。",
  );
}

/**
 * Code 模式检查点（影子 git）：某画布的检查点时间线（服务端按 createdAt 升序）。
 * 作用域与 git 视图同一口径——项目主画布 id（就是 run 的 canvasId）。
 */
export async function fetchCheckpoints(
  accessToken: string,
  canvasId: string,
): Promise<CheckpointSummary[]> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/checkpoints?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as {
    checkpoints: CheckpointSummary[];
  };
  return payload.checkpoints;
}

/** 检查点相对上一检查点的统一 diff 与逐文件增删（二进制文件两行数为 null）。 */
export interface CheckpointDiff {
  diff: string;
  files: CheckpointFileChange[];
}

export async function fetchCheckpointDiff(
  accessToken: string,
  checkpointId: string,
  path?: string,
): Promise<CheckpointDiff> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/checkpoints/${encodeURIComponent(checkpointId)}/diff${suffix}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as CheckpointDiff;
}

/** 恢复预览：工作目录相对目标检查点的未提交差异（确认弹窗的受影响清单）。 */
export interface CheckpointRestorePreview {
  targetSha: string;
  files: CheckpointFileChange[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export async function previewCheckpointRestore(
  accessToken: string,
  checkpointId: string,
): Promise<CheckpointRestorePreview> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/checkpoints/${encodeURIComponent(checkpointId)}/preview`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as CheckpointRestorePreview;
}

/**
 * 回滚到某检查点（**丢内容**操作，二次确认由界面负责）。
 * canvasId 是必传 query：服务端靠它做画布归属校验与「在途 run 拦截」。
 */
export async function restoreCheckpoint(
  accessToken: string,
  canvasId: string,
  checkpointId: string,
): Promise<CheckpointSummary> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/checkpoints/${encodeURIComponent(checkpointId)}/restore?${query.toString()}`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { checkpoint: CheckpointSummary };
  return payload.checkpoint;
}
