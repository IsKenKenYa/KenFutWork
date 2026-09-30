/**
 * zcode 移植层宿主适配：`@zcode/shared` 的最小等价（只收录照搬组件实际消费的切片）。
 * 来源：references/zcode/packages/shared/src/{platform,protocol,remoteTarget,test-ids,markdown-artifact-images}.ts
 * 许可证：Apache-2.0（zcode）。
 * 适配口径：类型逐字照搬；运行时函数（artifact 图片重写 / remoteTarget 构造）为纯函数照搬。
 * 远程连接类型（SSH/WSL/Docker）仅作类型保留——我们宿主暂无远程工作区，platform stub 永远不会返回 remoteTarget。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
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
  remoteTarget?: OpenInEditorRemoteTarget | undefined;
  workspaceIdentity?: string | undefined;
  pathKind?: "file" | "directory" | undefined;
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
        ...(target.port === undefined ? {} : { port: target.port }),
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
 * 符号：ZCodeProvider, ZCODE_AGENT_PROVIDER, normalizeAgentProviderToZCodeAgent, isZCodeAgentProvider, AgentColor,
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

export function isZCodeAgentProvider(
  provider: ZCodeProvider | null | undefined,
): provider is typeof ZCODE_AGENT_PROVIDER {
  return provider === ZCODE_AGENT_PROVIDER;
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

/* ---------- zcode 照搬（P5 补充）：跨切片类型导入 ---------- */

import process from "node:process";
import type { ErrorAttribution } from "./zcode-shared/zcode-protocol-v4";
import type { ToolCallDisplay } from "./zcode-shared/zcode-protocol-v4/toolDisplay";

/** zcode 照搬（P5 补充）：zcode-protocol 共享的最小串约束（多个 schema 切片复用）。 */
const nonEmptyString = z.string().trim().min(1);

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` oauth.ts（切片） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

/** 内置 BigModel provider id */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** 内置 ZAI provider id */
export const ZAI_PROVIDER_ID = "zai" as const;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` oauth.ts（切片续） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** OAuth provider 标识 */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/** Provider 展示元信息 */

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` model-provider-types.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

export const BUILTIN_MODEL_PROVIDER_IDS = {
  zaiIndividualCodingPlan: "account:zai-individual-coding-plan",
  zaiTeamCodingPlan: "account:zai-team-coding-plan",
  zaiStartPlan: "account:zai-start-plan",
  bigmodelIndividualCodingPlan: "account:bigmodel-individual-coding-plan",
  bigmodelTeamCodingPlan: "account:bigmodel-team-coding-plan",
  bigmodelStartPlan: "account:bigmodel-start-plan",
} as const;

export type BuiltinOAuthProviderId = keyof typeof BUILTIN_MODEL_PROVIDER_IDS;

export type BuiltinModelProviderId =
  (typeof BUILTIN_MODEL_PROVIDER_IDS)[BuiltinOAuthProviderId];

export function isBuiltinModelProviderId(
  id: string,
): id is BuiltinModelProviderId {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

export function isZaiCodingPlanProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  );
}

export function isBigModelStartPlanProviderId(id: string): boolean {
  return id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
}

export function isStartPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/**
 * 个人版 Coding Plan（不含 Start Plan 与 Team Plan）。
 * Start Plan 用 disconnected 展示领取/付费卡，Team Plan 有独立文案，
 * "服务端明确无权益"只对个人版需要区分成"未开通"。
 */
export function isIndividualCodingPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  );
}

export function isCodingPlanModelProviderId(id: string): boolean {
  return (
    isZaiCodingPlanProviderId(id) ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` workspacePurpose.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** App 持有的 workspace 展示分类；不参与 workspace identity。 */
export type WorkspacePurpose = "project" | "conversation";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` protocol.ts（切片：WorkspaceFileEntry/Locale/TabId/TabState） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` protocol.ts（切片续） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** 支持的语言 */
export type Locale = "zh-CN" | "en-US";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` protocol.ts（切片续2） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** 标签页唯一标识 */
export type TabId = string;

/** 单个标签页的状态 */
export interface TabState {
  id: TabId;
  /** workspace 绝对路径 */
  workspacePath: string;
  /** 显示名称，通常为路径最后一段 */
  label: string;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` test-ids.ts（切片：composer/输入建议/工具栏 TID） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const TID_CHAT_ATTACHMENT_MENU_ITEM = "chat-attachment-menu-item";
/** 聊天发送按钮 */
export const TID_CHAT_SEND_BUTTON = "chat-send-button";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` test-ids.ts（切片续） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** 聊天输入框前缀提示面板 */
export const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
/** 聊天输入框前缀提示分组（动态后缀为分组 id） */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** 聊天输入框前缀提示选项（动态后缀为选项 id） */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** 聊天输入框前缀提示状态行（动态后缀为分组 id） */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` test-ids.ts（切片续2） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
// Chat Toolbar
/** 聊天工具栏模型选择按钮 */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** 聊天工具栏模型供应商分组（动态后缀为 provider group key） */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** 聊天工具栏模型选择条目（动态后缀为模型 value） */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** 聊天工具栏思考深度选择按钮 */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER =
  "chat-thought-level-select-trigger";
/** 聊天工具栏思考深度选择条目（动态后缀为思考深度 value） */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM =
  "chat-thought-level-select-item";
/** 聊天工具栏模式选择按钮（v4 switchCollaborationMode e2e 锚点） */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** 聊天工具栏模式选择条目（动态后缀为 mode value） */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** 聊天工具栏 context 消耗按钮 */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** 思考块折叠触发按钮 */

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：TraceId/InputId/QueryId） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** 全链路追踪 ID，用于日志和观测链路。 */
export type TraceId = string;
/** 每次用户输入的归属 ID，用于 stop/队列/终态收口。 */
/** 每条真实用户 query 的语义归因 ID，用于模型请求 header 和用户问题级观测。 */
export type QueryId = string;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：task 元数据依赖） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeTaskMigrationSource = "claudeCode";
export type ZCodeTaskGoalStatus =
  | "active"
  | "paused"
  | "budget_limited"
  | "complete";
export type ZCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：ZCodeTaskGoal） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: ZCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：ZCodeTaskMode） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeTaskMode =
  | "yolo"
  | "plan"
  | "edit"
  | "auto"
  | "autoEdit"
  | "build";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：运行时状态/持久状态/最后错误） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";
