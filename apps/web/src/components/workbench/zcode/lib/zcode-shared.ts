/**
 * zcode 移植层宿主适配：`@zcode/shared` 的最小等价（只收录照搬组件实际消费的切片）。
 * 来源：references/zcode/packages/shared/src/{platform,protocol,remoteTarget,test-ids,markdown-artifact-images}.ts
 * 许可证：Apache-2.0（zcode）。
 * 适配口径：类型逐字照搬；运行时函数（artifact 图片重写 / remoteTarget 构造）为纯函数照搬。
 * 远程连接类型（SSH/WSL/Docker）仅作类型保留——我们宿主暂无远程工作区，platform stub 永远不会返回 remoteTarget。
 */

/* ---------- remoteTarget.ts ---------- */

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions;

/* ---------- platform.ts ---------- */

/** 已安装的编辑器/终端信息 */
export interface EditorInfo {
  /** 编辑器标识 (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** 显示名 */
  name: string;
  /** 图标 base64 data URL */
  iconDataUrl: string;
}

export type OpenInEditorRemoteTarget =
  | Pick<
      SSHConnectOptions,
      "kind" | "host" | "port" | "username" | "sshConfigAlias"
    >
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SaveFileResult {
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export function createOpenInEditorRemoteTarget(
  target: RemoteTarget,
): OpenInEditorRemoteTarget {
  switch (target.kind) {
    case "ssh":
      // openInEditor 只需要构造 VS Code Remote-SSH URI 的连接标识，
      // 不应该把 password/privateKeyPassphrase 等凭据字段继续穿过 renderer/preload/main IPC。
      return {
        kind: "ssh",
        host: target.host,
        ...(target.port !== undefined ? { port: target.port } : {}),
        username: target.username,
        ...(target.sshConfigAlias?.trim()
          ? { sshConfigAlias: target.sshConfigAlias.trim() }
          : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      // exactOptionalPropertyTypes：条件展开在该联合上推断不稳，显式构造。
      const result: {
        kind: "wsl";
        distro?: string;
        user?: string;
      } = { kind: "wsl" };
      if (target.distro !== undefined) result.distro = target.distro;
      if (user) result.user = user;
      return result;
    }
    case "docker":
      return { kind: "docker", container: target.container };
  }
}

/* ---------- protocol.ts ---------- */

export interface FileStat {
  path: string;
  type: "file" | "directory";
  /** 文件字节数；旧远端服务端可能不返回，调用方需按 undefined 处理。 */
  size?: number;
  /** 文件最后修改时间。 */
  mtimeMs?: number;
}

export interface FileMediaPreview {
  path: string;
  mediaType: string;
  dataBase64: string;
  totalBytes: number;
}

/* ---------- test-ids.ts ---------- */

export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

/* ---------- markdown-artifact-images.ts ---------- */

const ARTIFACT_IMAGE_RENDER_PREFIX = "/__zcode_artifact_image__/";
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const ARTIFACT_IMAGE_PATTERN =
  /!\[[^\]\n]*\]\(\s*(?:<)?(zcode-artifact:\/\/[^\s)>]+)(?:>)?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;

function mapOutsideMarkdownFences(
  markdown: string,
  transform: (line: string) => string,
): string {
  let activeMarker: "`" | "~" | null = null;
  let activeLength = 0;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = line.match(FENCE_PATTERN);
      if (fence?.[2]) {
        const run = fence[2];
        const marker = run[0] as "`" | "~";
        const suffix = fence[3] ?? "";
        if (
          activeMarker === marker &&
          run.length >= activeLength &&
          suffix.trim() === ""
        ) {
          activeMarker = null;
          activeLength = 0;
        } else if (!activeMarker && (marker === "~" || !suffix.includes("`"))) {
          activeMarker = marker;
          activeLength = run.length;
        }
        return line;
      }
      return activeMarker ? line : transform(line);
    })
    .join("\n");
}

export function extractMarkdownArtifactImageRefs(markdown: string): string[] {
  const refs = new Set<string>();
  mapOutsideMarkdownFences(markdown, (line) => {
    for (const match of line.matchAll(ARTIFACT_IMAGE_PATTERN)) {
      if (match[1]) refs.add(match[1]);
    }
    return line;
  });
  return [...refs];
}

