/**
 * zcode 宿主适配 stub：`@/lib/zcodeSessionProjection.ts` 的消费切片。
 * 来源：references/zcode/packages/ui/src/lib/zcodeSessionProjection.ts
 * 许可证：Apache-2.0（zcode）。
 *
 * 原文件是旧 ZCode session（legacy zcode-protocol）到聊天 projection 的迁移桥：snapshot/event
 * 映射、任务状态推导、可见标题解析都建立在旧协议会话数据之上。本仓没有旧协议会话数据源
 * （会话数据层整体 stub，见 v4/V4ConversationContext 等宿主缝），故只保留本仓消费方实际
 * 使用的 Picker 展示值互转两个纯函数（逐字照搬）；投影/映射函数不搬运。
 * 消费方：components/workflow-timeline/{workflowRunSettings,subagent-model-label,WorkflowRunSettingsPopover}。
 */
import {
  formatModelPickerValue as formatSharedModelSelection,
  type ModelSelection,
  parseModelPickerValue as parseSharedModelSelection,
} from "@zui/lib/zcode-shared";

export function formatModelPickerValue(
  ref: ModelSelection | undefined,
): string {
  return formatSharedModelSelection(ref);
}

export function parseModelPickerValue(value: string): ModelSelection {
  return parseSharedModelSelection(value);
}