/** 持久化的任务状态，记录最后一次 prompt 的结果 */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";
export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * 当前 prompt 支持的附件类型。
 * 图片小文件走 agent image block；本地文件/大图片优先走 localPath，让 agent 按自己的阈值读取。

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：交互自动裁决/挂起交互） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeTaskInteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface ZCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** sessions-index 下发的轻量工具身份；旧摘要缺失时保持兼容。 */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：ZCodeTaskMeta） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeTaskMeta {
  /** UI taskId 与 ZCode agent sessionId 保持一致，用于列表选择、日志关联和恢复会话。 */
  taskId: string;
  /** session/任务级观测 traceId，不用于区分单次用户输入 */
  traceId: TraceId;
  /** 任务标题（用户输入或从首条消息截取） */
  title: string;
  /**
   * 用户是否手动覆盖过任务标题。
   *
   * 运行中 agent 仍会继续推送自动生成标题；UI 需要知道当前标题是手动命名，
   * 才能在更新 status/target/updatedAt 时避免把手动标题短暂冲掉。
   */
  titleOverridden?: boolean | undefined;
  /** 关联的 workspace 绝对路径 */
  workspacePath: string;
  /**
   * 远程 workspace 的稳定身份（authority + canonicalPath）。
   *
   * 仅按 workspacePath 持久化时，“同路径不同远端主机”会写进同一目录，
   * 导致任务列表、快照和日志互相串读。这里补充 workspaceIdentity 参与隔离。
   */
  workspaceIdentity?: string | undefined;
  /** app-owned workspace 分类；缺省为 project，不参与 workspaceKey。 */
  workspacePurpose?: WorkspacePurpose | undefined;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string | undefined;
  /**
   * task 级推理强度。
   *
   * active task 内切换 effort 时，如果只写 workspace settings.json，
   * 同一 workspace 的其它 task 会被串改；如果只改 session，下一轮 prompt 又可能被
   * workspace 默认值回推覆盖。这里单独持久化 task-local thoughtLevel，发送前再重放到 session。
   */
  thoughtLevel?: string | undefined;
  /**
   * 该 task 最近一次确认与 workspace 运行时基线对齐的 epoch。
   *
   * 过去仅靠 workspacePreferredModel 判断“要不要覆盖当前 task 模型”，
   * 会把“同 supplier 的 task 内模型切换”误当成全局收敛，导致其它 task 被串改。
   * 这里记录 runtimeEpoch，用来区分“task 自身模型保持”与“runtime 基线确实变更后需要收敛”。
   */
  runtimeEpoch?: number | undefined;
  /** 创建此 task 时使用的 agent provider，缺省视为 "glm"（旧数据兼容） */
  provider?: ZCodeProvider | undefined;
  /** 迁移来源；普通新建任务为空，用于识别 Claude Code 原生历史导入。 */
  migrationSource?: ZCodeTaskMigrationSource | undefined;
  /**
   * cron 身份标记：该 session 属于哪条 automation。
   *
   * cron 身份必须定义在共享的 ZCodeTaskMeta 上，供持久化层、V4 UI 和服务契约
   * 共同使用，避免字段已持久化却无法经类型契约访问。
   */
  cronAutomationId?: string | undefined;
  /**
   * 闲时任务身份标记：该 session/幻影行属于哪条 off-peak 任务。
   * 与 cronAutomationId 是兄弟标记（闲时不复用 cron 标记）；行 id = 创建时
   * 预分配的 sessionId，标记从创建到运行恒定，供月亮图标与系统分组归属使用。
   */
  offPeakTaskId?: string | undefined;
  /** fork 产物保留来源 taskId，供 UI 做本地化标题兜底和后续追溯。 */
  forkedFromTaskId?: string | undefined;
  /** 未读任务记录最近一次标记/产生未读的时间，用于跨重启保留蓝点状态。 */
  unreadAt?: number | undefined;
  /** 持久化的任务状态，记录最后一次 prompt 的结果 */
  status?: ZCodeTaskPersistStatus | undefined;
  /** sessions-index 提供的队首阻塞交互摘要，供未打开的后台 task 渲染侧栏状态。 */
  pendingInteraction?: ZCodeTaskPendingInteraction | undefined;
  /**
   * 最后一次失败的可展示原因。
   *
   * 手机远控断连时实时 task_error 可能无法送达；恢复只能看到 meta.status=error，
   * 但拿不到错误正文，用户会以为发送没有触发。这里把失败原因随 task meta 一起持久化。
   */
  lastError?: ZCodeTaskLastError | undefined;
  /** 任务级文件改动摘要，仅用于列表/标题展示，真实回滚仍以 fileChanges 为准 */
  changeSummary?: ZCodeTaskChangeSummary | undefined;
  /** zcode-cli /goal 会话目标；null 表示已显式清空。 */
  target?: ZCodeTaskGoal | null | undefined;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：文件改动摘要） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeTaskChangeSummary {
  /** 整个任务里涉及过的唯一文件数 */
  fileCount: number;
  /** 按最终文件结果聚合后的新增行数 */
  added: number;
  /** 按最终文件结果聚合后的删除行数 */
  removed: number;
  /** 任务涉及的文件摘要 */
  files: ZCodeTaskChangedFileSummary[];
}
export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** 同一任务内该文件被写入的总次数 */
  writeCount: number;
  /** 最后一次写入发生在第几轮，后续回滚按钮可直接复用 */
  lastTurnIndex: number;
}
// ---- ZCode 配置与命令类型 ----

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：configOption/SelectValue/SlashCommand） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | 自定义 */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** type === "select" 时的选项列表 */
  options?: ZCodeConfigSelectValue[] | undefined;
}
export interface ZCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** 值来源：原生模型列表或会话侧注入项（用于 UI 去重与展示控制） */
  origin?: "native" | "injected";
  /** 模型选项所属供应商/分组 id，用于 provider -> model 分组选择 */
  modelProviderId?: string;
  /** 模型选项所属供应商/分组展示名 */
  modelProviderName?: string;
  /** 缺失表示能力未知，空数组表示已知没有可选 reasoning 档位 */
  modelThoughtLevels?: string[];
  /** 模型目录声明的默认 reasoning 档位，不代表用户显式选择 */
  modelDefaultThoughtLevel?: string;
}
export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** 命令来源；旧协议可能为空，客户端应按 builtin 兼容处理。 */
  source?: "builtin" | "custom";
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：permission 请求族） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: ZCodePermissionOption[];
  /** V4 permission 是否允许在 Deny 时附带用户反馈。 */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * 工具自报的确认预览，复用 tool call row 的 display 投影（同一有界形状）。
   * 缺省 = 纯文本 ask（legacy v3 链路会显式剥离该字段）。
   */
  display?: ToolCallDisplay;
  /** agent RequestPermissionRequest.toolCall 原始 payload */
  raw: unknown;
}
export interface ZCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: ZCodePermissionResponse;
}
export interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: ZCodePermissionResponse;
}
/** ZCode Elicitation 请求事件，用于 AskUserQuestion 等需要用户交互的工具 */

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：elicitation 请求族） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
  /** AskUserQuestion 的多题结构；存在时 UI 以 tab 形式一次性收集全部答案。 */
  questions?: ZCodeElicitationQuestion[];
  /** remote 控制链路同步的当前题号，用于跨端保持 AskUserQuestion 进度。 */
  currentQuestionIndex?: number;
  /** remote 控制链路同步的草稿答案，key 为 answer_0 / answer_1。 */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** ElicitationSchema 原始 payload */
  schema?: unknown;
}
/** ZCode Elicitation 单个问题 */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}
/** ZCode Elicitation 选项 */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：Usage/ContextCacheUsage） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ZCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 推理/思考消耗的 token 数；对齐 agent `thoughtTokens`。 */
  reasoningTokens?: number;
  /** 命中缓存的 input token 数 */
  cachedInputTokens?: number;
  /** 写入缓存的 input token 数 */
  cachedWriteInputTokens?: number;
}
export interface ZCodeContextCacheUsage {
  /** Provider 上报的最近一次主轮输入 token 数。 */
  inputTokens: number;
  /** Provider 上报的最近一次主轮缓存命中 token 数。 */
  cacheReadTokens: number;
  /** Provider 上报的最近一次主轮缓存写入 token 数。 */
  cacheWriteTokens: number;
  /** 最近一次主轮 provider usage 的缓存命中率；未知时为 null。 */
  latestHitRate?: number | null;
  /** 参与累计平均的主轮请求数量。 */
  hitRateRequestCount?: number;
  /** 参与累计平均的主轮 input token 总量。 */
  totalInputTokens?: number;
  /** 参与累计平均的主轮 cache read token 总量。 */
  totalCacheReadTokens?: number;
  /** 参与累计平均的主轮 cache write token 总量。 */
  totalCacheWriteTokens?: number;
  /** Agent 归一化后返回给 app 的主轮累计平均缓存命中率；未知时为 null。 */
  hitRate: number | null;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：ZCodeApiRetryStatus） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** Agent API 遇到可重试错误时的临时状态；只用于内存 UI，不写入任务持久化。
 * attempt 表示当前正在进行的“第几次重试”，从 1 开始，不是总尝试次数。
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types.ts（切片：init 状态/ZCodeError） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** workspace 级 ZCode 初始化状态 */
export type ZCodeWorkspaceInitStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "failed";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-task-types.ts（切片续） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

export interface ZCodeError {
  code: string;
  message: string;
  traceId?: TraceId | undefined;
  taskId?: string | undefined;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` background-task-controls.ts（切片：控制项） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeBackgroundTaskControlStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "lost";

export interface ZCodeBackgroundTaskControlItem {
  jobId: string;
  toolCallId?: string;
  command: string;
  taskKind: "agent" | "bash";
  cancellable?: boolean;
  title?: string;
  status: ZCodeBackgroundTaskControlStatus;
  startedAt?: number;
  elapsedMs?: number;
  pid?: number;
  stdoutTail?: string;
  stderrTail?: string;
  outputTail?: string;
  raw?: unknown;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` shortcutCommands.ts（切片：ShortcutCommandId） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

/** 可配置快捷键的命令 ID，与 SHORTCUT_COMMANDS 一一对应。 */
export type ShortcutCommandId =
  | "toggleInterfaceMode"
  | "openOnboarding"
  | "openCommandCenter"
  | "openSettings"
  | "findInTask"
  | "toggleSidebar"
  | "switchTheme"
  | "toggleTerminal"
  | "toggleSidePane"
  | "previousConversation"
  | "nextConversation"
  | "navigateBack"
  | "navigateForward"
  | "openModelMenu"
  | "cycleSessionMode"
  | "cycleThoughtLevel"
  | "newTask"
  | "openWorkspace"
  | "closeActiveContext"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "composerSend"
  | "composerInsertNewline";

/**
 * 命令作用域：global = 全局分发（useAppKeyboard / 菜单 accelerator）；
 * composer = 聊天输入框聚焦时由 Lexical 键盘行为插件消费，其余分发方零感知。
 * Enter 族键因此可以安全入表——杀伤半径被限制在输入框内。
 */
/** 快捷键命令的分发通道：window = renderer 键盘分发（三端一致）；menu = 桌面应用菜单 accelerator。 */
export type ShortcutChannel = "window" | "menu";
export type ShortcutScope = "global" | "composer";

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol-legacy-types.ts（切片：permission response 族） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const zcodePermissionDecisionSchema = z.enum([
  "allow",
  "deny",
  "escalate",
  "modify",
]);
export const zcodePermissionRuleBehaviorSchema = z.enum([
  "allow",
  "deny",
  "ask",
]);
/** Backward-compatible wire/storage key interpreted only for trusted official CUA tools. */
export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME =
  "zcode:permission-capability:official_cua";
/**
 * workflow 运行确认窗第三选项「Refine」（拒绝并附修改意见）的稳定 optionId。
 * CLI 侧 v4 投影合成选项、broker 应答映射与 GUI 特判共用同一常量；
 * 该选项只在 v4 链路投放。
 */
export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";
export const zcodePermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();
export const zcodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: zcodePermissionRuleBehaviorSchema,
    rules: z.array(zcodePermissionRuleValueSchema).min(1),
  })
  .strict();
export const zcodePermissionResponseSchema = z
  .object({
    decision: zcodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
  })
  .strict();
export type ZCodePermissionResponse = z.infer<
  typeof zcodePermissionResponseSchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol-legacy-types.ts（切片：interaction origin） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const zcodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeInteractionRequestOrigin = z.infer<
  typeof zcodeInteractionRequestOriginSchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol-legacy-types.ts（切片：context usage breakdown） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const zcodeContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);
