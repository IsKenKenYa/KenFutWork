import type {
  ApiTokenCreateResponse,
  ApiTokenListResponse,
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
  /** 允许 AI 读取开发者工具数据（控制台日志 / 页面报错 / 网络请求）。 */
  browserDevtoolsReadEnabled: boolean;
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
    /** 允许 AI 读取开发者工具数据（控制台日志 / 页面报错 / 网络请求）。 */
    browserDevtoolsReadEnabled: boolean;
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

export type ProviderPresetModel = {
  id: string;
  name: string;
  capability: "chat" | "image" | "video";
};

export type ProviderPreset = {
  id: string;
  name: string;
  api?: string;
  doc?: string;
  env: string[];
  models: ProviderPresetModel[];
};

/** models.dev 供应商预设（供应商设置「从预设选择」；需登录）。 */
export async function fetchProviderPresets(
  accessToken: string,
): Promise<{ presets: ProviderPreset[] }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/provider-instances/presets`,
    { headers: authJsonHeaders(accessToken) },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch provider presets: ${response.status}`);
  }
  return (await response.json()) as { presets: ProviderPreset[] };
}

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

/**
 * 视频生成受理（202）：任务由 worker 异步执行（异步任务面 submit + 队列轮询），
 * 进度经 fetchJob 轮询到终态。S6 之前是 HTTP 内挂起等 5 分钟，已退役。
 */
export type GenerateVideoSubmission = {
  job_id: string;
  status: string;
  prompt: string;
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
): Promise<GenerateVideoSubmission> {
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
  return (await response.json()) as GenerateVideoSubmission;
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
  /** ② 「索引存储库以实现即时搜索」：搜索走索引。 */
  enabled: boolean;
  /** ① 「索引新文件夹」：自动为尚无索引的工作目录建索引。 */
  autoNewFolder: boolean;
  stats: CodeIndexStats | null;
}

export async function fetchCodeIndex(
  accessToken: string,
  taskId: string,
): Promise<CodeIndexStatus> {
  const query = new URLSearchParams({ taskId });
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
  taskId: string,
): Promise<{ stats: CodeIndexStats | null }> {
  const response = await fetch(`${getServerBaseUrl()}/api/code/index/rebuild`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ taskId }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { stats: CodeIndexStats | null };
}

export async function clearCodeIndex(
  accessToken: string,
  taskId: string,
): Promise<void> {
  const query = new URLSearchParams({ taskId });
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
  taskId: string,
  query: string,
): Promise<{ hits: CodeIndexSearchHit[]; builtAt: string }> {
  const params = new URLSearchParams({ taskId, q: query });
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

/**
 * 「打开调试工具」：把**页面内调试控制台**（Eruda，现成第三方）注入面板显示的这一页，
 * 并摆成悬浮窗（可拖动 / 可关闭）。
 */
export async function injectDebugConsole(
  accessToken: string,
  url: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/cdp/console`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ url }),
    },
  );
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new ApiApplicationError(
    "cdp_console_failed",
    payload?.error?.message ??
      `注入调试控制台失败（服务端返回 ${response.status}）。`,
  );
}

/** 调试控制台脚本源码（桌面形态取同一份，eval 进面板里的子 WebView2）。 */
export async function fetchDebugConsoleScript(
  accessToken: string,
): Promise<string> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/debug-console.js`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiApplicationError(
      "debug_console_unavailable",
      payload?.error?.message ??
        `拿不到调试控制台脚本（服务端返回 ${response.status}）。`,
    );
  }
  return await response.text();
}

/**
 * 「完整开发者工具」：在受控浏览器里开真 DevTools 并取消停靠成独立窗口。
 *
 * 服务端「像人一样」唤起它（激活受控窗口 + F12 → DevTools 前端的 setIsDocked(false)）——
 * 真 DevTools 只有浏览器自己开得出来，CDP 开出来的 devtools:// 窗口连不上页面。
 */