export function rewriteMarkdownArtifactImageSources(markdown: string): string {
  return mapOutsideMarkdownFences(markdown, (line) =>
    line.replace(ARTIFACT_IMAGE_PATTERN, (image, ref: string) =>
      image.replace(
        ref,
        `${ARTIFACT_IMAGE_RENDER_PREFIX}${encodeURIComponent(ref)}`,
      ),
    ),
  );
}

export function decodeMarkdownArtifactImageSource(
  source: string,
): string | null {
  if (!source.startsWith(ARTIFACT_IMAGE_RENDER_PREFIX)) return null;
  try {
    const ref = decodeURIComponent(
      source.slice(ARTIFACT_IMAGE_RENDER_PREFIX.length),
    );
    return ref.startsWith("zcode-artifact://") ? ref : null;
  } catch {
    return null;
  }
}

/**
 * zcode 照搬（P1 补充）：`@zcode/shared` media-preview.ts 全量
 * （references/zcode/packages/shared/src/media-preview.ts）。许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬（codeViewer.ts 消费 MediaPreviewKind/getMediaPreviewFormat）。
 */
import { z } from "zod";

export type MediaPreviewKind = "audio" | "video";

export interface MediaPreviewFormat {
  extension: string;
  kind: MediaPreviewKind;
  mediaType: string;
}

export const MEDIA_PREVIEW_FORMATS: readonly MediaPreviewFormat[] = [
  { extension: ".mp4", kind: "video", mediaType: "video/mp4" },
  { extension: ".mov", kind: "video", mediaType: "video/quicktime" },
  { extension: ".webm", kind: "video", mediaType: "video/webm" },
  { extension: ".m4v", kind: "video", mediaType: "video/x-m4v" },
  { extension: ".mp3", kind: "audio", mediaType: "audio/mpeg" },
  { extension: ".wav", kind: "audio", mediaType: "audio/wav" },
  { extension: ".m4a", kind: "audio", mediaType: "audio/mp4" },
  { extension: ".ogg", kind: "audio", mediaType: "audio/ogg" },
  { extension: ".opus", kind: "audio", mediaType: "audio/opus" },
  { extension: ".flac", kind: "audio", mediaType: "audio/flac" },
  { extension: ".weba", kind: "audio", mediaType: "audio/webm" },
];

export function getMediaPreviewFormat(path: string): MediaPreviewFormat | null {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  return (
    MEDIA_PREVIEW_FORMATS.find(({ extension }) =>
      normalizedPath.endsWith(extension),
    ) ?? null
  );
}

/**
 * zcode 照搬（P1 类型切片）：`@zcode/shared` assistant-message-parts.ts 中的以下符号（references/zcode/packages/shared/src/assistant-message-parts.ts）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1「缺新符号先补 zcode-shared」）。
 * 符号：ZCodeAssistantMessagePart
 */

export type ZCodeAssistantMessagePart =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "thought";
      content: string;
    }
  | {
      type: "tool-call";
      toolId: string;
    };

/**
 * zcode 照搬（P1 类型切片）：`@zcode/shared` tool-identity.ts 中的以下符号（references/zcode/packages/shared/src/tool-identity.ts）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1「缺新符号先补 zcode-shared」）。
 * 符号：ZCodeKnownToolName, ZCodeToolFamily, getZCodeToolFamilyForName, isZCodeFileContentWriteToolName, normalizeZCodeToolName
 */

export type ZCodeToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "session-context"
  | "message"
  | "task-control"
  | "node-repl"
  | "workflow";

const TOOL_FAMILY_BY_NAME: Record<ZCodeKnownToolName, ZCodeToolFamily> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebFetch: "search",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  ReadSessionContext: "session-context",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // TaskStop 未登记时 UI identity 会退回 unknown，最终落到 raw fallback renderer。
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl 由 MCP 暴露，进入 UI 的工具名因此带 MCP 前缀。
  // 若这里只登记旧 built-in 名称，专用 REPL renderer 会退回 unknown fallback。
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  Skill: "skill",
  CreateWorkflow: "workflow",
  AmendWorkflow: "workflow",
  submit_result: "workflow",
};