export const zcodeContextUsageBreakdownItemSchema = z
  .object({
    source: zcodeContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeContextUsageBreakdownItem = z.infer<
  typeof zcodeContextUsageBreakdownItemSchema
>;
export const zcodeContextUsageBreakdownSchema = z.array(
  zcodeContextUsageBreakdownItemSchema,
);

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：nonEmptyString） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：账号访问 schema） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const zcodeAccountAccessSchema = z.discriminatedUnion("planKind", [
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("start-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("individual-coding-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);
export type ZCodeAccountAccess = z.infer<typeof zcodeAccountAccessSchema>;

/** Active Model 固定的账号访问类别；当前商品和 Team scope 由账号服务在请求期解析。 */
export const zcodeProviderAccountAccessSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: z.enum([
      "start-plan",
      "individual-coding-plan",
      "team-coding-plan",
      "off-peak",
    ]),
    entitled: z.boolean(),
  })
  .strict();
export type ZCodeProviderAccountAccess = z.infer<
  typeof zcodeProviderAccountAccessSchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：Plugin 对话引用 catalog） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
// 不带 → workspace 当前 catalog（新建草稿 Picker）。身份与能力字段保持
// identifiers-only，不携带 rootPath/配置等；可选 icon/displayName(I18n)/description(I18n)
// 仅供 UI 展示与 Picker 搜索，不参与身份、权限或 runtime reminder。
export const zcodePluginReferenceCatalogEntrySchema = z
  .object({
    // 仅 referenceCatalogWithCategory 返回；旧入口保持原结构。
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    // 商店 listing 的 display-only 本地化显示名投影（沿 icon 先例）：让 Picker 能按
    // 中文显示名搜索/展示；locale 解析复用 shared 的 plugin-display-name helper。
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    // 仅供 Picker 展示，不进入能力身份或 model-only reminder。
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // 非空 = 与其他 enabled Plugin 共享 manifest name 的 V1 fail closed 冲突：
    // Picker 禁选并展示原因，runtime 解析按 ambiguous 跳过。
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // 旧 Host 不投影该字段时按空数组兼容；只有新 Agent 会把它用于 reminder live 交集。
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ZCodePluginReferenceCatalogEntry = z.infer<
  typeof zcodePluginReferenceCatalogEntrySchema
>;

// ── Skill 对话引用 catalog──
// 新草稿读取 workspace 当前目录；已有 Session 读取 AgentRuntime 首次 context
// 初始化时冻结的发现结果。该协议只承载 Composer 的只读引用投影，不替代 Settings
// 的 Skill 管理接口，也不持久化 runtime 快照。
export const zcodeSkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillReferenceCatalogEntry = z.infer<
  typeof zcodeSkillReferenceCatalogEntrySchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：Plugin Store Listing） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
// 商店信息（Store Listing）：目录条目携带的展示性元数据（显示名/icon/分类/作者/链接/hero/
// 示例提示词），全部可选，UI 缺失时按降级矩阵处理（字母头像/隐藏区块/省略信息行）。
// i18n 采用 `<字段>I18n` map，locale 解析复用 shared 的 plugin-display-name helper。
export const zcodePluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * 需要付费套餐才好用的插件：市场目录条目声明 `requiresPaidPlan: true`，
     * UI 在标题右侧展示提示图标。描述的是「使用条件」而非「插件是收费商品」——
     * 不参与安装门禁与计费，命名也不绑定具体套餐商品名。
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type ZCodePluginStoreListing = z.infer<
  typeof zcodePluginStoreListingSchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` usage-quota.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/**
 * Coding Plan 额度相关的纯类型定义。
 *
 * 从 usage-stats.ts 拆出：MCP 额度接入后该文件超过 oxlint max-lines(400) 门禁，
 * 而额度是可以独立描述的一组类型（不依赖统计聚合结构），拆出后两边都在门禁内。
 * 这里只依赖自身，usage-stats.ts 单向导入并 re-export，不构成循环依赖。
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Start Plan 服务端额度桶及周期身份；周期时间为毫秒，供提醒去重。 */
  bucketId?: string | undefined;
  userPlanId?: string | undefined;
  periodStart?: number | undefined;
  periodEnd?: number | undefined;
  /** 所属 entitlement 的周期类型，如 daily / one_time。 */
  period?: string | undefined;
  meter?: string | undefined;
  unitType?: string | undefined;
  /** Start Plan bucket 所属套餐身份，仅用于设置页按 plan 分组展示。 */
  planId?: string | undefined;
  unit?: number | undefined;
  number?: number | undefined;
  usage?: number | undefined;
  currentValue?: number | undefined;
  remaining?: number | undefined;
  percentage?: number | undefined;
  nextResetTime?: number | undefined;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

/**
 * `aggregate.type` 的合成值。
 *
 * 不复用 TOKENS_LIMIT / TIME_LIMIT：`isSameLimitCategory` 会把 TIME_LIMIT 判为工具额度同类，
 * 让 MCP 汇总额度被现有的 findCodingPlanQuotaLimit 查询误命中。
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** MCP 额度所属的 Coding Plan 连接，供 UI 判断能否显示在当前 provider tab 下。 */
export type UsageMcpQuotaScope =
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "PERSONAL";
    }
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "TEAM";
      organizationId: string;
      projectId: string;
    };

export interface UsageMcpQuotaSnapshot {
  /** 服务端 server_time，毫秒（接口返回 Unix 秒）。 */
  serverTime: number;
  level: string | null;
  scope: UsageMcpQuotaScope;
  /**
   * 服务端 `total_usage`（总已用 / 总额度 / 总剩余）的等价表达，直接复用现有额度条 / 额度卡的
   * 展示逻辑。注意 percentage 沿用 quota 接口口径：**已使用占比**，展示端负责反转成剩余。
   */
  aggregate: UsageQuotaLimit;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` usage-stats.ts（切片：entitlement snapshot 族） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface UsageEntitlementSnapshot {
  generatedAt: number;
  /** 当前额度响应的服务端时间（毫秒）；与本地快照生成时间 generatedAt 分离。 */
  serverTime?: number;
  authenticated: boolean;
  unavailableReason?:
    | "not_authenticated"
    | "not_configured"
    | "no_plan"
    | "unavailable";
  /** 无可用 Start Plan 时，保留明确过期原因用于展示。 */
  startPlanExpired?: boolean;
  /** 团队订阅明确失效的原因，仅与 no_plan 一起返回。 */
  teamPlanUnavailableReason?: "expired" | "unassigned";
  /** 当前 entitlement 查询对应的个人 / 团队上下文，用于设置页连接方式主判定。 */
  context?: UsageEntitlementContext | null;
  /** 当前用于查询 quota 的模型供应商信息。 */
  provider: UsageEntitlementProviderInfo | null;
  remaining: UsageEntitlementRemaining | null;
  subscription: UsageEntitlementSubscription | null;
  quota: UsageQuotaSnapshot | null;
  /**
   * ZCode 官方 Server MCP 的调用额度（`/api/v1/mcp/usage`）。
   * 与 quota 同一份快照下发，是为了继承 entitlement 已有的缓存 / in-flight 合并 / TTL 策略；
   * 拉取失败、未开通 Coding Plan、或该额度不属于本次查询的连接时一律为 null（可选数据面）。
   */
  mcpQuota?: UsageMcpQuotaSnapshot | null;
}

export interface UsageEntitlementContext {
  scope: "personal" | "team";
  organizationId?: string | null;
  projectId?: string | null;
  displayName?: string | null;
  productId?: string | null;
}

export type PlanIdentityStatus =
  | "coding_plan"
  | "start_plan"
  | "no_plan"
  | "unknown";

export interface PlanIdentitySnapshot {
  generatedAt: number;
  planStatus: PlanIdentityStatus;
  planProductId: string;
}

export interface UsageEntitlementRemaining {
  count: number;
  isShow: boolean;
  percentage?: number;
  nextResetTime?: number | null;
}

export interface UsageEntitlementProviderInfo {
  id: string;
  name: string;
}

export interface UsageEntitlementSubscription {
  identityType: "email" | "phoneNumber" | "unknown";
  identityMasked: string | null;
  details: UsageEntitlementSubscriptionDetail[];
}

export interface UsageEntitlementSubscriptionDetail {
  productId: string;
  productName: string;
  purchaseTime: string | null;
  beginTime: string | null;
  billingCycle?: string | null;
  renewTime?: string | null;
  expireTime: string | null;
  /** Start Plan balance 套餐下的权益生效时间；其他订阅类型可不提供。 */
  entitlements?: Array<{
    entitlementId: string;
    /** 服务端 entitlement show_name，用于待生效提示。 */
    showName?: string | null;
    effectiveTime: string | null;
  }>;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` coding-plan-reset.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type CodingPlanResetType = "FIVE_HOUR" | "WEEK";

export interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  /** Registry 静态访问类别，或调用边界已解析的 Team scope。 */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export interface CodingPlanResetOpportunitySnapshot {
  expireAt: number;
}

export interface CodingPlanResetHistorySnapshot {
  usedAt: number;
}

export interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: CodingPlanResetOpportunitySnapshot[];
  availableWeekResets: CodingPlanResetOpportunitySnapshot[];
  latestFiveHourResetHistory: CodingPlanResetHistorySnapshot | null;
  latestWeekResetHistory: CodingPlanResetHistorySnapshot | null;
  hasUnreadHistory: boolean;
}

export interface CodingPlanResetOpportunityRequest
  extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

export interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

export interface CodingPlanResetUseRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
  resetType: CodingPlanResetType;
}

export interface CodingPlanResetUseResult {
  used: true;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` pluginStoreOrder.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

const orderList = z
  .array(z.string().trim().min(1))
  .transform((items) => [...new Set(items)]);
const modeOrderSchema = z.object({
  categoryOrder: orderList.optional(),
  pluginOrder: z.record(z.string(), orderList).optional(),
});
const pluginStoreOrderSchema = z.object({
  code: modeOrderSchema.optional().catch(undefined),
  work: modeOrderSchema.optional().catch(undefined),
});

export type PluginStoreModeOrder = z.infer<typeof modeOrderSchema>;
export type PluginStoreOrder = z.infer<typeof pluginStoreOrderSchema>;

/** 排序只是展示配置；错误模式独立回退，不能阻止目录浏览或污染另一种模式。 */
export function parsePluginStoreOrder(value: unknown): PluginStoreOrder | null {
  return pluginStoreOrderSchema.safeParse(value).data ?? null;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` plugin-marketplaces.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set(
  [
    "browser-use@zcode-plugins-official",
    "image-search@zcode-plugins-official",
    "documents@zcode-plugins-official",
    "pdf@zcode-plugins-official",
    "presentations@zcode-plugins-official",
    "spreadsheets@zcode-plugins-official",
    // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
    // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
    // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
    "node-repl-host@zcode-plugins-official",
    "skill-creator@zcode-plugins-official",
    "plugin-creator@zcode-plugins-official",
    "zcode-guide@zcode-plugins-official",
    // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
    // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
    // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
  ],
);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ZCode 官方唯一市场：本地 seed 分片与 CDN 分片在 Agent storage 内合并。
    // CDN manifest 的 name 必须与该 canonical id 一致。
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description:
      "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
];

// 商店「公开」分段只有一个 ZCode 官方市场 id，内置与 CDN 不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` pluginStoreOrdering.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

export const FALLBACK_PLUGIN_STORE_CATEGORY = "other";
export const PLUGIN_STORE_CATEGORY_ORDER: readonly string[] = [
  "productivity",
  "developer-tools",
  "utilities",
  "finance",
  "legal",
  "template",
];

// 完整 ID 避免个人市场的同名插件被误置顶；所有展示入口复用同一默认顺序。
const DOCUMENT_PLUGIN_RANKS = new Map(
  ["pdf", "presentations", "spreadsheets", "documents"].map((name, index) => [
    `${name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
    index,
  ]),
);

export function compareDocumentPluginPriority(
  leftId: string,
  rightId: string,
): number {
  return compareRanks(DOCUMENT_PLUGIN_RANKS, leftId, rightId);
}

/** 分类归并只影响展示，市场与引用 Picker 必须使用同一个排序键。 */
export function resolvePluginStoreCategory(
  category: string | undefined,
): string | undefined {
  const normalized = category?.trim();
  return normalized === "guides" ? "utilities" : normalized || undefined;
}

interface PluginStoreSortEntry {
  id: string;
  category?: string | undefined;
  displayName: string;
}

/** 纯展示排序：配置优先，剩余分类按产品默认顺序，类内文档插件优先，再按本地化名称稳定兜底。 */
export function sortPluginStoreEntries<T>(
  items: readonly T[],
  project: (item: T) => PluginStoreSortEntry,
  locale: string,
  order?: PluginStoreModeOrder,
): T[] {
  const categoryRanks = ranks(order?.categoryOrder);
  const pluginRanks = new Map(
    Object.entries(order?.pluginOrder ?? {}).map(([category, ids]) => [
      category,
      ranks(ids),
    ]),
  );
  return items
    .map((item, index) => {
      const entry = project(item);
      return {
        item,
        index,
        ...entry,
        category:
          resolvePluginStoreCategory(entry.category) ??
          FALLBACK_PLUGIN_STORE_CATEGORY,
      };
    })
    .sort(
      (left, right) =>
        compareRanks(categoryRanks, left.category, right.category) ||
        compareCategories(left.category, right.category) ||
        compareRanks(pluginRanks.get(left.category), left.id, right.id) ||
        compareDocumentPluginPriority(left.id, right.id) ||
        left.displayName.localeCompare(right.displayName, locale) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

function ranks(order: readonly string[] = []): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of order) if (!result.has(key)) result.set(key, result.size);
  return result;
}
function compareRanks(
  order: Map<string, number> | undefined,
  left: string,
  right: string,
): number {
  if (!order) return 0;
  return (order.get(left) ?? order.size) - (order.get(right) ?? order.size);
}
function compareCategories(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FALLBACK_PLUGIN_STORE_CATEGORY) return 1;
  if (right === FALLBACK_PLUGIN_STORE_CATEGORY) return -1;
  const a = PLUGIN_STORE_CATEGORY_ORDER.indexOf(left);
  const b = PLUGIN_STORE_CATEGORY_ORDER.indexOf(right);
  if (a !== -1 && b !== -1) return a - b;
  if (a !== -1) return -1;
  if (b !== -1) return 1;
  return left < right ? -1 : 1;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` plugin-display-name.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

const CANONICAL_PLUGIN_NAME_ACRONYMS: Readonly<Record<string, string>> = {
  aws: "AWS",
  mcp: "MCP",
  zcode: "ZCode",
};

/** listing 的多语言字段先精确匹配，再按语言前缀兜底。 */
export function resolveLocalizedText(
  locale: string,
  base: string | undefined,
  i18n: Record<string, string> | undefined,
): string | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(
        ([key]) => key.split("-")[0] === language,
      );
      if (match?.[1]) return match[1];
    }
  }
  return base;
}

export function formatCanonicalPluginName(
  name: string,
  locale: string,
): string {
  return name
    .trim()
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(
      (part) =>
        CANONICAL_PLUGIN_NAME_ACRONYMS[part.toLowerCase()] ??
        `${part.charAt(0).toLocaleUpperCase(locale)}${part.slice(1)}`,
    )
    .join(" ");
}

/**
 * 用户可见插件名称只信任与完整 Plugin ID 关联的 listing；缺失时才回退到 canonical slug。
 * 不按裸 manifest name 猜测官方产品名，避免同名 marketplace 插件互相覆盖。
 */
export function resolvePluginDisplayName(
  plugin: { name: string; listing?: ZCodePluginStoreListing },
  locale: string,
): string {
  return (
    resolveLocalizedText(
      locale,
      plugin.listing?.displayName,
      plugin.listing?.displayNameI18n,
    ) ?? formatCanonicalPluginName(plugin.name, locale)
  );
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` skills-types.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type SkillScope = "workspace" | "user" | "plugin";

export interface SkillMetadata {
  slug?: string;
  version?: string;
  ownerId?: string;
  publishedAt?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  /**
   * 发现阶段命中的原始 SKILL.md 路径（未经 realpath 解析）。
   * 软链导入的技能里 `path` 是 realpath 后的目标文件，`sourcePath` 才指向 `~/.zcode/skills/<name>` 下的链接本体，
   * 删除时必须用它才能只删链接、不动目标。普通技能与 `path` 相同。
   */
  sourcePath?: string;
  scope: SkillScope;
  enabled: boolean;
  /** plugin scope 时为来源插件名；其它 scope 留空。 */
  pluginName?: string | undefined;
  /** plugin scope 时为来源插件完整 ID（name@marketplace）；旧 payload 可缺省。 */
  pluginId?: string;
  metadata?: SkillMetadata;
}

export interface SkillsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export type SkillDiagnosticSeverity = "warning" | "error";

/** 与 zcode-cli `SkillDiagnosticCode` 同步。变动时一并改 apps/zcode-cli/packages/contracts/src/skills/index.ts。 */
export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  capability: SkillsCapability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillsPromptContext {
  prompt: string;
  activatedSkillNames: string[];
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` launchMarks.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** main 进程采集的四个启动时刻（epoch 毫秒）。renderer 据此计算分阶段耗时。 */
export interface LaunchMarks {
  /** process.getCreationTime()：进程创建（锚点 T0） */
  createdAt: number;
  /** main/index.ts 模块顶部 Date.now()（T1） */
  mainStart: number;
  /** app.whenReady 回调入口 Date.now()（T2） */
  appReady: number;
  /** 主窗口 loadWindow 内 loadURL 前 Date.now()（T3） */
  loadUrl: number;
}

/** 主窗口 loadURL query string 中携带 launch marks 的参数名 */
export const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks";

export function serializeLaunchMarks(marks: LaunchMarks): string {
  return JSON.stringify(marks);
}

export function parseLaunchMarks(
  raw: string | null | undefined,
): LaunchMarks | null {
  if (raw == null || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys: (keyof LaunchMarks)[] = [
    "createdAt",
    "mainStart",
    "appReady",
    "loadUrl",
  ];
  const result = {} as LaunchMarks;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` telemetry.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number | undefined;
  properties?:
    | Record<string, string | number | boolean | undefined>
    | undefined;
}

/** desktop main 实际传给 armsRum.sendCustom 的最终参数。 */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** 仅 E2E test bridge 可读取的 main-process 内存记录。 */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** 命中后仍进入 ring，但不调用真实 armsRum.sendCustom。 */
  suppressedEventNames: string[];
}

/**
 * URL 配置进入业务埋点前只允许提取 hostname。
 * 无效值和非 HTTP(S) 协议返回空串，避免误把完整 URL、userinfo 或任意文本带入 payload。
 */
export function resolveSafeTelemetryHostname(
  value: string | null | undefined,
): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 错误原文可能带任意格式密钥；整体丢弃，不用正则猜测秘密边界。 */
export function sanitizeTelemetryErrorMessage(
  value: string | null | undefined,
): string {
  return value ? "[redacted]" : "";
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // UI 已取过 hostname 时 Core 仍需幂等；只接受精确 hostname，不放行无协议的路径或凭据。
  const normalized = value.trim().toLowerCase();
  return normalized &&
    resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** 只清洗上报副本；业务错误、授权地址和调用方持有的 detail 不得被修改。 */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      key === "error_msg"
        ? sanitizeTelemetryErrorMessage(value)
        : elementName === "app_login_ck" && key === "login_url"
          ? sanitizeLoginHostname(value)
          : value,
    ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl === "undefined"
      ? undefined
      : Intl.DateTimeFormat().resolvedOptions();
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage =
    options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` legacy-model-provider-identity.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

// 不凭用户自定义 Provider 的名字猜所属站点；闲时 Ticket 的绑定身份也不能改。
export function migrateLegacyOfficialGlmModelId(
  providerId: string,
  modelId: string,
): string {
  return /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/.test(
    providerId,
  )
    ? normalizeOfficialGlmModelId(modelId)
    : modelId;
}

/**
 * 仅供已发布旧数据的单向升级使用，不是运行时 Provider 别名或选择兜底。
 * 依赖当前账号解释旧 Coding Plan 会使离线/SSH 迁移丢失原意图。
 * 同域 Individual 仅是确定性迁移落点，当前账号对应留给有效选择解析，不能据此绑定执行。
 * 迁移不查模型/档位是否可用；普通未知 ID 不构成旧格式证据。
 */
export function migrateLegacyModelProviderId(
  providerId: string,
): string | undefined {
  switch (providerId) {
    case "builtin:bigmodel":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
    case "builtin:zai":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.zai;
    case "builtin:bigmodel-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    case "builtin:zai-start-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan;
    case "builtin:bigmodel-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    case "builtin:zai-coding-plan":
      return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    default:
      return providerId.startsWith("builtin:") ? undefined : providerId;
  }
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` official-glm-model-id.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
// 只供官方模型名单、telemetry 模型白名单与单向迁移入口使用；不能用于 Registry 比较或通用请求改写。
const canonicalIds = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5V-Turbo",
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5.1-Highspeed",
  "GLM-5",
  "GLM-5-Turbo",
  "GLM-4.7",
  "GLM-4.7-FlashX",
  "GLM-4.7-Flash",
  "GLM-4.6",
  "GLM-4.5-Air",
  "GLM-4.5",
  "GLM-4.6V",
  "GLM-4.6V-Flash",
  "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash",
  "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414",
  "GLM-4V-Flash",
];
const byLowercase = new Map(canonicalIds.map((id) => [id.toLowerCase(), id]));

/** 官方 GLM 模型规范 ID 名单；telemetry 白名单以此为来源，新增官方模型时同步进入白名单。 */
export const OFFICIAL_GLM_MODEL_IDS: readonly string[] = canonicalIds;

export function normalizeOfficialGlmModelId(modelId: string): string {
  return byLowercase.get(modelId.toLowerCase()) ?? modelId;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` telemetryRedaction.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/**
 * 遥测文本与模型身份的脱敏收口。
 *
 * ARMS 自动采集的 exception / api / click 事件，以及自定义事件里带自由文本的字段，都可能包含
 * 本机路径、邮箱、完整 URL 和凭据。这里提供纯函数实现，供 desktop main 的 `beforeReport` 与
 * renderer 侧埋点共用，避免每个埋点各写一份模式。
 *
 * 模式与 CLI 的 `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` 保持一致；两者位于不同
 * workspace 且不允许互相依赖，扩展任一侧时必须同步另一侧。
 */

/** 单字段默认上限；ARMS 单字段过长会被截断或拒绝，主动截断保证关键头部一定上得去。 */
export const TELEMETRY_TEXT_MAX_LENGTH = 2_048;

/** 脱敏前的输入上限：错误可能携带整段响应正文，先有界截断再正则清洗，避免无界 CPU 成本。 */
const TELEMETRY_TEXT_SCAN_LIMIT = 4_096;

/** 路由段保留原文的最大长度；更长的段一律视为不可信内容。 */
const TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH = 128;

export interface RedactTelemetryTextOptions {
  /** 输出上限，默认 {@link TELEMETRY_TEXT_MAX_LENGTH}。 */
  maxLength?: number;
}

/**
 * 把自由文本清洗成可上报形态：URL 去 query、路径/邮箱/凭据归一为占位符，并有界截断。
 *
 * 只作用于上报副本；错误展示、本地日志、崩溃归档和分类逻辑必须继续使用原值。
 */
export function redactTelemetryText(
  value: string | undefined | null,
  options: RedactTelemetryTextOptions = {},
): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  const maxLength = options.maxLength ?? TELEMETRY_TEXT_MAX_LENGTH;
  const redacted = value
    .slice(0, TELEMETRY_TEXT_SCAN_LIMIT)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (match) => redactTelemetryUrl(match))
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    // 修复原因：崩溃/异常消息里的绝对路径会带上本机用户名与工作区目录名，必须在离开本机前归一。
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "{path}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "{path}",
    )
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return redacted.slice(0, maxLength);
}

/**
 * 把 URL 清洗成 `protocol//host` 加归一化路由；丢弃 query 与 fragment。
 *
 * `file://`、本地绝对路径归一为 `local_file`，`blob:` / `data:` 只保留协议标记，
 * 无法解析时返回 `unknown`，不回退到原值。
 */
export function redactTelemetryUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "unknown";
  }
  if (/^blob:/iu.test(raw)) {
    return "blob";
  }
  if (/^data:/iu.test(raw)) {
    return "data";
  }
  // Bug 根因：枚举常见根目录会漏掉 /opt、/root、/mnt 等合法 POSIX 绝对路径。
  if (
    /^file:/iu.test(raw) ||
    /^[a-zA-Z]:[\\/]/u.test(raw) ||
    raw.startsWith("/")
  ) {
    return "local_file";
  }

  try {
    // Bug 根因：无条件补 `https://` 会让 `!!!` 之类的普通文本被 URL 解析成 host 后原样回显。
    // 只有本身带 scheme，或看起来确实是 host[:port][/path] 的输入才进入解析。
    const candidate = raw.includes("://")
      ? raw
      : /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(?:[/?#]|$)/iu.test(raw)
        ? `https://${raw}`
        : "";
    if (!candidate) {
      return "unknown";
    }
    const parsed = new URL(candidate);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const route = parsed.pathname
      .split("/")
      .map((segment) => redactTelemetryRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "unknown";
  }
}

function redactTelemetryRouteSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (
    // 邮箱、长数字 ID、hash 和 UUID 都是高基数身份，不能原样留在路由里。
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, TELEMETRY_ROUTE_SEGMENT_MAX_LENGTH);
}

/** 官方 GLM 名单之外的历史内置模型；仍是 ZCode 自己发布的稳定 ID，不是用户命名。 */
const TELEMETRY_LEGACY_BUILTIN_MODEL_IDS: readonly string[] = [
  "charglm-4",
  "codegeex-4",
  "emohaa",
];

/**
 * telemetry 模型白名单：只有这里的内置稳定模型 ID 允许原样进入遥测。
 *
 * 白名单独立于账号返回的运行时 catalog，但以人工维护的官方 GLM 名单为来源：
 * 修复原因：此前手抄一份列表漏掉了 GLM-5.3 / GLM-5.3-Flash / GLM-5V-Turbo，导致旗舰模型在
 * plan_* / perf_ui_* 里整体写成 `custom`。派生自官方名单后，两处不会再各自漂移。
 */
export const TELEMETRY_SAFE_BUILTIN_MODEL_IDS: ReadonlySet<string> = new Set([
  ...OFFICIAL_GLM_MODEL_IDS.map((id) => id.toLowerCase()),
  ...TELEMETRY_LEGACY_BUILTIN_MODEL_IDS,
]);

export type TelemetryProviderScope = "builtin" | "custom" | "unknown";

export interface TelemetryProviderIdentity {
  providerId: string;
  providerScope: TelemetryProviderScope;
}

/**
 * 旧报表身份（`builtin:zai` / `builtin:zai-start-plan` 等）是 ZCode 自己的固定 ID。
 *
 * 修复原因：V4 supervisor 投影 /report detail 时会用 legacyTelemetryProviderId 把运行时
 * `account:*` 映射成这些旧身份，plan_ttft / perf_ui_* 复用同一份 detail。只认 `account:*`
 * 会让全部内置用户被当成自定义 provider 归一为 `custom`。复用 shared 的单向迁移表判定，
 * 未知的 `builtin:` 前缀仍按自定义处理，不能借前缀混入。
 */
function isLegacyBuiltinTelemetryProviderId(providerId: string): boolean {
  const migrated = migrateLegacyModelProviderId(providerId);
  return migrated !== undefined && migrated !== providerId;
}

/** 内置 provider 保留稳定 ID；自定义 provider 由用户命名，原样上报会泄露私有名称并制造高基数。 */
export function resolveTelemetryProviderScope(
  providerId: string | undefined | null,
): TelemetryProviderIdentity {
  const normalized = providerId?.trim();
  if (!normalized) {
    return { providerId: "", providerScope: "unknown" };
  }
  if (
    isBuiltinModelProviderId(normalized) ||
    isLegacyBuiltinTelemetryProviderId(normalized)
  ) {
    return { providerId: normalized, providerScope: "builtin" };
  }
  return { providerId: "custom", providerScope: "custom" };
}

/**
 * 从 `custom:<providerId>:<modelName>` 编码值或 `<providerId>/<modelId>` 复合值里剥出裸模型 ID。
 * 裸 ID 只用于查白名单，无论 provider 部分是什么都不会原样进入遥测。
 */
function extractBareModelId(value: string): string {
  const decoded = decodeCustomModelValue(value);
  if (decoded) {
    return decoded.modelName ?? "";
  }
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * 只保留白名单内的内置模型 ID。
 *
 * 自定义 provider 的模型、内置 provider 下未命中白名单的模型统一写 `custom`；
 * provider scope 未知或模型缺失时写空串，与既有留空口径一致。
 */
export function resolveTelemetryModelId(
  providerScope: TelemetryProviderScope,
  modelId: string | undefined | null,
): string {
  const normalized = modelId?.trim();
  if (!normalized || providerScope === "unknown") {
    return "";
  }
  if (providerScope === "custom") {
    return "custom";
  }
  // 修复原因：supervisor 投影出的 detail.model_name 是 `<providerId>/<modelId>` 复合值或
  // `custom:` 编码值，直接整串查白名单必然落空；先剥出裸模型 ID 再判定。
  const bareModelId = extractBareModelId(normalized).toLowerCase();
  return TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(bareModelId)
    ? bareModelId
    : "custom";
}

/**
 * 归一化「只拿到一个模型值、没有独立 provider 字段」的场景。
 *
 * 支持三种形态：`custom:<providerId>[:<modelName>]` 编码值、`<providerId>/<modelId>` 复合值和
 * 裸模型 ID。裸 ID 直接按白名单判定，未命中一律降级为 `custom`——这正是「新增内置模型未进入
 * 白名单时必须默认降级」的要求，因此不需要调用方额外传 provider。
 */
export function sanitizeTelemetryModelValue(
  value: string | undefined | null,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "";
  }

  // `custom:` 前缀本身就表示非内置 provider，无需解码出用户命名即可判定。
  const decoded = decodeCustomModelValue(normalized);
  if (decoded) {
    return resolveTelemetryModelId(
      resolveTelemetryProviderScope(decoded.providerId).providerScope,
      decoded.modelName,
    );
  }

  const separator = normalized.indexOf("/");
  if (separator > 0) {
    const { providerScope } = resolveTelemetryProviderScope(
      normalized.slice(0, separator),
    );
    return resolveTelemetryModelId(
      providerScope,
      normalized.slice(separator + 1),
    );
  }

  return resolveTelemetryModelId("builtin", normalized);
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` custom-model-value.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const CUSTOM_MODEL_VALUE_PREFIX = "custom:";

export interface DecodedCustomModelValue {
  providerId: string;
  modelName?: string;
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeCustomModelValue(
  providerId: string,
  modelName?: string,
): string {
  const encodedProviderId = encodeURIComponent(providerId);
  if (!modelName) {
    return `${CUSTOM_MODEL_VALUE_PREFIX}${encodedProviderId}`;
  }

  return `${CUSTOM_MODEL_VALUE_PREFIX}${encodedProviderId}:${encodeURIComponent(modelName)}`;
}

export function decodeCustomModelValue(
  value: string,
): DecodedCustomModelValue | null {
  if (!value.startsWith(CUSTOM_MODEL_VALUE_PREFIX)) {
    return null;
  }

  const body = value.slice(CUSTOM_MODEL_VALUE_PREFIX.length);
  const separatorIndex = body.indexOf(":");

  if (separatorIndex < 0) {
    return {
      providerId: safeDecodeUriComponent(body),
    };
  }

  const legacyParts = body.split(":");
  if (legacyParts.length >= 3 && legacyParts[0] === "builtin") {
    return {
      providerId: `${legacyParts[0]}:${legacyParts[1]}`,
      modelName: safeDecodeUriComponent(legacyParts.slice(2).join(":")),
    };
  }

  const encodedProviderId = body.slice(0, separatorIndex);
  const encodedModelName = body.slice(separatorIndex + 1);

  return {
    providerId: safeDecodeUriComponent(encodedProviderId),
    modelName: safeDecodeUriComponent(encodedModelName),
  };
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` model-selection-types.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const ZCODE_AGENT_PROVIDER_NOT_READY_CODE =
  "ZCODE_AGENT_PROVIDER_NOT_READY" as const;
export const ZCODE_AGENT_PROVIDER_NOT_READY_REASON =
  "provider_not_ready" as const;

export type ModelSelectionGhostReason =
  | "mismatch"
  | "no-preference"
  | "providers-not-ready"
  | "unresolved-config";

export type ModelSelectionUiErrorCode =
  | "CONFIG_READ_FAILED"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_INVALID_SCHEMA"
  | "CONFIG_REQUIRED_FIELD_MISSING";

export interface ModelSelectionUiError {
  code: ModelSelectionUiErrorCode;
  i18nKey: string;
  detail?: string;
}

export interface ModelSelectionResolution {
  selectedSupplierKey: string;
  selectedModel: string | null;
  isGhostSupplier: boolean;
  supplierMismatchReason: ModelSelectionGhostReason | null;
  uiError: ModelSelectionUiError | null;
  shouldClearLocalPreference: boolean;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` model-selection-key.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

export const NATIVE_SUPPLIER_KEY_PREFIX = "native:";
export const CUSTOM_SUPPLIER_KEY_PREFIX = "custom:";
export const GHOST_SUPPLIER_KEY_PREFIX = "ghost:";

const TRAILING_SLASHES_RE = /\/+$/;
const MAX_ENCODED_GHOST_IDENTITY_LENGTH = 160;

function fnv1a32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash >>> 0;
}

function hash12(value: string): string {
  const high = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, "0");
  const low = fnv1a32(value, 0x9e3779b1).toString(16).padStart(8, "0");
  return `${high}${low}`.slice(0, 12);
}

export function normalizeSupplierBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(TRAILING_SLASHES_RE, "");
}

export function buildNativeSupplierKey(zcodeProvider: ZCodeProvider): string {
  return `${NATIVE_SUPPLIER_KEY_PREFIX}${zcodeProvider}`;
}

export function buildCustomSupplierKey(providerId: string): string {
  return `${CUSTOM_SUPPLIER_KEY_PREFIX}${providerId.trim()}`;
}

export function buildGhostSupplierIdentity(rawIdentity: string): string {
  const encodedIdentity = encodeURIComponent(rawIdentity.trim() || "unknown");
  if (encodedIdentity.length <= MAX_ENCODED_GHOST_IDENTITY_LENGTH) {
    return encodedIdentity;
  }

  // ghost identity 可能包含长 URL，直接拼 key 会放大状态串并污染日志。
  // 超长时退化成稳定摘要，避免 selectedSupplierKey 无限增长。
  return `hash=${hash12(rawIdentity)}`;
}

export function buildGhostSupplierKey(
  zcodeProvider: ZCodeProvider,
  reason: ModelSelectionGhostReason,
  rawIdentity: string,
): string {
  return [
    GHOST_SUPPLIER_KEY_PREFIX,
    zcodeProvider,
    ":",
    reason,
    ":",
    buildGhostSupplierIdentity(rawIdentity),
  ].join("");
}

export function resolveSupplierKeyFromModelDisplayValue(
  zcodeProvider: ZCodeProvider,
  value: string | boolean | undefined,
): string {
  const customModel = decodeCustomModelValue(String(value ?? ""));
  if (customModel?.providerId) {
    return buildCustomSupplierKey(customModel.providerId);
  }

  return buildNativeSupplierKey(zcodeProvider);
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` sessionCreateTelemetry.ts 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */

export type SessionCreateSource = "group" | "project" | "session";
export type SessionCreateClientKind = "desktop" | "mobile" | "web";

/** 手机转发只开放本事件；公共用户/设备身份仍由桌面 TelemetryCore 注入。 */
export const sessionCreateTelemetrySchema = z
  .object({
    elementName: z.literal("session_create"),
    eventRegion: z.literal("app"),
    eventType: z.literal("result"),
    talkId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        create_source: z.enum(["group", "project", "session"]),
        client_kind: z.literal("mobile"),
        workspace_kind: z.enum(["local", "remote"]),
        remote_kind: z.enum(["", "ssh", "wsl", "docker", "server"]),
      })
      .strict(),
  })
  .strict();

export type MobileSessionCreateTelemetry = z.infer<
  typeof sessionCreateTelemetrySchema
>;

/** 自动化由执行 Host 报告；手机不得冒充无人值守派发来源。 */
export const automationSessionCreateTelemetrySchema =
  sessionCreateTelemetrySchema.extend({
    eventExtraDetail:
      sessionCreateTelemetrySchema.shape.eventExtraDetail.extend({
        create_source: z.enum(["automation_idle", "automation_scheduled"]),
        client_kind: z.literal("desktop"),
      }),
  });
export type AutomationSessionCreateTelemetry = z.infer<
  typeof automationSessionCreateTelemetrySchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` platform.ts 消费切片（IPlatformService 收窄） ----------
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：原接口含远程连接/编辑器/MCP 配置等 30+ 方法与重型依赖闭包；本仓照搬件只经
 * `Pick<IPlatformService, "reportArmsCustomEvent">`（uiPerfArmsTelemetry）消费，此处按原
 * 成员签名收窄声明，语义对消费面等价。
 */

export interface IPlatformService {
  /** 通过宿主环境统一上报 UI 侧 telemetry 事件（P9 补充：appTelemetry / codingPlanFunnelTelemetry 消费）。 */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;
  /** 上报 ARMS 自定义事件（Desktop main 转发）；Web/手机宿主可不实现。 */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;
}

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` zcode-protocol-legacy-types.ts 收窄切片 ----------
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：原符号 ZCodeSessionActiveTurnKind 经 zcodeSessionRuntimeStateSchema.activeTurnKind
 * 推导（NonNullable）；为避免拖入整棵 runtime-state schema 闭包，按同词表内联 enum，
 * 联合成员与推导结果一致。
 */

export const zcodeSessionActiveTurnKindSchema = z.enum([
  "regular",
  "compact",
  "rewind",
]);
export type ZCodeSessionActiveTurnKind = z.infer<
  typeof zcodeSessionActiveTurnKindSchema
>;

/* ---------- zcode 照搬（P5 补充）：`@zcode/shared` shortcutCommands.ts 消费切片（命令表与序列化） ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface ShortcutCommandEntry {
  /** 命令 id；与 ShortcutCommandId 一一对应。 */
  readonly id: ShortcutCommandId;
  readonly channel: ShortcutChannel;
  /** 作用域；缺省 global。 */
  readonly scope?: ShortcutScope;
  /** 默认绑定，规范形式序列化串；多条表示双默认（覆盖时整组替换）。 */
  readonly defaultBindings: readonly string[];
}

/**
 * 命令表：快捷键命令的唯一事实来源。
 * 注意：navigateBack/navigateForward 是历史前进/后退；previousConversation/nextConversation
 * 才是"上一个/下一个任务"（早期原型曾把两者标混，以本表为准）。
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandEntry[] = [
  {
    id: "openCommandCenter",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"],
  },
  // 打开设置页：mac ⌘, / win·linux Ctrl+,（系统惯例，如 macOS Settings…、VSCode）
  { id: "openSettings", channel: "window", defaultBindings: ["CmdOrCtrl+,"] },
  { id: "findInTask", channel: "window", defaultBindings: ["CmdOrCtrl+f"] },
  { id: "toggleSidebar", channel: "window", defaultBindings: ["CmdOrCtrl+b"] },
  {
    id: "switchTheme",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Shift+l"],
  },
  { id: "toggleTerminal", channel: "window", defaultBindings: ["CmdOrCtrl+j"] },
  {
    id: "toggleSidePane",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Alt+b"],
  },
  {
    id: "previousConversation",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Shift+["],
  },
  {
    id: "nextConversation",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Shift+]"],
  },
  { id: "navigateBack", channel: "window", defaultBindings: ["CmdOrCtrl+["] },
  {
    id: "navigateForward",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+]"],
  },
  // composer 工具条动作（原固定热键转正）：显式 Ctrl 修饰（mac 上也是 Ctrl，
  // 与旧 matchesCtrlShortcut 语义一致），由工具条的 window capture 监听按生效表消费。
  { id: "openModelMenu", channel: "window", defaultBindings: ["Ctrl+m"] },
  {
    id: "cycleSessionMode",
    channel: "window",
    defaultBindings: ["Ctrl+Shift+m"],
  },
  { id: "cycleThoughtLevel", channel: "window", defaultBindings: ["Ctrl+t"] },
  { id: "newTask", channel: "menu", defaultBindings: ["CmdOrCtrl+n"] },
  { id: "openWorkspace", channel: "menu", defaultBindings: ["CmdOrCtrl+o"] },
  {
    id: "closeActiveContext",
    channel: "menu",
    defaultBindings: ["CmdOrCtrl+w"],
  },
  { id: "zoomIn", channel: "menu", defaultBindings: ["CmdOrCtrl+="] },
  { id: "zoomOut", channel: "menu", defaultBindings: ["CmdOrCtrl+-"] },
  { id: "resetZoom", channel: "menu", defaultBindings: ["CmdOrCtrl+0"] },
  // composer 作用域：由输入框 Lexical 插件消费，不进 useAppKeyboard / 菜单。
  // channel 仅作类型占位（渲染进程行为），分发方按 scope 识别。
  {
    id: "composerSend",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Enter"],
  },
  {
    id: "composerInsertNewline",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
  },
  {
    id: "toggleInterfaceMode",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Shift+u"],
  },
  {
    id: "openOnboarding",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+Shift+o"],
  },
];

/** 按命令 ID 取默认绑定；未知命令返回空数组（生效表 resolve 对未知命令整体忽略）。 */
export function getDefaultShortcutBindings(id: string): readonly string[] {
  return (
    SHORTCUT_COMMANDS.find((entry) => entry.id === id)?.defaultBindings ?? []
  );
}

// ============================================================================
// 绑定序列化格式（Electron accelerator 兼容子集）
// ============================================================================

/** 解析后的绑定：四个修饰键开关 + 规范化键名。 */
export interface ParsedShortcutBinding {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  /** 规范化键名：小写字母 / 数字 / 符号字符（= - [ ] , . / ; ' ` \）/ 命名键（F1..F12、ArrowUp…）。 */
  key: string;
}

/** 序列化时修饰键的固定顺序。 */
const MODIFIER_ORDER = [
  ["CmdOrCtrl", "cmdOrCtrl"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["AltGr", "altGr"],
] as const satisfies ReadonlyArray<
  readonly [string, keyof ParsedShortcutBinding]
>;

/** 菜单兼容别名归一：Plus/Equal → "="，Minus → "-"。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Plus: "=",
  Equal: "=",
  Minus: "-",
};

/** 单字符键：小写字母、数字与符号。大写字母不合法（录制/序列化统一小写化）。 */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;

/** 命名键白名单（大小写敏感）。Enter 供 composer 作用域命令使用。 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Insert",
  "Enter",
]);

/** 键名规范化：合法返回规范化键名，非法返回 null。 */
export function normalizeShortcutKey(rawKey: string): string | null {
  const aliased = KEY_ALIASES[rawKey] ?? rawKey;
  if (SINGLE_CHAR_KEY.test(aliased)) {
    return aliased;
  }
  return NAMED_KEYS.has(aliased) ? aliased : null;
}

/**
 * 解析绑定串。宽容点：修饰键顺序不敏感（"Shift+CmdOrCtrl+p" 可解析）；
 * 严格点：键名必须规范形式（大写字母、裸 "+"、未知命名键均非法），重复修饰键非法。
 */
export function parseShortcutBinding(
  binding: string,
): ParsedShortcutBinding | null {
  const tokens = binding.split("+");
  // 末位必须是键；"+" 自身不是合法键（用 "=" 或别名 Plus），split 产生空 token 即非法。
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || keyToken === "") {
    return null;
  }

  const parsed: ParsedShortcutBinding = {
    cmdOrCtrl: false,
    ctrl: false,
    alt: false,
    shift: false,
    altGr: false,
    key: "",
  };

  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ORDER.find(([name]) => name === token);
    if (!modifier || parsed[modifier[1]]) {
      // 未知修饰键（含 Meta/Command 等 Electron 修饰名）或重复修饰键均非法。
      return null;
    }
    parsed[modifier[1]] = true;
  }

  const key = normalizeShortcutKey(keyToken);
  if (key === null) {
    return null;
  }
  parsed.key = key;
  return parsed;
}

/** 序列化为规范形式（修饰键按固定顺序 + 规范键名）；任一部分非法返回 null。 */
export function serializeShortcutBinding(
  parsed: ParsedShortcutBinding,
): string | null {
  const key = normalizeShortcutKey(parsed.key);
  if (key === null) {
    return null;
  }

  const parts: string[] = [];
  for (const [name, field] of MODIFIER_ORDER) {
    if (parsed[field]) {
      parts.push(name);
    }
  }
  parts.push(key);
  return parts.join("+");
}

/** 绑定串是否为合法规范形式（parse 后重新 serialize 与原串一致）。 */
export function isValidShortcutBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  return parsed !== null && serializeShortcutBinding(parsed) === binding;
}

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` git.ts 消费切片 ----------
 * 来源：references/zcode/packages/shared/src/git.ts
 * 消费方：GitActionMenu / GitBranchSwitcher / GitPaneChangeCard / ConversationStatusPanel
 * / conversationStatusPanelModel / git-branch-switcher/display / git-action-menu/* /
 * GitPane/helpers / hooks/useGitRepository（stub）/ hooks/useGitBranchSwitcher（stub）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（Locale 已在本文件 protocol 切片）。
 */
export type GitHeadRefType = "branch" | "detached";

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed";

export type GitChangeSourceId = "unstaged" | "staged" | "branch" | "last-turn";

export type GitRepositoryChangeSourceId = Extract<
  GitChangeSourceId,
  "unstaged" | "staged" | "branch"
>;

export type GitChangeSectionId =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-turn";

export type GitDiffAvailability =
  | "patch"
  | "binary"
  | "truncated"
  | "unavailable";

export type GitBranchMutationAction = "switch" | "create-and-switch";

export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "unknown";

export interface GitRepositorySummary {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  /** Git 元数据 watcher 边界；workspace 内容 watcher 由 UI 按 workspace Host 平台决定。 */
  autoRefreshWatchPaths: GitRepositoryAutoRefreshWatchPath[];
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  isDirty: boolean;
  isGitAvailable: boolean;
  isRepository: boolean;
}

export interface GitRepositoryAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export interface GitFileChange {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  x?: string;
  y?: string;
  kind: GitChangeKind;
  section: GitChangeSectionId;
  added: number;
  removed: number;
  isStaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
  sourceId?: GitChangeSourceId;
}

export interface GitDiffResult {
  path: string;
  availability: GitDiffAvailability;
  patch: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  summary?: string | null;
}

export interface GitIdentity {
  userName: string | null;
  userEmail: string | null;
  nameSource: string | null;
  emailSource: string | null;
  scopeLabel?: string | null;
}

export interface GitRepositoryRequest {
  workspacePath: string;
}

export interface GitBranchComparison {
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitFileChange[];
}

export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
}

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}

export interface GitChangesRequest extends GitRepositoryRequest {
  sourceId: Extract<GitRepositoryChangeSourceId, "unstaged" | "staged">;
}

export interface GitCommitRequest extends GitRepositoryRequest {
  message: string;
  paths?: string[];
  stagedOnly?: boolean;
}

export interface GitCommitResult {
  commitHash: string;
  summary: GitRepositorySummary;
}

export interface GitGenerateCommitMessageRequest extends GitRepositoryRequest {
  workspaceIdentity?: string;
  locale?: Locale;
  includeUnstaged?: boolean;
  currentSessionFilePaths?: string[];
  conversationContext?: GitCommitMessageConversationContext;
}

export interface GitCommitMessageConversationContext {
  sessionId?: string;
  omittedMessageCount?: number;
  messages: GitCommitMessageConversationMessage[];
}

export interface GitCommitMessageConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GitGenerateCommitMessageResult {
  message: string;
  providerId: string;
  model: string;
}

export interface GitPushRequest extends GitRepositoryRequest {}

export interface GitPushResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  setUpstream: boolean;
  summary: GitRepositorySummary;
}

export interface GitRefreshRequest extends GitRepositoryRequest {
  includeIdentity?: boolean;
  includeBranchComparison?: boolean;
}

export interface GitRefreshResult {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison | null;
}

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` test-ids.ts（切片：summary panel/后台工作 TID） 消费切片 ----------
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：运行中 subagent 摘要） 消费切片 ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol/index.ts
 * 消费方：ConversationStatusPanel / conversationStatusPanelModel。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（nonEmptyString 已在本文件）。
 */
const zcodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zcodeSessionRunningSubagentSchema =
  zcodeSessionSubagentBaseSchema.extend({
    status: z.enum(["running", "waiting", "blocked"]),
  });
export type ZCodeSessionRunningSubagent = z.infer<
  typeof zcodeSessionRunningSubagentSchema
>;

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` zcode-protocol/index.ts（切片：终态 subagent + subagents 目录结果） ----------
 * 消费方：hooks/useSessionSubagents（stub）、app-shell/SubagentDirectorySidePane。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（base schema 已在本文件）。
 */
export const zcodeSessionEndedSubagentSchema =
  zcodeSessionSubagentBaseSchema.extend({
    status: z.enum(["success", "failed", "cancelled", "lost"]),
  });
export type ZCodeSessionEndedSubagent = z.infer<
  typeof zcodeSessionEndedSubagentSchema
>;

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` rendererActionTrace.ts 消费切片 ----------
 * 来源：references/zcode/packages/shared/src/rendererActionTrace.ts
 * 消费方：lib/userActionTelemetry / lib/userActionTraceCatalog。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬全文件符号声明。
 */
export const RENDERER_ACTION_TRACE_SERVICE_NAME = "zcode-desktop-renderer";
export const RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO = 0.2;
export const RENDERER_ACTION_TRACE_MAX_BATCH_SPANS = 32;
export const RENDERER_ACTION_TRACE_MAX_BATCH_BYTES = 256 * 1024;

export const rendererActionTraceGroupSchema = z.enum([
  "core",
  "settings",
  "workbench",
  "extensions",
  "automation",
  "account",
]);
export type RendererActionTraceGroup = z.infer<
  typeof rendererActionTraceGroupSchema
>;

export const rendererActionTraceConfigSchema = z
  .object({
    enabled: z.boolean(),
    localTtftEnabled: z.boolean().optional(),
    sampleRatio: z
      .number()
      .finite()
      .min(0)
      .max(RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO),
    enabledGroups: z.array(rendererActionTraceGroupSchema).max(6),
    configVersion: z.string().trim().min(1).max(128),
  })
  .strict();
export type RendererActionTraceConfigV1 = z.infer<
  typeof rendererActionTraceConfigSchema
>;

export const DISABLED_RENDERER_ACTION_TRACE_CONFIG: RendererActionTraceConfigV1 =
  {
    enabled: false,
    sampleRatio: 0,
    enabledGroups: [],
    configVersion: "disabled",
  };

const hexTraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const hexSpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);
const boundedIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const boundedValueSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/u);

export const rendererActionTraceAttributesSchema = z
  .object({
    feature_id: boundedIdentifierSchema,
    action: boundedIdentifierSchema,
    catalog_group: rendererActionTraceGroupSchema,
    operation_kind: z.enum([
      "navigation",
      "preference",
      "command",
      "management",
      "destructive",
    ]),
    surface: boundedIdentifierSchema,
    trigger: z.enum([
      "button",
      "keyboard",
      "shortcut",
      "menu",
      "switch",
      "select",
      "drag",
    ]),
    outcome: z.enum([
      "completed",
      "failed",
      "rejected",
      "cancelled",
      "noop",
      "abandoned",
    ]),
    result_source: z
      .enum([
        "local_commit",
        "shared_settings",
        "setting_service",
        "platform_result",
        "authority_ack",
        "optimistic_projection",
      ])
      .optional(),
    failure_stage: boundedIdentifierSchema.optional(),
    state_after: z.enum(["enabled", "disabled"]).optional(),
    configured: z.boolean().optional(),
    requires_restart: z.boolean().optional(),
    section_id: boundedIdentifierSchema.optional(),
    value_after: boundedValueSchema.optional(),
    workspace_kind: z.enum(["local", "remote"]).optional(),
    remote_kind: z.enum(["ssh", "wsl", "docker", "server"]).optional(),
    admission_result: z
      .enum([
        "accepted",
        "rejected",
        "stale",
        "duplicate",
        "noop",
        "not_applicable",
      ])
      .optional(),
    automation_kind: z.enum(["scheduled", "off_peak"]).optional(),
    action_id: z.string().uuid(),
  })
  .strict();
export type RendererActionTraceAttributes = z.infer<
  typeof rendererActionTraceAttributesSchema
>;

export const rendererActionTraceSpanSchema = z
  .object({
    traceId: hexTraceIdSchema,
    spanId: hexSpanIdSchema,
    name: z.literal("ui_action"),
    startTimeUnixMs: z.number().finite().nonnegative(),
    endTimeUnixMs: z.number().finite().nonnegative(),
    status: z.enum(["unset", "ok", "error"]),
    attributes: rendererActionTraceAttributesSchema,
  })
  .strict()
  .superRefine((span, context) => {
    if (span.endTimeUnixMs < span.startTimeUnixMs) {
      context.addIssue({
        code: "custom",
        message:
          "endTimeUnixMs must be greater than or equal to startTimeUnixMs",
        path: ["endTimeUnixMs"],
      });
    }
  });
export type RendererActionTraceSpanV1 = z.infer<
  typeof rendererActionTraceSpanSchema
>;

export const rendererActionTraceResourceSchema = z
  .object({
    serviceName: z.literal(RENDERER_ACTION_TRACE_SERVICE_NAME),
    serviceVersion: boundedIdentifierSchema,
    deploymentEnvironment: z.enum(["development", "test", "production"]),
    rendererInstanceId: boundedIdentifierSchema,
  })
  .strict();
export type RendererActionTraceResourceV1 = z.infer<
  typeof rendererActionTraceResourceSchema
>;

export const rendererActionTraceBatchSchema = z
  .object({
    version: z.literal(1),
    rendererInstanceId: boundedIdentifierSchema,
    sequence: z.number().int().nonnegative(),
    droppedSinceLastFlush: z.number().int().nonnegative(),
    resource: rendererActionTraceResourceSchema,
    spans: z
      .array(rendererActionTraceSpanSchema)
      .max(RENDERER_ACTION_TRACE_MAX_BATCH_SPANS),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.resource.rendererInstanceId !== batch.rendererInstanceId) {
      context.addIssue({
        code: "custom",
        message: "rendererInstanceId must match the resource",
        path: ["resource", "rendererInstanceId"],
      });
    }
  });
export type RendererActionTraceBatchV1 = z.infer<
  typeof rendererActionTraceBatchSchema
>;

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` background-task-controls.ts（切片：elapsed 计算） 消费切片 ----------
 * 消费方：BackgroundTaskElapsedLabel。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export function getZCodeBackgroundTaskControlItemElapsedMs(
  job: ZCodeBackgroundTaskControlItem,
  now = Date.now(),
): number {
  const elapsedFromStart =
    job.startedAt === undefined ? undefined : Math.max(0, now - job.startedAt);
  return Math.max(elapsedFromStart ?? 0, job.elapsedMs ?? 0);
}

/* ---------- zcode 照搬（P6 补充）：`@zcode/shared` test-ids.ts（切片：v4 队列 TID） 消费切片 ----------
 * 消费方：v4/ConversationQueuePanel。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const TID_V4_QUEUE = "v4-queue";
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` test-ids.ts / test-ids-workflow.ts（切片：v4 对话流 + cron/offpeak 卡 + 工作流通知 TID） ----------
 * 消费方：v4/ConversationRowView / ConversationTurnGroup / ConversationTimeline / ConversationTurnNavigator /
 * ConversationAgentToolCallRow / ConversationHookDetailsAction / ConversationFileRewindDialog /
 * ToolCallBlocks/renderers/{cron-create,offpeak-create} / WorkflowNotificationArtifactChips /
 * components/workflow-timeline/WorkflowRunDigest。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
/** 聊天加载指示器 */
export const TID_CHAT_LOADING = "chat-loading";
/** 聊天助手消息历史折叠触发器（动态后缀为 historyStateKey） */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER =
  "chat-assistant-history-trigger";
/** 聊天助手消息历史折叠内容（动态后缀为 historyStateKey） */
export const TID_CHAT_ASSISTANT_HISTORY_CONTENT =
  "chat-assistant-history-content";
/** 独立后台结果轮的任务标题（动态后缀为 turn key） */
export const TID_CHAT_BACKGROUND_RESULT_TITLE = "chat-background-result-title";
/** 会话里终态通知行折叠头部上的 chip——与中枢那枚刻意不同 id */
export const TID_CHAT_WORKFLOW_ARTIFACT_CHIP =
  "workflow-notification-artifact-chip";
/** 轮尾 run 卡；后缀 = `${turnKey}-${toolCallId}`。 */
export const TID_CHAT_WORKFLOW_RUN_DIGEST = "workflow-run-digest";
/** v4 消息时间线容器 */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 投影行（动态后缀为 rowId） */
export const TID_V4_ROW = "v4-row";
/** v4 assistant 行 fork 按钮（动态后缀为 rowId） */
export const TID_V4_FORK = "v4-fork";
/** v4 assistant 行点赞按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** v4 assistant 行点踩按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** v4 turn Hook 详情按钮（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** v4 turn Hook 详情 Popover（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** v4 user 行 edit 按钮（动态后缀为 rowId） */
export const TID_V4_EDIT = "v4-edit";
/** v4 user query 编辑输入框（动态后缀为 rowId） */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** v4 user query 编辑提交按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** v4 user query 编辑取消按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** v4 user query 编辑附件删除按钮（动态后缀为 rowId-index） */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit 文件冲突弹窗 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG =
  "v4-edit-workspace-conflict-dialog";
/** v4 edit 文件冲突后降级为仅裁剪对话 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 时间线「回到底部」按钮（解除底部跟随后出现，虚拟滚动锚定） */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 对话轮次全局导航 rail（宽屏 2+ 可导航 turn 时出现） */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 对话轮次导航项（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 对话轮次导航 HoverCard 预览（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent 下钻「在分屏打开」入口（动态后缀为 childSessionId） */
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput 行附件列表（动态后缀为 rowId） */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";
/** 定时任务（cron）创建卡 / 打开按钮 */
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
/** 闲时任务（off-peak）创建卡 / 打开按钮 */
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` env.ts / version.ts（切片） ----------
 * 消费方：lib/rendererZCodeEndpoint、settings/model-provider-section/constants、CodingPlanEmbeddedWebviewDialog、
 * model-provider-family。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明
 * （define 注入在 web 宿主不存在，走 fallback 分支）。
 */
export type ZCodeEnv = "test" | "production";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ZCODE_ENV__: string;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZCODE_ENV = normalizeZCodeEnv(
  typeof __ZCODE_ENV__ === "undefined" ? undefined : __ZCODE_ENV__,
);

// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
declare const __ZCODE_VERSION__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ === "undefined" ? "0.0.0-dev" : __ZCODE_VERSION__;

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` zcodeEndpoint.ts 全量 ----------
 * 消费方：lib/rendererZCodeEndpoint、settings/model-provider-section/{constants,codingPlanEmbeddedWebview}、
 * model-provider-family。许可证：Apache-2.0（zcode）。适配注记：逐字照搬全文件符号声明
 * （`__ZCODE_ENDPOINT_ENV__` define 在 web 宿主不存在，运行时读 process.env 分支兜底）。
 */
export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";

// 构建仅注入公开链接；Node 调用方仍可显式传 env，避免读取另一进程的配置。
declare const __ZCODE_ENDPOINT_ENV__:
  | Record<string, string | undefined>
  | undefined;
export function pickProductEndpointEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys = [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key]!.trim()]] : [])),
  );
}
export function readProductEndpointEnv(): Record<string, string | undefined> {
  return {
    ...(typeof __ZCODE_ENDPOINT_ENV__ === "undefined"
      ? {}
      : __ZCODE_ENDPOINT_ENV__),
    ...pickProductEndpointEnv(
      typeof process === "undefined" ? {} : process.env,
    ),
  };
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  webShareCallbackUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string | undefined;
  ZCODE_BASE_URL?: string | undefined;
  ZCODE_ENDPOINT_ORIGIN?: string | undefined;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string | undefined;
  BIGMODEL_API_BASE_URL?: string | undefined;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string | undefined;
  ZAI_OAUTH_ORIGIN?: string | undefined;
  ZAI_BUSINESS_BASE_URL?: string | undefined;
  ZAI_OAUTH_CLIENT_ID?: string | undefined;
  ZAI_OAUTH_APP_ID?: string | undefined;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv,
    RuntimeBigModelApiEnv,
    RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean | undefined;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    if (
      origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN ||
      origin === resolveRuntimeZCodeEndpointOrigin()
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return (
      options?.e2eStoreBridgeEnabled === true &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null | undefined;
  overrideOrigin?: string | null | undefined;
}): string {
  const origin =
    options?.overrideOrigin?.trim() || options?.envBaseOrigin?.trim();
  return origin
    ? normalizeZCodeEndpointOrigin(origin)
    : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEnv {
  // 产品身份仅用于既有展示与安装标识，不参与地址解析。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  options?: { overrideOrigin?: string | null },
): string {
  return resolveZCodeEndpointOrigin({
    envBaseOrigin:
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN"),
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

export function buildRuntimeZCodeApiUrl(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

export function resolveBigModelApiOrigin(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ??
      DEFAULT_BIGMODEL_API_ORIGIN,
  );
}

export function buildBigModelApiUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  // 管理页与业务 API 共用显式 origin，避免把已登录账号带到另一个部署。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? DEFAULT_ZAI_OAUTH_ORIGIN,
  );
}

export function resolveZaiBusinessBaseUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ??
      DEFAULT_ZAI_BUSINESS_BASE_URL,
  );
}

export function resolveZaiOAuthClientId(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    DEFAULT_ZAI_OAUTH_CLIENT_ID
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = readProductEndpointEnv(),
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildZCodeEndpointUrls(origin: string): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    zcodePlanOpenAiBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/balance`,
  };
}

export function rewriteZCodeEndpointUrl(
  input: string | URL,
  endpointOrigin: string,
): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  const sourceOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` model-provider-family.ts 全量 ----------
 * 消费方：ToolCallBlocks/renderers/list-models、settings/model-provider-section/{useCodingPlanEntitlements,enterpriseCodingPlanProducts}、
 * lib/{modelSelectionGroups,startPlanEntitlementOptions}、v4/composer/modelTriggerDisplay、CodingPlanUpgradeDialog。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬全文件符号声明（oauth/model-provider-types/env/zcodeEndpoint 依赖已在本文件）。
 */
export type ModelProviderFamilyId = "zai" | "bigmodel";
export type ProviderFamilyDomain = ModelProviderFamilyId;

export interface ModelProviderFamilySpec {
  id: ModelProviderFamilyId;
  label: string;
  rootDomain: string;
  oauthProviderId: typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;
  startPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  individualCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  teamCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
  teamCodingPlanManageUrl: string;
}

export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId:
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId:
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({
      ZCODE_ENV,
    }),
  },
] as const satisfies readonly ModelProviderFamilySpec[];

