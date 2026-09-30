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

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` tool-plan-adapter.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 */

export function extractPlanStepsFromToolOutput(params: {
  title?: string | undefined;
  kind?: string | undefined;
  output: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  for (const candidate of collectOutputCandidates(params.output)) {
    const steps = extractPlanStepsFromValue(candidate);
    if (steps) {
      return steps;
    }
  }

  return null;
}

export function extractPlanStepsFromToolInput(params: {
  title?: string | undefined;
  kind?: string | undefined;
  input: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  return extractPlanStepsFromValue(params.input);
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` zcode-task-types-core.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 */

export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` test-ids.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：TID_CHAT_TOOL_CALL_BLOCK, TID_TOOL_SUMMARY_TRIGGER, testId
 */

/** 工具调用摘要行触发按钮（动态后缀为 toolId） */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";
/** 聊天工具调用块容器（动态后缀为 toolCallId） */
export const TID_CHAT_TOOL_CALL_BLOCK = "chat-tool-call-block";

/** 为动态元素生成带后缀的 testid，如 file-tree-item-/home/user */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` tool-call-summary.ts 全量。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 私有辅助 isRecord 与下方 tool-plan-adapter 切片共用一份（两源逐字相同）。
 */

export type CompactToolCallState =
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error";

export interface ToolCallSummarySource {
  title?: string | undefined;
  kind: string;
  input: unknown;
  output?: unknown;
  raw?: unknown | undefined;
}

export interface ToolCallChangeStat {
  added: number;
  removed: number;
}

export interface ToolCallSummary {
  primaryText: string;
  secondaryText?: string | undefined;
  changeStat?: ToolCallChangeStat | undefined;
}

const TOOL_CALL_RUNNING_STATES = new Set<CompactToolCallState>([
  "input-streaming",
  "input-available",
]);

const TOOL_CALL_FINISHED_STATES = new Set<CompactToolCallState>([
  "output-available",
  "output-error",
  "output-denied",
]);

const TOOL_CALL_STATUS_MESSAGE_IDS: Record<CompactToolCallState, string> = {
  "input-streaming": "chat.toolCall.status.pending",
  "input-available": "chat.toolCall.status.running",
  "output-available": "chat.toolCall.status.completed",
  "output-error": "chat.toolCall.status.failed",
  "output-denied": "chat.toolCall.status.denied",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisplayText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++;
  }
  if (value.charCodeAt(value.length - 1) === 10) count--;
  return count;
}

function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function extractBeforeAfterText(
  source: unknown,
): { before: string; after: string } | null {
  if (!isRecord(source)) {
    return null;
  }

  const before = readFirstStringField(source, [
    "old_string",
    "oldString",
    "oldText",
    "before",
  ]);
  const after = readFirstStringField(source, [
    "new_string",
    "newString",
    "newText",
    "after",
    "content",
  ]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  const metadata = source["metadata"];
  if (isRecord(metadata)) {
    const fileDiff = metadata["filediff"];
    if (isRecord(fileDiff)) {
      const nestedBefore = readFirstStringField(fileDiff, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const nestedAfter = readFirstStringField(fileDiff, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (nestedBefore !== undefined && nestedAfter !== undefined) {
        return { before: nestedBefore, after: nestedAfter };
      }
    }
  }

  const contentBlocks = source["content"];
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }
      const blockBefore = readFirstStringField(block, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const blockAfter = readFirstStringField(block, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (blockBefore !== undefined && blockAfter !== undefined) {
        return { before: blockBefore, after: blockAfter };
      }
    }
  }

  return null;
}

function getChangeStat(
  kind: string,
  input: unknown,
  output?: unknown,
  raw?: unknown,
): ToolCallChangeStat | undefined {
  if (!/(edit|patch|replace|multi.?edit)/i.test(kind)) return undefined;

  const changeSource =
    extractBeforeAfterText(input) ??
    extractBeforeAfterText(output) ??
    extractBeforeAfterText(raw);
  if (!changeSource) return undefined;

  const removed = countLines(changeSource.before);
  const added = countLines(changeSource.after);
  if (added === 0 && removed === 0) return undefined;

  return { added, removed };
}

function getInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") {
    const summary = normalizeDisplayText(input);
    return summary.length > 0 ? summary : undefined;
  }

  if (!isRecord(input)) {
    return undefined;
  }

  for (const key of [
    "command",
    "path",
    "file_path",
    "filePath",
    "prompt",
  ] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const summary = normalizeDisplayText(candidate);
    if (summary.length > 0) {
      return summary;
    }
  }

  return undefined;
}

