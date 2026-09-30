/**
 * zcode 照搬：`@/lib/taskChatMessageTypes.ts`（references/zcode/packages/ui/src/lib/taskChatMessageTypes.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 * 适配注记：接口可选属性放宽 | undefined 以等价 zcode tsconfig 行为（exactOptionalPropertyTypes）。
 */
// re-home 产物（为删除 zcodeChatMessages 铺路，模式同 zcode-task-types-core）。
// 本文件承载旧消息转换层（zcodeChatMessages/zcodeChatMessageHelpers）中仍被存活栈
// type-only 消费的承重类型：TaskChatMessage / TaskChatToolCall / TaskChatMessagePart。
// 消费方：ToolCallBlocks(toolCallTree) / PermissionDialog / taskChangeSummary /
// treemappingActivity / codeViewer / toolDisplay / toolError / app-shell 测试注入通道。
// 旧消息拼装运行时（zcodeChatMessages.ts）删除后，这里是该类型面的唯一事实源。
import type {
  ZCodeAssistantMessageFeedback,
  ZCodeAssistantMessagePart,
  ZCodePromptAttachment,
  ZCodeTaskSnapshotBodyRef,
  ZCodeTaskSnapshotToolFieldRef,
  ZCodeTaskSnapshotToolSlice,
  ZCodeTimelineMeta,
} from "@zui/lib/zcode-shared";

export interface TaskChatToolCall {
  toolId: string;
  /** 上级 toolCallId；null 表示主 agent，非空表示来自某个 Task/Agent 子工具。 */
  parentToolUseId?: string | null | undefined;
  /** ZCode 固定工具名；kind 仍保留给旧 ZCode Agent 快照和 UI 聚合分类兼容。 */
  toolName?: string | undefined;
  kind: string;
  title?: string | undefined;
  input: unknown;
  status: string;
  /** parentToolUseId 归属的子 agent 正文输出。 */
  content?: string | undefined;
  /** parentToolUseId 归属的子 agent 思考输出。 */
  thought?: string | undefined;
  output?: unknown;
  error?: string | undefined;
  raw?: unknown;
  /** 工具大字段被快照预算裁剪后的引用；用于按需回填该工具的完整 input/output/raw。 */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[] | undefined;
  /** tool call 首次进入当前消息流的本地时间，仅用于识别长时间运行中的工具调用。 */
  startedAt?: number | undefined;
}

export type TaskChatMessagePart = ZCodeAssistantMessagePart;

export interface TaskModelChangeUiTimeline {
  type: "model_change";
  fromModelLabel: string;
  toModelLabel: string;
}

export type TaskUiTimelineMeta = TaskModelChangeUiTimeline;

export interface TaskChatMessage {
  id: string;
  /** session snapshot 中的稳定协议 messageId；实时流 id 可能只是临时展示身份。 */
  protocolMessageId?: string | undefined;
  /** snapshot 合并 assistant 后保留的原始 messageId 集合，用于 timeline anchor 命中合并前子消息。 */
  mergedMessageIds?: string[] | undefined;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** assistant 归属的 legacy goal 展示迭代；仅用于历史区状态文案，不参与 verifier 轮次判定。 */
  goalIteration?: number | undefined;
  /** UI-only streaming 分组；用于切开 model-only goal 续跑，不参与 goal 轮次语义。 */
  streamGroupId?: string | undefined;
  mailboxMessage?: {
    content: string;
    createdAt?: string | undefined;
    fromSessionId: string;
    messageId: string;
  };
  /** assistant 历史区最终耗时；仅在本轮结束后写入，避免 UI 每次恢复都重新猜测。 */
  durationMs?: number | undefined;
  /** assistant 是否以主动停止/中断结束；用于 UI 抑制 latest 区误判为“自然完成”。 */
  interrupted?: boolean | undefined;
  /** 用户对 assistant 回复的本地反馈；只做展示/持久化，不进入后续模型上下文。 */
  feedback?: ZCodeAssistantMessageFeedback | undefined;
  attachments?: ZCodePromptAttachment[] | undefined;
  toolCalls?: TaskChatToolCall[] | undefined;
  thought?: string | undefined;
  /**
   * 之前 assistant 消息只按 thought/tool/content 三个聚合字段渲染，
   * 一旦同一轮里既有正文又有工具调用，UI 就只能固定"工具在上、正文在下"。
   * 这里额外记录流式事件真实到达顺序，让渲染层可以按事件顺序回放，而不是按字段分组硬排版。
   */
  parts?: TaskChatMessagePart[] | undefined;
  /** 该消息所属的对话轮次，用于关联 per-turn 文件变更摘要和回滚 */
  turnIndex?: number | undefined;
  /** 大消息首屏 preview 的完整正文引用。存在时 UI 必须把正文视为未完整加载。 */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[] | undefined;
  /** tools 被按条数切片返回时的游标信息；用于“查看更多工具调用”补拉。 */
  toolSlice?: ZCodeTaskSnapshotToolSlice | undefined;
  /** 是否仍在流式输出，仅用于当前运行期 UI 恢复，不参与持久化 */
  streaming?: boolean | undefined;
  /** ZCode Agent synthetic timeline 消息，不参与 assistant 正文、工具调用和 fork。 */
  syntheticTimeline?: ZCodeTimelineMeta | undefined;
  /** UI-only synthetic timeline 消息，不进入协议快照或本地历史。 */
  uiTimeline?: TaskUiTimelineMeta | undefined;
  /** ZCode CLI turn steering 状态标记，仅用于用户消息展示。 */
  turnSteer?: {
    status: "guided";
  };
}