const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<
  ModelProviderFamilyId,
  ModelProviderFamilySpec
>(MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]));

const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<
  BuiltinModelProviderId,
  ModelProviderFamilyId
>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec(
  familyId: ModelProviderFamilyId,
): ModelProviderFamilySpec {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId)!;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return (
    MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(
      providerId as BuiltinModelProviderId,
    ) ?? null
  );
}

export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of MODEL_PROVIDER_FAMILY_SPECS) {
    if (
      hostname === spec.rootDomain ||
      hostname.endsWith(`.${spec.rootDomain}`)
    ) {
      return spec.id;
    }
  }
  return null;
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(
  providerId: string,
): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return value === "zai" || value === "bigmodel" ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  return null;
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(
    params.providerFamilyDomain,
  );
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(
      params.activeOAuthProvider,
    ),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(
      params.activeOAuthProvider,
    ),
  });
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` provider-family-connection-selection.ts 全量 ----------
 * 消费方：settings/model-provider-section/useCodingPlanEntitlements。许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬全文件符号声明。
 */
const p9NonEmptyString = z.string().trim().min(1);

export const providerFamilyConnectionSelectionSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("start-plan") }).strict(),
    z.object({ kind: z.literal("individual-coding-plan") }).strict(),
    z
      .object({
        kind: z.literal("team-coding-plan"),
        productId: p9NonEmptyString,
        organizationId: p9NonEmptyString,
        projectId: p9NonEmptyString,
      })
      .strict(),
  ],
);

export const providerFamilyConnectionSelectionSettingsSchema = z
  .object({
    zai: providerFamilyConnectionSelectionSchema.optional(),
    bigmodel: providerFamilyConnectionSelectionSchema.optional(),
  })
  .partial();

/** 用户对一个 Provider Family 的连接选择意图；不包含账号身份或动态凭据。 */
export type ProviderFamilyConnectionSelection = Readonly<
  z.infer<typeof providerFamilyConnectionSelectionSchema>
>;

export type ProviderFamilyConnectionSelectionSettings = z.infer<
  typeof providerFamilyConnectionSelectionSettingsSchema
>;

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` automation-types.ts（切片：自定义重复规则） ----------
 * 消费方：ToolCallBlocks/renderers/cron-create、settings/automationCardSchedule。许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬符号声明。
 */