export function isCompactToolCallRunningState(
  state: string,
): state is CompactToolCallState {
  return TOOL_CALL_RUNNING_STATES.has(state as CompactToolCallState);
}

export function isCompactToolCallFinishedState(
  state: string,
): state is CompactToolCallState {
  return TOOL_CALL_FINISHED_STATES.has(state as CompactToolCallState);
}

export function getCompactToolCallStatusMessageId(
  state: string,
  rawStatus?: string,
): string {
  if (rawStatus === "stopped") {
    return "chat.toolCall.status.stopped";
  }

  return (
    TOOL_CALL_STATUS_MESSAGE_IDS[state as CompactToolCallState] ??
    "chat.toolCall.status.pending"
  );
}

export function getCompactToolCallSummary({
  title,
  kind,
  input,
  output,
  raw,
}: ToolCallSummarySource): ToolCallSummary {
  const changeStat = getChangeStat(kind, input, output, raw);
  const primaryText = (title && normalizeDisplayText(title)) || "tool";
  const secondaryText = getInputSummary(input);
  return {
    primaryText,
    secondaryText,
    changeStat,
  };
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` lineChangeStat.ts 全量。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 */

const MAX_LCS_CELLS = 400_000;

function splitIntoLogicalLines(content: string | null): string[] {
  if (!content) {
    return [];
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export interface LineChangeStat {
  added: number;
  removed: number;
}

export function computeLineChangeStat(
  beforeContent: string | null,
  afterContent: string,
): LineChangeStat {
  const beforeLines = splitIntoLogicalLines(beforeContent);
  const afterLines = splitIntoLogicalLines(afterContent);

  let prefixIndex = 0;
  while (
    prefixIndex < beforeLines.length &&
    prefixIndex < afterLines.length &&
    beforeLines[prefixIndex] === afterLines[prefixIndex]
  ) {
    prefixIndex += 1;
  }

  let beforeTailIndex = beforeLines.length - 1;
  let afterTailIndex = afterLines.length - 1;
  while (
    beforeTailIndex >= prefixIndex &&
    afterTailIndex >= prefixIndex &&
    beforeLines[beforeTailIndex] === afterLines[afterTailIndex]
  ) {
    beforeTailIndex -= 1;
    afterTailIndex -= 1;
  }

  const trimmedBefore = beforeLines.slice(prefixIndex, beforeTailIndex + 1);
  const trimmedAfter = afterLines.slice(prefixIndex, afterTailIndex + 1);

  if (trimmedBefore.length === 0) {
    return { added: trimmedAfter.length, removed: 0 };
  }

  if (trimmedAfter.length === 0) {
    return { added: 0, removed: trimmedBefore.length };
  }

  // UI 的 edit 卡片和任务摘要都需要“真实改动行数”，
  // 不能把 before/after 总行数直接当成 +/-。这里统一做一次行级 LCS 统计，
  // 再由各端复用同一份结果，避免不同入口展示出不同计数。
  //
  // 另外超大文件如果强行算完整 LCS，会让列表和消息面板明显卡顿，
  // 所以超过阈值时退回到保守估算，优先保证交互流畅。
  if (trimmedBefore.length * trimmedAfter.length > MAX_LCS_CELLS) {
    return { added: trimmedAfter.length, removed: trimmedBefore.length };
  }

  const lcs = Array.from({ length: trimmedAfter.length + 1 }, () => 0);
  for (
    let beforeIndex = 1;
    beforeIndex <= trimmedBefore.length;
    beforeIndex += 1
  ) {
    let previousDiagonal = 0;
    for (
      let afterIndex = 1;
      afterIndex <= trimmedAfter.length;
      afterIndex += 1
    ) {
      const previousRow = lcs[afterIndex]!;
      if (trimmedBefore[beforeIndex - 1] === trimmedAfter[afterIndex - 1]) {
        lcs[afterIndex] = previousDiagonal + 1;
      } else {
        lcs[afterIndex] = Math.max(lcs[afterIndex]!, lcs[afterIndex - 1]!);
      }
      previousDiagonal = previousRow;
    }
  }

  const unchangedLineCount = lcs[trimmedAfter.length] ?? 0;
  return {
    added: trimmedAfter.length - unchangedLineCount,
    removed: trimmedBefore.length - unchangedLineCount,
  };
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` model-selection.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：modelSelectionSchema, ModelSelection
 */

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` zcode-task-types-core.ts / zcode-agent-policy.ts /
 * subagents-types.ts 的消费切片（subagents store 与 CUA renderer 消费面）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：ZCodeProvider, ZCODE_AGENT_PROVIDER, normalizeAgentProviderToZCodeAgent, AgentColor,
 * AgentScope, AgentSource, AgentPermissionMode, AgentDiagnostic, AgentSummary, AgentsCapability,
 * SubAgentConfig
 */

/** 支持的 ZCode agent 提供方；当前仅保留 glm。 */
export type ZCodeProvider = "glm";

export const ZCODE_AGENT_PROVIDER = "glm" satisfies ZCodeProvider;

export function normalizeAgentProviderToZCodeAgent(
  _provider?: ZCodeProvider | null,
): ZCodeProvider {
  return ZCODE_AGENT_PROVIDER;
}

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` streaming-tool-input-preview.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：ZCodeStreamingToolInputPreview, buildZCodeStreamingToolInputPreview（含其私有辅助）。
 */

export interface ZCodeStreamingToolInputPreview {
  complete: boolean;
  input: unknown;
  rawInput: string;
}

const PARTIAL_JSON_STRING_FIELD_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  // ExitPlanMode 的正文位于 plan 字段。把它纳入半截 JSON 预览后，计划卡片与
  // 侧边详情才能从首个流式 chunk 开始更新，而不是等 input_end 才突然出现。
  "plan",
  // CreateWorkflow 的脚本与名字：流式草稿
  // 要在模型还在写脚本时就把站扫出来，半截 script 必须从首个 chunk 起就进预览。
  "name",
  "script",
] as const;

