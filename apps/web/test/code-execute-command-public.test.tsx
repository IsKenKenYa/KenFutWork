import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { PermissionDialog } from "@zui/PermissionDialog";
import { ExecuteToolCallBlock } from "@zui/ToolCallBlocks/renderers/execute";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

it("审批预览展示待执行命令时不宣称没有输出", () => {
  const context: ToolCallBlockRenderContext = {
    toolCallNode: {
      toolCall: {
        toolId: "approval-command-public",
        kind: "execute",
        status: "pending",
        input: { command: "printf 'approval-request'" },
      },
      childToolCalls: [],
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: true,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "等待批准",
    childToolList: null,
    canToggle: false,
    forceOpen: true,
    isPermissionPreview: true,
  };

  const html = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ExecuteToolCallBlock {...context} />
    </ZCodeIntlProvider>,
  );

  expect(html).toContain("approval-request");
  expect(html).not.toContain("没有输出。");
});

it("原审批弹窗为待批准命令建立预览上下文", () => {
  const html = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <PermissionDialog
        request={{
          type: "permission_request",
          taskId: "approval-task-public",
          traceId: "approval-trace-public",
          requestId: "approval-dialog-public",
          description: "检查项目文件",
          kind: "execute",
          options: [
            {
              optionId: "allow-once",
              kind: "allowOnce",
              name: "Allow once",
              response: { decision: "allow" },
            },
          ],
          raw: { input: { command: "printf 'permission-dialog-request'" } },
        }}
        workspacePath="/workspace"
        onRespond={() => {
          throw new Error("展示审批预览不能提交审批");
        }}
      />
    </ZCodeIntlProvider>,
  );

  expect(html).toContain("permission-dialog-request");
  expect(html).not.toContain("没有输出。");
});