/** 自定义重复规则；cronExpr 保留为兼容展示，调度以本字段为权威。 */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：持久化文件变更） ----------
 * 消费方：lib/taskChangeSummary。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export type ZCodeTaskSnapshotFileContentField =
  | "beforeContent"
  | "afterContent";
export type ZCodeTurnFileState = "applied" | "reverted";
/** 持久化的文件快照 */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** 仅用于响应态快照：表示文件快照正文已被首屏预算裁剪，可按 ref 拉取完整内容。 */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}
export interface ZCodeTaskSnapshotFileContentRef {
  field: ZCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
}
/** 持久化的轮次文件变更 */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** 当前这轮文件变更是否仍应用在 workspace 上 */
  fileState?: ZCodeTurnFileState;
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` model-selection.ts（切片：Picker 展示值） ----------
 * 消费方：lib/zcodeSessionProjection。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` usage-stats.ts（切片：entitlement 请求） ----------
 * 消费方：hooks/useUsageEntitlement（IUsageStatsService.getEntitlementSnapshot 入参）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export interface UsageEntitlementRequest {
  /** 购买或领取完成后，使对应 Start Plan balance 短期缓存失效。 */
  invalidateBalanceCache?: boolean | undefined;
  /** 兼容旧调用方的提示；Coding Plan 权益必须查询订阅并返回摘要，不再允许仅用额度推断权益。 */
  includeSubscription?: boolean | undefined;
  /** 聊天输入区可传入当前选中的内置供应商,确保 BigModel/Z.AI 用量跟随模型选择。 */
  preferredProviderId?: string | undefined;
  /** 指定 Account Provider 的静态访问类别，或调用边界已解析的动态账号访问上下文。 */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | undefined;
  /** 当前模型已明确选中该内置供应商时，即使供应商列表里被隐藏也允许读取其 key。 */
  allowDisabledPreferredProvider?: boolean | undefined;
  /** 读取 Start Plan 余额必须显式指定 preferredProviderId（防误读其他 family 的余额）。 */
  requirePreferredProvider?: boolean | undefined;
  /** 契约兼容：允许 env 兜底 key 参与权益读取（本仓 BYOK 直连供应商场景）。 */
  allowEnvApiKey?: boolean | undefined;
}

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(
  selection: ModelSelection | undefined,
): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel
    ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}`
    : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(
    ZCODE_MODEL_REASONING_SEPARATOR,
  );
  if (
    reasoningSeparatorIndex <= 0 ||
    reasoningSeparatorIndex >= rawModelId.length - 1
  ) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` zcode-agent-model-state.ts（切片：模式 Select 选项） ----------
 * 消费方：lib/taskModelRecovery。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
