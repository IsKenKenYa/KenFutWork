import { cleanup, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import type { TaskChatToolCall } from "@zui/lib/taskChatMessageTypes.js";
import { CuaToolCallBlock } from "@zui/ToolCallBlocks/renderers/cua.js";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

function renderCall(
  action: string,
  failed = false,
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  const toolCall: TaskChatToolCall = {
    toolId: `${action}-${failed}`,
    toolName: `mcp__computer-use__${action}`,
    kind: "cua",
    status: failed ? "failed" : "success",
    input: {},
    raw: {
      display: {
        kind: "cua",
        schemaVersion: 1,
        toolName: `mcp__computer-use__${action}`,
        status: failed ? "failed" : "success",
        structuredContent: JSON.stringify({
          state_id: "s-1",
          image: { width: 420, height: 332 },
        }),
        media: [{ mimeType: "image/png", data: "cG5n" }],
      },
    },
  };
  const context: ToolCallBlockRenderContext = {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "/fixture",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: true,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    forceOpen: true,
  };
  return render(
    <ZCodeIntlProvider initialLocale={locale}>
      <CuaToolCallBlock {...context} />
    </ZCodeIntlProvider>,
  );
}

it("原观察卡显示附带PNG及结构化尺寸，失败卡不显示截图", () => {
  const view = renderCall("get_app_state");
  expect(screen.getByRole("img").getAttribute("src")).toBe(
    "data:image/png;base64,cG5n",
  );
  expect(screen.getByText("420 × 332").textContent).toBe("420 × 332");
  view.unmount();
  renderCall("get_app_state", true);
  expect(screen.queryByRole("img")).toBeNull();
});

it.each([
  ["focus_window", "激活窗口"],
  ["list_displays", "查看显示器"],
  ["list_backends", "查看控制后端"],
  ["select_backend", "切换控制后端"],
])("原%s卡呈现明确操作摘要", (action, label) => {
  renderCall(action);
  expect(screen.getAllByText(label).length).toBeGreaterThan(0);
});

it("宿主扩展标签跟随原语言状态", () => {
  renderCall("focus_window", false, "en-US");
  expect(screen.getAllByText("Focus window").length).toBeGreaterThan(0);
});