export function buildZCodeStreamingToolInputPreview(
  rawInput: string,
  completeInput?: unknown,
): ZCodeStreamingToolInputPreview {
  if (completeInput !== undefined) {
    return {
      complete: true,
      input: completeInput,
      rawInput,
    };
  }

  const parsed = parseCompleteJson(rawInput);
  if (parsed.ok) {
    return {
      complete: true,
      input: parsed.value,
      rawInput,
    };
  }

  return {
    complete: false,
    input: readPartialJsonObjectPreview(rawInput) ?? {},
    rawInput,
  };
}

function parseCompleteJson(
  value: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function readPartialJsonObjectPreview(
  rawInput: string,
): Record<string, string> | null {
  const preview: Record<string, string> = {};
  for (const key of PARTIAL_JSON_STRING_FIELD_KEYS) {
    const value = readPartialJsonStringField(rawInput, key);
    if (value !== undefined) {
      preview[key] = value;
    }
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

function readPartialJsonStringField(
  rawInput: string,
  key: string,
): string | undefined {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`).exec(rawInput);
  if (!match) {
    return undefined;
  }

  let encoded = "";
  let escaped = false;
  let closed = false;
  for (
    let index = match.index + match[0].length;
    index < rawInput.length;
    index += 1
  ) {
    const char = rawInput[index] ?? "";
    if (escaped) {
      encoded += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      closed = true;
      break;
    }
    encoded += char;
  }
  if (escaped) {
    encoded += "\\";
  }

  return decodeJsonStringSegment(encoded, closed);
}

function decodeJsonStringSegment(encoded: string, closed: boolean): string {
  const normalized = closed ? encoded : trimDanglingJsonEscape(encoded);
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return decodeJsonStringSegmentBestEffort(normalized);
  }
}

function trimDanglingJsonEscape(value: string): string {
  return value.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
}

function decodeJsonStringSegmentBestEffort(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` uuid.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：createUuid（含其私有辅助 byteToHex / formatUuid）。
 */

function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

function formatUuid(bytes: Uint8Array): string {
  const normalized = new Uint8Array(bytes);
  normalized[6] = (normalized[6]! & 0x0f) | 0x40;
  normalized[8] = (normalized[8]! & 0x3f) | 0x80;

  const segments = [
    normalized.slice(0, 4),
    normalized.slice(4, 6),
    normalized.slice(6, 8),
    normalized.slice(8, 10),
    normalized.slice(10, 16),
  ];

  return segments
    .map((segment) => Array.from(segment, byteToHex).join(""))
    .join("-");
}

export function createUuid(): string {
  const runtimeCrypto = globalThis.crypto;
  if (runtimeCrypto?.randomUUID) {
    return runtimeCrypto.randomUUID();
  }

  if (runtimeCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    runtimeCrypto.getRandomValues(bytes);
    return formatUuid(bytes);
  }

  // 部分移动端 WebView 只有 `crypto` 对象但没有 `randomUUID()`，
  // 之前 UI 初始化直接调用会在首屏崩掉。这里退回到最小可用的随机实现，
  // 保证移动端至少能生成 tab / history / request 所需的临时 ID。
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return formatUuid(bytes);
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` platform.ts / cuaAccessibilitySettings.ts 的消费切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）。
 * 符号：ApplicationIconLocator, ApplicationIconRequest, BrowserTabResidencyState,
 * CuaPermissionKind, CuaAccessibilitySettingsResult
 */

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

export type CuaPermissionKind = "accessibility" | "screen_recording";

export interface CuaAccessibilitySettingsResult {
  success: boolean;
  canceled?: boolean;
  /** main 级 onboarding 会话 id；同一 Helper identity 的并发窗口共享同一 id。 */
  sessionId?: string;
  /** 只有所有 staged 设置页都观察到任意 ZCode 窗口返回后才为 true。 */
  returnedFromSettings?: boolean;
  /**
   * 同一 main onboarding 会话可能被多个窗口加入。每个独立 renderer/host 只有一个调用拿到 true，负责
   * 重启该 host 的 Helper；同一 renderer 的重复调用拿到 false。不能全局只选一个窗口，因为每个窗口
   * 都有独立 host/Helper，授权前已启动的进程都需要各自恢复。
   * undefined 是旧 main 的兼容形状，按单窗口 owner 处理。
   */
  restartHelperAfterReturn?: boolean;
  error?: string;
}

/**
 * zcode 照搬（P2 补充）：`@zcode/shared` tool-plan-adapter.ts 的私有辅助切片。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（手册 §2.1）；
 * 私有辅助 isRecord 与上方 tool-call-summary 切片共用一份（两源逐字相同）。
 * 符号：PLAN_COLLECTION_KEYS, readString, normalizePlanStatus, parsePlanStep, parseJsonValue,
 * readPlanCollection, extractPlanStepsFromValue, collectOutputCandidates
 */

const PLAN_COLLECTION_KEYS = ["todos", "plan", "steps", "items"] as const;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizePlanStatus(value: unknown): ZCodePlanStep["status"] | null {
  const status = readString(value)?.replace(/-/g, "_").toLowerCase();
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed"
  ) {
    return status;
  }
  return null;
}

function parsePlanStep(value: unknown, index: number): ZCodePlanStep | null {
  if (typeof value === "string") {
    const title = value.trim();
    return title
      ? { id: title, title, status: index === 0 ? "in_progress" : "pending" }
      : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const title =
    readString(value.content) ??
    readString(value.step) ??
    readString(value.title) ??
    readString(value.text) ??
    readString(value.activeForm);
  const status = normalizePlanStatus(value.status);
  if (!title || !status) {
    return null;
  }

  return {
    id: readString(value.id) ?? title,
    title,
    status,
  };
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readPlanCollection(input: unknown): unknown[] | null {
  const value = typeof input === "string" ? parseJsonValue(input) : input;
  if (!isRecord(value)) {
    return null;
  }
  for (const key of PLAN_COLLECTION_KEYS) {
    const collection = value[key];
    if (Array.isArray(collection)) {
      return collection;
    }
  }
  return null;
}

function extractPlanStepsFromValue(value: unknown): ZCodePlanStep[] | null {
  const collection = readPlanCollection(value);
  if (!collection || collection.length === 0) {
    return null;
  }

  const steps = collection
    .map((item, index) => parsePlanStep(item, index))
    .filter((step): step is ZCodePlanStep => step !== null);

  return steps.length === collection.length ? steps : null;
}

function collectOutputCandidates(output: unknown): unknown[] {
  const candidates: unknown[] = [output];
  const parsedOutput =
    typeof output === "string" ? parseJsonValue(output) : undefined;
  if (parsedOutput !== undefined) {
    candidates.push(parsedOutput);
  }

  if (isRecord(output)) {
    for (const key of ["content", "output", "result"] as const) {
      const value = output[key];
      candidates.push(value);
      if (typeof value === "string") {
        const parsedValue = parseJsonValue(value);
        if (parsedValue !== undefined) {
          candidates.push(parsedValue);
        }
      }
    }
  }

  return candidates;
}