const ZCODE_AGENT_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask before changes",
    description: "Ask before each file changes.",
  },
  {
    id: "edit",
    name: "Edit automatically",
    description:
      "Edit selected files or relevant workspace files automatically.",
  },
  {
    id: "plan",
    name: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    name: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const satisfies readonly ZCodeTaskModeInfo[];

export function getZCodeAgentModeSelectOptions(): NonNullable<
  ZCodeConfigOption["options"]
> {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` zcode-task-types-core.ts（切片：模式信息） ----------
 * 消费方：lib/taskModelRecovery / lib/zcodeSessionProjection。许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬符号声明。
 */
export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` protocol.ts（切片：DEFAULT_LOCALE） ----------
 * 消费方：ErrorBoundary。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明。
 */
export const DEFAULT_LOCALE: Locale = "zh-CN";

/* ---------- zcode 照搬（P9 补充）：`@zcode/shared` coding-plan-subscription.ts / channels.ts（消费切片） ----------
 * 消费方：hooks/useCodingPlanEntryPlanList、settings/model-provider-section/{enterpriseCodingPlanProducts,codingPlanProductPresentation,codingPlanEmbeddedWebview}、
 * settings/CodingPlanEmbeddedWebviewDialog。许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明
 * （CodingPlanSubscriptionProviderId 依赖的 BUILTIN_MODEL_PROVIDER_IDS 已在本文件）。
 */
export type CodingPlanSubscriptionProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

export interface CodingPlanCampaignDiscountDetail {
  campaignName?: string;
  campaignDiscountAmount?: number;
  rewardMode?: string;
  rewardAmount?: number;
  rewardDetail?: string;
  applyScene?: string;
}

export interface CodingPlanProductEquity {
  id?: number;
  productId?: string;
  productEquityTitle?: string;
  productEquityDetails?: string;
  createTime?: string;
  updateTime?: string;
}

export interface CodingPlanProductPreviewPayment {
  productId: string;
  productName?: string | undefined;
  productBigTitle?: string | undefined;
  productSmallTitle?: string | undefined;
  productIntroduction?: string | undefined;
  productDescription?: string | undefined;
  relateResourcePack?: string | undefined;
  inCurrentPeriod?: boolean | undefined;
  lastValid?: boolean | undefined;
  effectiveTime?: string | null | undefined;
  originalAmount?: number | undefined;
  discountAmount?: number | undefined;
  payAmount?: number | undefined;
  monthlyOriginalAmount?: number | undefined;
  monthlyRenewAmount?: number | undefined;
  monthlyPayAmount?: number | undefined;
  renewAmount?: number | undefined;
  canPurchase?: boolean | null | undefined;
  soldOut?: boolean | undefined;
  hasFirstTimeSubscriptionPromo?: boolean | undefined;
  delay?: boolean | undefined;
  canRepurchase?: boolean | null | undefined;
  forbidden?: boolean | undefined;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[] | undefined;
  productEquityList?: CodingPlanProductEquity[] | null | undefined;
  priceUnit?: "month" | "quarter" | "year" | undefined;
  priceCurrency?: "CNY" | "USD" | undefined;
}

export interface CodingPlanCardCopyItem {
  text: string;
  tooltip?: string;
}

export type CodingPlanCardCopyConfigItem = string | CodingPlanCardCopyItem;

export interface CodingPlanStaticProductEquity {
  productEquityTitle: string;
  productEquityDetails?: string;
}

export type EnterpriseCodingPlanTier = "LITE" | "PRO" | "MAX";
export type EnterpriseCodingPlanSubscribeMode = "CONTINUOUS" | "ONE_TIME";
export type EnterpriseCodingPlanSubscribePeriod =
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

export interface CodingPlanStaticTeamProduct {
  productId: string;
  productName: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName: string;
  priceCurrency: "CNY";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: CodingPlanCardCopyConfigItem[];
}

export type EnterpriseCodingPlanProjectApiKeyStatus =
  | "available"
  | "unavailable"
  | "unknown";

export type EnterpriseCodingPlanProjectApiKeyUnavailableReason =
  | "no_valid_team_plan_authorization"
  | "request_failed";

export interface EnterpriseCodingPlanProjectContext {
  organizationId: string;
  organizationName?: string | null;
  projectId: string;
  projectName?: string | null;
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
}

export interface EnterpriseCodingPlanPricingProduct {
  productId: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName?: string | undefined;
  originalAmount?: number | undefined;
  discountAmount?: number | undefined;
  payAmount?: number | undefined;
  renewAmount?: number | undefined;
  canRepurchase?: boolean | null | undefined;
  subscribed?: boolean | null | undefined;
  organizationId?: string | null | undefined;
  organizationName?: string | null | undefined;
  projectId?: string | null | undefined;
  projectName?: string | null | undefined;
  teamProjects?: EnterpriseCodingPlanProjectContext[] | undefined;
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus | undefined;
  apiKeyUnavailableReason?:
    | EnterpriseCodingPlanProjectApiKeyUnavailableReason
    | null
    | undefined;
  apiKeyUnavailableMessage?: string | null | undefined;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[] | undefined;
}

/**
 * Electron `<webview>`（partition=persist:zcode-coding-plan）的 `sendToHost` / `ipc-message` 频道。
 * 官网页通过 preload 注入的 window.zcodeBridge 调用，不经过 main process。
 */
export const CodingPlanWebviewChannels = {
  /** 官网页购买成功后通知 App 刷新 entitlements 并关闭 webview。 */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/** 购买完成回传 payload。provider 与官网 CodingPlanProvider / auth-ready 事件 detail.provider 同构。 */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** 客户端时间戳，用于 App 侧去重/日志，不参与判等。 */
  timestamp: number;
}

/**
 * 官网页 window.__zcodeLang__ 的取值，与 App IntlProvider 的 Locale 一致。
 * App locale 变化时通过 executeJavaScript 重写此变量并派发 lang-change 事件。
 */
export type CodingPlanWebviewLocale = "zh-CN" | "en-US";