export const ZCODE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  "Skill",
  "CreateWorkflow",
  // 修订入口：登记进 workflow family 让确认窗
  // 按 family 选中运行确认块；工具行侧则按名先分流（resolveRenderer.ts），family 兜底不会吞掉它。
  "AmendWorkflow",
  // wire 名就是 snake_case 的 submit_result（仓库里唯一一个），下划线必须字面在场：
  // 未登记时 UI identity 退回 unknown，动态工作流 actor 的提交会落到 raw fallback renderer。
  "submit_result",
] as const;

const TOOL_NAME_BY_LOWER = new Map<string, ZCodeKnownToolName>(
  ZCODE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export type ZCodeKnownToolName = (typeof ZCODE_KNOWN_TOOL_NAMES)[number];

export function normalizeZCodeToolName(
  value: string | null | undefined,
): ZCodeKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return TOOL_NAME_BY_LOWER.get(normalized.toLowerCase()) ?? null;
}

export function getZCodeToolFamilyForName(
  value: string | null | undefined,
): ZCodeToolFamily | null {
  const toolName = normalizeZCodeToolName(value);
  return toolName ? TOOL_FAMILY_BY_NAME[toolName] : null;
}

export function isZCodeFileContentWriteToolName(
  value: string | null | undefined,
): boolean {
  return normalizeZCodeToolName(value) === "Write";
}

/**
 * zcode 照搬（P1 类型切片）：`@zcode/shared` tool-plan-adapter.ts 中的以下符号（references/zcode/packages/shared/src/tool-plan-adapter.ts）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1「缺新符号先补 zcode-shared」）。
 * 符号：isTodoPlanToolName
 */

const TODO_TOOL_NAME_PATTERN =
  /(?:^|[_\s-])(?:todo[_\s-]*(?:read|write)|update[_\s-]*plan)(?:$|[_\s-])/i;

export function isTodoPlanToolName(value: string | null | undefined): boolean {
  return typeof value === "string" && TODO_TOOL_NAME_PATTERN.test(value.trim());
}

/**
 * zcode 照搬（P1 类型切片）：`@zcode/shared` zcode-task-types-core.ts 中的以下符号（references/zcode/packages/shared/src/zcode-task-types-core.ts）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1「缺新符号先补 zcode-shared」）。
 * 符号：InputId, ZCodeAssistantMessageFeedback, ZCodeContextCompactionTimelineMeta, ZCodeContextCompactionTimelinePhase, ZCodeGoalVerification, ZCodeGoalVerificationTimelineMeta, ZCodeGoalVerificationTimelineStatus, ZCodePromptAttachment, ZCodePromptAudioAttachment, ZCodePromptFileAttachment, ZCodePromptImageAttachment, ZCodePromptPdfAttachment, ZCodePromptVideoAttachment, ZCodeSessionForkTimelineMeta, ZCodeTaskSnapshotBodyField, ZCodeTaskSnapshotBodyRef, ZCodeTaskSnapshotToolField, ZCodeTaskSnapshotToolFieldRef, ZCodeTaskSnapshotToolSlice, ZCodeTimelineMeta, ZCodeTimelineStatus, ZCodeTimelineTrigger
 */

export type ZCodeAssistantMessageFeedback = "like" | "dislike";

export type ZCodePromptAttachment =
  | ZCodePromptImageAttachment
  | ZCodePromptAudioAttachment
  | ZCodePromptVideoAttachment
  | ZCodePromptPdfAttachment
  | ZCodePromptFileAttachment;
// ---- Task 元数据 ----

export type ZCodeTimelineMeta =
  | ZCodeContextCompactionTimelineMeta
  | ZCodeGoalVerificationTimelineMeta
  | ZCodeSessionForkTimelineMeta;

export interface ZCodeTaskSnapshotBodyRef {
  field: ZCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}

export interface ZCodeTaskSnapshotToolFieldRef {
  field: ZCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}

export interface ZCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}

export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  localPath?: string;
}
/** 视频附件：Web 小视频走 dataBase64，桌面端优先 localPath 零拷贝。 */

export interface ZCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}

export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** 纯 base64 正文；mimeType 由字段单独携带。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；agent 侧按路径读取并做大小校验。 */
  localPath?: string;
}

export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；大图片不再塞进协议正文，由 agent 侧按路径处理。 */
  localPath?: string;
}

