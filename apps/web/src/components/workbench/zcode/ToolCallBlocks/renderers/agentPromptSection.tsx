/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/agentPromptSection.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/agentPromptSection.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 * 适配注记：接口可选属性放宽 | undefined 以等价 zcode tsconfig 行为（exactOptionalPropertyTypes）。
 */
import { MessageResponse } from "@zui/components/ai-elements/message";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";
import { formatAgentMessage } from "./agentHelpers";

export function AgentPromptSection({
  prompt,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  prompt: string;
  workspacePath: string;
  theme?: ToolCallBlockRenderContext["theme"] | undefined;
  codePreviewSettings?:
    | ToolCallBlockRenderContext["codePreviewSettings"]
    | undefined;
  onOpenCodeViewer?: ToolCallBlockRenderContext["onOpenCodeViewer"] | undefined;
  onOpenFileLink?: ToolCallBlockRenderContext["onOpenFileLink"] | undefined;
  onOpenBrowserUrl?: ToolCallBlockRenderContext["onOpenBrowserUrl"] | undefined;
}) {
  const { intl } = useZCodeIntl();
  const promptLabel = formatAgentMessage(
    intl,
    "chat.toolCall.agent.prompt",
    "Prompt",
  );

  return (
    <section className="space-y-2">
      <div className="rounded-lg border border-border flex flex-col">
        <div className="flex min-w-0 items-center p-3">
          <h4 className="min-w-0 text-ui-base font-medium tracking-wide text-foreground-subtlest uppercase">
            {promptLabel}
          </h4>
        </div>
        <div
          className="overflow-auto max-h-50"
          data-markdown-table-sticky-scrollbar="disabled"
        >
          {/* Agent prompt 里可能包含代码块或长命令，手机窄屏只开纵向滚动会裁掉横向内容。*/}
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={workspacePath}
            {...(theme === undefined ? {} : { theme })}
            {...(codePreviewSettings === undefined
              ? {}
              : { codePreviewSettings })}
            {...(onOpenCodeViewer === undefined ? {} : { onOpenCodeViewer })}
            {...(onOpenFileLink === undefined ? {} : { onOpenFileLink })}
            {...(onOpenBrowserUrl === undefined
              ? {}
              : { onOpenExternalUrl: onOpenBrowserUrl })}
          >
            {prompt}
          </MessageResponse>
        </div>
      </div>
    </section>
  );
}
