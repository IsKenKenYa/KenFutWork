/**
 * zcode 宿主适配 stub：`@/v4/transport.ts` 的类型切片。
 * 来源：references/zcode/packages/ui/src/v4/transport.ts
 * 许可证：Apache-2.0（zcode）。
 *
 * ConversationTransport 是 v4 会话数据层的传输接缝（desktop 走 preload/MessagePort，
 * web 走 ws relay），完整接口面覆盖 subscribe/command/rowsRange/workflowRun 系列/附件等
 * 全部 RPC 方法。本仓没有该传输实现（会话数据层整体 stub，见 V4ConversationContext
 * 宿主缝），故只保留本仓消费方以类型位引用的附件读取两个方法签名（逐字照搬），
 * 其余方法不搬运；运行时没有任何实现注入。
 * 消费方：v4/conversationRowContext（readAttachment / readAttachmentRange 的类型位）。
 */
import type { ConversationRowTarget } from "@zui/lib/zcode-shared/zcode-protocol-v4";

/**
 * 一条 host 连接上的 v4 conversation 传输面（切片：仅附件读取；完整接口见上游 transport.ts）。
 */
export interface ConversationTransport {
  /** 已发送 image/video 高层读取；Desktop 本地视频可返回已授权 URL，其余循环小块。 */
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): Promise<
    | { bytes: Uint8Array; mediaType: string }
    | { url: string; mediaType: string }
  >;
  /** 已发送 PDF 的授权 range 读取；不会把完整文件先读入 renderer。 */
  attachmentReadRange(
    params: ConversationAttachmentReadParams & {
      offset: number;
      limit: number;
    },
  ): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    totalBytes: number;
    nextOffset: number | null;
  }>;
}

export interface ConversationAttachmentReadParams {
  sessionId: string;
  ref: string;
  /** 仅用于决定是否查询 Desktop local video source；最终 MIME 仍由 CLI 权威返回。 */
  mediaType?: string;
  /** 新 row 有稳定 identity；旧 snapshot 缺失时保持 ref-only 兼容。 */
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  /** Dialog 关闭、切换或卸载时停止后续分块请求。 */
  signal?: AbortSignal;
}
