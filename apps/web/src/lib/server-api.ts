import type {
  AssetSignedUrlResponse,
  CanvasDetail,
  ChatMessageCreateRequest,
  DirectoryPickerStatus,
  ExecutionMode,
  JobResponse,
  MessageCreateResponse,
  MessageListResponse,
  ModelListResponse,
  PermissionTier,
  PickDirectoryResponse,
  ProfileUpdateResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectKind,
  ProjectListResponse,
  ProjectUpdateRequest,
  ProviderInstanceCreateRequest,
  ProviderInstanceListResponse,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
  RunCreateRequest,
  RunCreateResponse,
  SessionCreateResponse,
  SessionListResponse,
  UploadResponse,
  ViewerResponse,
  WorkspaceSettings,
  WorkspaceSettingsResponse,
  WorkspaceSkillListResponse,
} from "@kenfutwork/shared";

import { dedupeRequest } from "./dedupe-request";
import { getServerBaseUrl } from "./env";

// --- Error types ---

export class ApiAuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "ApiAuthError";
  }
}

export class ApiApplicationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiApplicationError";
    this.code = code;
  }
}

// --- Existing ---

export async function createRun(
  payload: RunCreateRequest,
  options?: { accessToken?: string },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options?.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(`${getServerBaseUrl()}/api/agent/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Run creation failed with status ${response.status}`);
  }

  return (await response.json()) as RunCreateResponse;
}

// --- Authenticated API ---

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const message = body?.error?.message ?? "Request failed";
  throw new ApiApplicationError(code, message);
}

export async function fetchViewer(
  accessToken: string,
): Promise<ViewerResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ViewerResponse;
}

export async function fetchProjects(
  accessToken: string,
  kind: ProjectKind = "design",
): Promise<ProjectListResponse> {
  const query = new URLSearchParams({ kind });
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects?${query.toString()}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectListResponse;
}

export async function createProject(
  accessToken: string,
  data: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectCreateResponse;
}

export async function deleteProject(
  accessToken: string,
  projectId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchProject(
  accessToken: string,
  projectId: string,
): Promise<{
  project: { id: string; name: string; brand_kit_id: string | null };
}> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    project: { id: string; name: string; brand_kit_id: string | null };
  };
}

export async function updateProject(
  accessToken: string,
  projectId: string,
  data: ProjectUpdateRequest,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas API ---

export async function fetchCanvas(
  accessToken: string,
  canvasId: string,
): Promise<{ canvas: CanvasDetail }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { canvas: CanvasDetail };
}

export async function saveCanvas(
  accessToken: string,
  canvasId: string,
  content: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  },
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function uploadThumbnail(
  accessToken: string,
  projectId: string,
  blob: Blob,
): Promise<void> {
  const formData = new FormData();
  formData.append("file", blob, "thumbnail.webp");
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}/thumbnail`,
    {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: formData,
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Settings API ---

export async function updateProfile(
  accessToken: string,
  data: { displayName: string },
): Promise<ProfileUpdateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer/profile`, {
    method: "PATCH",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProfileUpdateResponse;
}