export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 附件来源；clipboard-text 表示由长文本粘贴落盘生成，agent 只应按临时文件引用处理。 */
  sourceKind?: "clipboard-text";
  /** 旧版/无路径环境的兼容回退；新桌面 GUI 不再为普通文件发送 base64。 */
  dataBase64?: string;
  /** 无本地路径时的小文本回退；有 localPath 时由 agent 自行读取。 */
  textContent?: string;
  localPath?: string;
}

export interface ZCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** 纯对话 fork 没有 workspace checkpoint；UI 跳回父消息只依赖 targetMessageId。 */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ZCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: ZCodeTimelineStatus;
  trigger: ZCodeTimelineTrigger;
  display: "separator";
  /**
   * `/compact` 本地会先渲染 optimistic 横条，agent lifecycle 事件稍后才到。
   * 用 inputId 把两者合并，避免同一次压缩先显示“正在压缩”再额外追加一条“已压缩”。
   */
  inputId?: InputId;
  /** 失败后重试需要保留用户原本输入的 `/compact ...` 指令。 */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** compact 阶段用于区分 mid_turn / pre_request 等真实压缩边界，避免 UI 和 e2e 只能按文案猜。 */
  phase?: ZCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}

export interface ZCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: ZCodeGoalVerificationTimelineStatus;
  verification?: ZCodeGoalVerification;
  goalIteration?: number;
  /** verifier divider 应锚定到完成本轮输出的 assistant message，而不是按时间漂移。 */
  anchorAssistantMessageId?: string;
  /** 辅助恢复同一 turn 的边界语义；旧历史可能缺失。 */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}

export type ZCodeTaskSnapshotBodyField = "content" | "thought";

export type ZCodeTaskSnapshotToolField = "input" | "output" | "raw";

export type InputId = string;
/** 每条真实用户 query 的语义归因 ID，用于模型请求 header 和用户问题级观测。 */

export type ZCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";

export type ZCodeTimelineTrigger =
  | "manual"
  | "auto"
  | "reactive"
  | "partial"
  | "session_memory";

export type ZCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";

export interface ZCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}

export type ZCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

/**
 * zcode 照搬（P1 补充）：`@zcode/shared` conversation-preview-artifacts.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 */