export async function openCdpDevtools(
  accessToken: string,
  bounds?: { left?: number; top?: number; width?: number; height?: number },
): Promise<{ windowId: number }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/cdp/devtools`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(bounds ?? {}),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    windowId?: number;
    error?: { message?: string };
  } | null;
  if (!response.ok || typeof payload?.windowId !== "number") {
    throw new ApiApplicationError(
      "cdp_devtools_failed",
      payload?.error?.message ??
        `打开开发者工具失败（服务端返回 ${response.status}）。`,
    );
  }
  return { windowId: payload.windowId };
}

export async function connectCdp(
  accessToken: string,
  /**
   * 无头（不弹窗口）。右栏面板显式传 `true`：面板里看的就是这个浏览器的画面，
   * 再弹一个窗口出来纯属多余（用户口径：「不要跳转外部」）。不传则按设置。
   */
  options: { headless?: boolean } = {},
): Promise<CdpStatusView> {
  let response: Response;
  try {
    response = await fetch(`${getServerBaseUrl()}/api/browser/cdp/connect`, {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(
        typeof options.headless === "boolean"
          ? { headless: options.headless }
          : {},
      ),
    });
  } catch {
    // fetch 抛错 = 服务端根本没应答（重启中/挂了），与「浏览器连不上」是两回事，要分开说
    throw new ApiApplicationError(
      "cdp_connect_failed",
      "服务端没有应答（可能正在重启）——稍后重试。",
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    cdp?: CdpStatusView;
    error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.cdp) {
    /**
     * **别把真实原因吞掉**（真机踩到）：以前无论后端说什么都只显示「连接浏览器失败。」，
     * 用户拿到一句没法行动的话。现在带上服务端原话；连原话都没有时至少给出状态码。
     */
    throw new ApiApplicationError(
      "cdp_connect_failed",
      payload?.error?.message ??
        `连接浏览器失败（服务端返回 ${response.status}）。`,
    );
  }
  return payload.cdp;
}

/** 面板画面流的视口尺寸（CSS px；客户端按它把鼠标坐标换算成视口坐标）。 */
export interface CdpViewportView {
  width: number;
  height: number;
  scale: number;
}

/**
 * 面板画面流的**开流手续**：确认受控浏览器在 + 导航到目标地址 + 换一张票据。
 *
 * 分两步是因为真正开流的请求由浏览器替我们发（`<img src=…>`），发不了登录头——
 * 票据短时且一次性（见服务端 view-stream）。
 */
export async function openCdpView(
  accessToken: string,
  input: {
    url?: string;
    /** 自由尺寸：真视口尺寸（不给 = 跟窗口一样大）。 */
    width?: number;
    height?: number;
    /** 「刷新」：同一页也重新导航一次。 */
    reload?: boolean;
  },
): Promise<{ ticket: string; viewport: CdpViewportView }> {
  const response = await fetch(`${getServerBaseUrl()}/api/browser/cdp/view`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => null)) as {
    ticket?: string;
    viewport?: CdpViewportView;
    error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.ticket || !payload.viewport) {
    throw new ApiApplicationError(
      "cdp_view_failed",
      payload?.error?.message ??
        `打开面板画面失败（服务端返回 ${response.status}）。`,
    );
  }
  return { ticket: payload.ticket, viewport: payload.viewport };
}

/** 面板内交互回填的线形状（坐标是**视口 CSS px**，服务端不缩放）。 */
export type CdpInputWireEvent =
  | {
      type: "mouse";
      action: "pressed" | "released" | "moved";
      x: number;
      y: number;
      /** `none` = 只是移动（没有按着任何键）。 */
      button?: "left" | "right" | "middle" | "none";
      buttons?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX?: number;
      deltaY?: number;
    }
  | { type: "key"; key: string; code?: string; modifiers?: number }
  | { type: "text"; text: string };

/** 面板内的交互回填（鼠标 / 滚轮 / 键盘 / 文本）。 */
export async function sendCdpInput(
  accessToken: string,
  event: CdpInputWireEvent,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/browser/cdp/input`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(event),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new ApiApplicationError(
    "cdp_input_failed",
    payload?.error?.message ??
      `面板操作没能转给浏览器（服务端返回 ${response.status}）。`,
  );
}

export async function disconnectCdp(
  accessToken: string,
): Promise<CdpStatusView> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/browser/cdp/disconnect`,
    // 同上：JSON 头就必须带 body
    { method: "POST", headers: authJsonHeaders(accessToken), body: "{}" },
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
    // JSON 头必须带 body：空 body 会被 Fastify 判 400（FST_ERR_CTP_EMPTY_JSON_BODY），
    // 错误体里没有 error.message，前端只会看到一句没头没尾的 "Request failed"。
    { method: "POST", headers: authJsonHeaders(accessToken), body: "{}" },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PickDirectoryResponse;
}

// --- 子智能体（设置 →「子智能体」；清单与 agent 装配同源） ---

export type AgentSubagentListResponse = {
  subagents: Array<{
    name: string;
    label: string;
    description: string;
    tools: string[];
  }>;
  builtin: Array<{ name: string; label: string; description: string }>;
};

export async function fetchSubagents(
  accessToken: string,
): Promise<AgentSubagentListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/agent/subagents`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AgentSubagentListResponse;
}

// --- 外部应用访问令牌（R5-2「外部应用授权」） ---

export async function fetchApiTokens(
  accessToken: string,
): Promise<ApiTokenListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/tokens`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ApiTokenListResponse;
}

export async function createApiToken(
  accessToken: string,
  name: string,
): Promise<ApiTokenCreateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/tokens`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ApiTokenCreateResponse;
}

export async function revokeApiToken(
  accessToken: string,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/tokens/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
}