export async function fetchWorkspaceSettings(
  accessToken: string,
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

/** 部分更新：只送要改的字段（服务端逐列 upsert，未送的不动）。 */
export async function updateWorkspaceSettings(
  accessToken: string,
  data: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

// --- Execution Modes API（P7 执行模式切换，DEC-3）---

export async function fetchExecutionModes(accessToken: string): Promise<{
  modes: Array<{ id: ExecutionMode; label: string; description: string }>;
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/execution-modes`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    modes: Array<{ id: ExecutionMode; label: string; description: string }>;
  };
}

export async function fetchExecutionMode(
  accessToken: string,
  threadId: string,
): Promise<{ mode: ExecutionMode }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/execution-modes/${threadId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { mode: ExecutionMode };
}

export async function updateExecutionMode(
  accessToken: string,
  threadId: string,
  input: { mode: ExecutionMode },
): Promise<{ mode: ExecutionMode }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/execution-modes/${threadId}`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { mode: ExecutionMode };
}

// --- Permissions API（DEC-4 权限档位/审批）---

/** 权限设置（R5-3）：常规档 / 自动化档 / 自定义规则 / 浏览器控制开关。 */
export interface PermissionSettingsView {
  tier: PermissionTier;
  automationTier: PermissionTier;
  rules: { allow: string[]; deny: string[] };
  browserControlEnabled: boolean;
  /** 浏览器动作后自动附截图（R5-4）。 */
  browserAutoScreenshot: boolean;
  /** CDP 托管浏览器无头运行。 */
  browserHeadless: boolean;
  approvedForever: string[];
}

export async function fetchPermissionSettings(
  accessToken: string,
): Promise<PermissionSettingsView> {
  const response = await fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PermissionSettingsView;
}

/** 部分更新：只送要改的字段（未送的一律不动）。 */
export async function updatePermissionSettings(
  accessToken: string,
  patch: Partial<{
    tier: PermissionTier;
    automationTier: PermissionTier;
    rules: { allow: string[]; deny: string[] };
    browserControlEnabled: boolean;
    browserAutoScreenshot: boolean;
    browserHeadless: boolean;
  }>,
): Promise<PermissionSettingsView> {
  const response = await fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(patch),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PermissionSettingsView;
}

/** @deprecated 用 fetchPermissionSettings（这里只回旧形状里的 tier）。 */
export async function fetchPermissionTier(
  accessToken: string,
): Promise<{ tier: PermissionTier }> {
  const settings = await fetchPermissionSettings(accessToken);
  return { tier: settings.tier };
}

/** @deprecated 用 updatePermissionSettings。 */
export async function updatePermissionTier(
  accessToken: string,
  tier: PermissionTier,
): Promise<{ tier: PermissionTier }> {
  const settings = await updatePermissionSettings(accessToken, { tier });
  return { tier: settings.tier };
}

export async function approveToolPermission(
  accessToken: string,
  input: {
    toolName: string;
    scope: "once" | "thread" | "forever";
    threadId?: string;
  },
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/permissions/approve`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok && response.status !== 204)
    return handleErrorResponse(response);
}

// --- Provider Instances API（BYOK 供应商设置，P5）---

export async function fetchProviderInstances(
  accessToken: string,
): Promise<ProviderInstanceListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/provider-instances`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProviderInstanceListResponse;
}

export async function createProviderInstance(
  accessToken: string,
  input: ProviderInstanceCreateRequest,
): Promise<ProviderInstanceResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/provider-instances`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProviderInstanceResponse;
}

export async function updateProviderInstance(
  accessToken: string,
  instanceId: string,
  input: ProviderInstanceUpdateRequest,
): Promise<ProviderInstanceResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/provider-instances/${instanceId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProviderInstanceResponse;
}

export async function deleteProviderInstance(
  accessToken: string,
  instanceId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/provider-instances/${instanceId}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok && response.status !== 204)
    return handleErrorResponse(response);
}

export async function fetchModels(
  accessToken?: string,
): Promise<ModelListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/models`, {
    // 带凭证时服务端并入 BYOK 实例目录（工作区隔离）；匿名仅返回内置目录
    ...(accessToken ? { headers: authHeaders(accessToken) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`);
  }
  return (await response.json()) as ModelListResponse;
}

// --- Chat Session API ---

export function fetchSessions(
  accessToken: string,
  canvasId: string,
): Promise<SessionListResponse> {
  return dedupeRequest(`sessions:${canvasId}`, async () => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
      { headers: authHeaders(accessToken) },
    );
    if (!response.ok) return handleErrorResponse(response);
    return (await response.json()) as SessionListResponse;
  });
}

export async function createSession(
  accessToken: string,
  canvasId: string,
  title?: string,
): Promise<SessionCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(title ? { title } : {}),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SessionCreateResponse;
}

export async function updateSessionTitle(
  accessToken: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function deleteSession(
  accessToken: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchMessages(
  accessToken: string,
  sessionId: string,
): Promise<MessageListResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageListResponse;
}

export async function saveMessage(
  accessToken: string,
  sessionId: string,
  data: ChatMessageCreateRequest,
): Promise<MessageCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageCreateResponse;
}

// --- Upload API ---

export async function uploadFile(
  accessToken: string,
  file: File,
  projectId?: string,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (projectId) {
    formData.append("projectId", projectId);
  }

  const response = await fetch(`${getServerBaseUrl()}/api/uploads`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: formData,
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

export async function getAssetUrl(
  accessToken: string,
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/${assetId}/url`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AssetSignedUrlResponse;
}

export async function deleteAsset(
  accessToken: string,
  assetId: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/uploads/${assetId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas-Native Generation API ---

export type GenerateImageResponse = {
  url: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
};

export type ImageModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
};

export async function fetchImageModels(): Promise<{
  models: ImageModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/image-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch image models: ${response.status}`);
  }
  return (await response.json()) as { models: ImageModelInfo[] };
}

export type VideoModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
  capabilities?: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits?: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  pricing?: {
    currency: "CNY";
    billingUnit: "generated_second";
    providerPointsName: string;
    evidenceDate: string;
    rates: Array<{
      resolution: "720p" | "1080p";
      displayResolution: string;
      providerPointsPerSecond: number;
      cnyPerSecond: { min: number; max: number };
    }>;
  };
};

export async function fetchVideoModels(): Promise<{
  models: VideoModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/video-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch video models: ${response.status}`);
  }
  return (await response.json()) as { models: VideoModelInfo[] };
}

export async function generateImageDirect(
  accessToken: string,
  prompt: string,
  options?: {
    model?: string;
    aspectRatio?: string;
    quality?: string;
    /** 会话标识（§4.8）：实例自定义头里的 `{{sessionId}}` 按它渲染。 */
    sessionId?: string;
  },
): Promise<GenerateImageResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-image`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.quality ? { quality: options.quality } : {}),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as GenerateImageResponse;
}

export type GenerateVideoResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
};

export async function generateVideoDirect(
  accessToken: string,
  prompt: string,
  options?: {
    model?: string;
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    inputImages?: string[];
    /** 会话标识（§4.8）：随任务落库，worker 侧按它渲染自定义头占位符。 */
    sessionId?: string;
  },
): Promise<GenerateVideoResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-video`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.duration != null ? { duration: options.duration } : {}),
        ...(options?.resolution ? { resolution: options.resolution } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.inputImages?.length
          ? { inputImages: options.inputImages }
          : {}),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as GenerateVideoResponse;
}

// --- Jobs API ---

export async function fetchJob(
  accessToken: string,
  jobId: string,
): Promise<JobResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/${jobId}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

// --- Workspace Skills API（画布聊天技能目录）---

export async function fetchWorkspaceSkills(
  accessToken: string,
): Promise<WorkspaceSkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspaces/skills`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSkillListResponse;
}

// --- 代码库索引（R4-3「索引库」）---

export interface CodeIndexStats {
  files: number;
  bytes: number;
  builtAt: string;
  skipped: number;
  truncated: boolean;
  indexBytes: number;
}

export interface CodeIndexStatus {
  enabled: boolean;
  stats: CodeIndexStats | null;
}

export async function fetchCodeIndex(
  accessToken: string,
  canvasId: string,
): Promise<CodeIndexStatus> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/index?${query}`,
    {
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as CodeIndexStatus;
}

export async function rebuildCodeIndex(
  accessToken: string,
  canvasId: string,
): Promise<{ stats: CodeIndexStats | null }> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/index/rebuild`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ canvasId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { stats: CodeIndexStats | null };
}

export async function clearCodeIndex(
  accessToken: string,
  canvasId: string,
): Promise<void> {
  const query = new URLSearchParams({ canvasId });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/index?${query}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export interface CodeIndexSearchHit {
  path: string;
  bytes: number;
  language: string;
  summary: string;
  matched: "name" | "path" | "content";
}

export async function searchCodeIndex(
  accessToken: string,
  canvasId: string,
  query: string,
): Promise<{ hits: CodeIndexSearchHit[]; builtAt: string }> {
  const params = new URLSearchParams({ canvasId, q: query });
  const response = await fetch(
    `${getServerBaseUrl()}/api/code/index/search?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    hits: CodeIndexSearchHit[];
    builtAt: string;
  };
}