export function extractConversationPreviewFileReferences(
  content: string,
  workspacePath: string,
): ConversationPreviewFileReference[] {
  if (!content.trim()) return [];
  const references: ConversationPreviewFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];
  const addReference = (raw: string, start: number, end: number) => {
    const path = resolveConversationPreviewPath(workspacePath, raw);
    const definition = path ? getConversationPreviewFileType(path) : null;
    if (!path || !definition) return;
    references.push({ start, end, kind: definition.kind, path, raw });
  };

  for (const match of content.matchAll(FILE_CITATION_RE)) {
    const rawDirective = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + rawDirective.length;
    protectedRanges.push([start, end]);
    const rawPath = readDirectiveParameter(match[1] ?? "", "path");
    if (!rawPath) continue;
    const artifactKind = readDirectiveParameter(
      match[1] ?? "",
      "artifact_kind",
    )?.toLowerCase();
    const path = resolveConversationPreviewPath(workspacePath, rawPath);
    const definition = path ? getConversationPreviewFileType(path) : null;
    const citationKind =
      definition?.kind === "docx" ||
      definition?.kind === "xlsx" ||
      definition?.kind === "pptx" ||
      definition?.kind === "pdf" ||
      definition?.kind === "video" ||
      definition?.kind === "audio"
        ? definition.kind
        : null;
    const expectedKind =
      artifactKind === "document"
        ? "docx"
        : artifactKind === "presentation"
          ? "pptx"
          : artifactKind === "workbook"
            ? "xlsx"
            : undefined;
    if (
      path &&
      citationKind &&
      (expectedKind === undefined || expectedKind === citationKind)
    ) {
      references.push({ start, end, kind: citationKind, path, raw: rawPath });
    }
  }

  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = (match[2] ?? "").trim().replace(/^<|>$/gu, "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(href, start, end);
  }
  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = cleanPath(match[0] ?? "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(raw, start, end);
  }
  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const raw = (match[2] ?? "").trim();
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + (match[0]?.length ?? raw.length);
    if (!raw || rangesOverlap(fullStart, fullEnd, protectedRanges)) continue;
    protectedRanges.push([fullStart, fullEnd]);
    addReference(
      raw,
      fullStart + (match[0]?.indexOf(raw) ?? 0),
      fullStart + (match[0]?.indexOf(raw) ?? 0) + raw.length,
    );
  }
  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? "";
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (!raw || rangesOverlap(start, end, protectedRanges)) continue;
    addReference(raw, start, end);
  }

  const seen = new Set<string>();
  const deduplicatedFromLatest = references
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .filter((reference) => {
      const key = normalizeAbsolutePath(reference.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduplicatedFromLatest.reverse();
}

export interface ConversationPreviewFileReference {
  end: number;
  kind: ConversationPreviewFileKind;
  path: string;
  raw: string;
  start: number;
}

export type ConversationPreviewFileKind =
  | "markdown"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio";

/**
 * zcode 照搬（P1 补充）：`@zcode/shared` conversation-preview-artifacts.ts 私有辅助与剩余导出。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬；ConversationPreviewArtifactType 的
 * ConversationArtifactType 联合自 rows.ts 内联（避免拖入 v4 协议 schema 链）。
 */
export const conversationArtifactTypeSchema = z.enum([
  "pdf",
  "pptx",
  "docx",
  "xlsx",
  "image",
  "html",
  "md",
  "text",
]);
export type ConversationPreviewArtifactType =
  | z.infer<typeof conversationArtifactTypeSchema>
  | "video"
  | "audio";

export interface ConversationPreviewFileChange {
  path: string;
  state?: "active" | "reverted";
}

export interface ConversationPreviewArtifactCandidate {
  artifactType: ConversationPreviewArtifactType;
  displayName: string;
  mimeType: string;
  previewKind: ConversationPreviewFileKind;
  productTurnId: string;
  sourceKind: "user_input_attachment" | "assistant_preview_card";
  sourceRef: string;
  requiresFileChanges: boolean;
}

interface PreviewFileTypeDefinition {
  extensions: readonly string[];
  kind: ConversationPreviewFileKind;
  mimeType: string;
  artifactType: ConversationPreviewArtifactType;
}

const PREVIEW_FILE_TYPES: readonly PreviewFileTypeDefinition[] = [
  {
    extensions: [".md"],
    kind: "markdown",
    mimeType: "text/markdown",
    artifactType: "md",
  },
  {
    extensions: [".html", ".htm"],
    kind: "html",
    mimeType: "text/html",
    artifactType: "html",
  },
  {
    extensions: [".docx"],
    kind: "docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    artifactType: "docx",
  },
  {
    extensions: [".xlsx"],
    kind: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactType: "xlsx",
  },
  {
    extensions: [".pptx"],
    kind: "pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    artifactType: "pptx",
  },
  {
    extensions: [".pdf"],
    kind: "pdf",
    mimeType: "application/pdf",
    artifactType: "pdf",
  },
  ...MEDIA_PREVIEW_FORMATS.map(
    ({ extension, kind, mediaType }): PreviewFileTypeDefinition => ({
      extensions: [extension],
      kind,
      mimeType: mediaType,
      artifactType: kind,
    }),
  ),
];

export const CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT = 15;

export const CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT = 10;

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*，。！？；：、]+/giu;

const FILE_CITATION_RE = /:{1,2}zcode-file-citation\{([^}]*)\}/giu;

const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

const DELIMITED_FILE_PATH_RE =
  /([`"'])([^`"'\r\n]+?\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)\1/giu;

const FILE_PATH_RE =
  /(?:^|[\s("'`,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)(?=$|[\s)"'`,.;:!?，。！？；：、])/giu;

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, "/");
}

function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/gu, "")
    .replace(/:\d+(?::\d+)?$/u, "");
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function parseFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodePath(url.pathname);
    if (/^\/[a-zA-Z]:\//u.test(pathname)) return pathname.slice(1);
    if (url.hostname && url.hostname !== "localhost")
      return `//${url.hostname}${pathname}`;
    return pathname;
  } catch {
    return null;
  }
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/u.test(path) ||
    path.startsWith("\\\\")
  );
}

function normalizeRelativePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of normalizeSlashes(path).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/{2,}/gu, "/");
  const prefix = normalized.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join("/")}`;
}

export function resolveConversationPreviewPath(
  workspacePath: string,
  rawPath: string,
): string | null {
  const cleaned = cleanPath(rawPath);
  if (!cleaned) return null;
  // Shell 展示用的 Home-relative 路径不是稳定的预览卡片引用；只有明确 citation 或
  // Markdown/file URL 才能成为候选，避免把正文里的 `~/...` 当成 workspace 文件分享。
  if (/^~[\\/]/u.test(cleaned)) return null;
  const filePath = /^file:\/\//iu.test(cleaned)
    ? parseFileUrlPath(cleaned)
    : cleaned;
  if (!filePath) return null;
  if (isAbsolutePath(filePath)) return normalizeAbsolutePath(filePath);
  const relative = normalizeRelativePath(filePath);
  if (relative === null) return null;
  const workspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, "");
  return `${workspace}/${relative}`;
}

export function getConversationPreviewFileType(
  path: string,
): PreviewFileTypeDefinition | null {
  const normalized = cleanPath(path).toLowerCase();
  return (
    PREVIEW_FILE_TYPES.find((definition) =>
      definition.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}

function getPathLeaf(path: string): string {
  const segments = normalizeSlashes(path)
    .replace(/\/+$/u, "")
    .split("/")
    .filter(Boolean);
  return segments.at(-1) ?? path;
}

function isInsideWorkspace(path: string, workspacePath: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path).replace(/\/$/u, "");
  const normalizedWorkspace = normalizeAbsolutePath(workspacePath).replace(
    /\/$/u,
    "",
  );
  return (
    normalizedPath === normalizedWorkspace ||
    normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

function rangesOverlap(
  start: number,
  end: number,
  ranges: readonly [number, number][],
): boolean {
  return ranges.some(
    ([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart,
  );
}

function readDirectiveParameter(
  parameters: string,
  name: string,
): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(
    parameters,
  );
  return match?.[1]?.trim() || undefined;
}

export function buildConversationPreviewArtifactCandidatesFromReferences(input: {
  references: readonly ConversationPreviewFileReference[];
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
  enforceWorkspaceBoundary?: boolean;
}): ConversationPreviewArtifactCandidate[] {
  const changes = input.fileChanges ?? [];
  const activePaths = new Set(
    changes
      .filter((change) => change.state !== "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ??
            change.path,
        ),
      ),
  );
  const revertedPaths = new Set(
    changes
      .filter((change) => change.state === "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ??
            change.path,
        ),
      ),
  );

  const seen = new Set<string>();
  return [...input.references]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .map((reference): ConversationPreviewArtifactCandidate | null => {
      const definition = getConversationPreviewFileType(reference.path);
      if (!definition) return null;
      const normalizedPath = normalizeAbsolutePath(reference.path);
      if (
        input.enforceWorkspaceBoundary !== false &&
        !isInsideWorkspace(normalizedPath, input.workspacePath)
      ) {
        return null;
      }
      const requiresFileChanges =
        reference.kind === "markdown" || reference.kind === "html";
      if (
        requiresFileChanges &&
        (!activePaths.has(normalizedPath) || revertedPaths.has(normalizedPath))
      ) {
        return null;
      }
      if (seen.has(normalizedPath)) return null;
      seen.add(normalizedPath);
      return {
        artifactType: definition.artifactType,
        displayName: getPathLeaf(reference.path),
        mimeType: definition.mimeType,
        previewKind: definition.kind,
        productTurnId: input.productTurnId,
        sourceKind: "assistant_preview_card" as const,
        sourceRef: reference.path,
        requiresFileChanges,
      };
    })
    .filter(
      (candidate): candidate is ConversationPreviewArtifactCandidate =>
        candidate !== null,
    )
    .slice(0, CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT);
}

export function buildConversationPreviewArtifactCandidates(input: {
  assistantText: string;
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
}): ConversationPreviewArtifactCandidate[] {
  return buildConversationPreviewArtifactCandidatesFromReferences({
    ...input,
    references: extractConversationPreviewFileReferences(
      input.assistantText,
      input.workspacePath,
    ),
  });
}