// --- CDP 浏览器通道（R5-4「连接到 Chrome」/「自动截图」）---

export type CdpStatusView =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      browser: string;
      port: number;
      tabs: number;
      currentUrl: string;
      owned: boolean;
      headless: boolean;
    }
  | { status: "error"; message: string };

export async function fetchCdpStatus(
  accessToken: string,
): Promise<CdpStatusView> {
  const response = await fetch(`${getServerBaseUrl()}/api/browser/cdp/status`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { cdp: CdpStatusView };
  return payload.cdp;
}

export async function connectCdp(accessToken: string): Promise<CdpStatusView> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/cdp/connect`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    cdp?: CdpStatusView;
    error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.cdp) {
    throw new ApiApplicationError(
      "cdp_connect_failed",
      payload?.error?.message ?? "连接浏览器失败。",
    );
  }
  return payload.cdp;
}

export async function disconnectCdp(
  accessToken: string,
): Promise<CdpStatusView> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/cdp/disconnect`,
    { method: "POST", headers: authJsonHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const payload = (await response.json()) as { cdp: CdpStatusView };
  return payload.cdp;
}

// --- 原生目录对话框（桌面形态：服务端与用户同机时由服务端弹系统对话框） ---

export async function fetchDirectoryPickerStatus(
  accessToken: string,
): Promise<DirectoryPickerStatus> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/system/directory-picker`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as DirectoryPickerStatus;
}

export async function pickDirectory(
  accessToken: string,
): Promise<PickDirectoryResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/system/pick-directory`,
    { method: "POST", headers: authJsonHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PickDirectoryResponse;
}
