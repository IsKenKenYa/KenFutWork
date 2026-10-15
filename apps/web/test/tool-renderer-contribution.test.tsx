import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { buildToolDisplayModel } from "@zui/lib/toolDisplay.js";
import {
  ToolCallRendererProvider,
  type ToolCallRendererContribution,
  useToolCallRendererContributions,
} from "@zui/ToolCallBlocks/contributedRenderers.js";
import { ChangesGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/changes-group.js";
import { CuaToolCallBlock } from "@zui/ToolCallBlocks/renderers/cua.js";
import { CuaGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/cua-group.js";
import { ExecuteGroupToolCallBlock } from "@zui/ToolCallBlocks/renderers/execute-group.js";
import { FallbackToolCallBlock } from "@zui/ToolCallBlocks/renderers/fallback.js";
import { ReadToolCallBlock } from "@zui/ToolCallBlocks/renderers/read.js";
import { resolveToolCallRenderer } from "@zui/ToolCallBlocks/resolveRenderer.js";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";

afterEach(cleanup);

function context(
  kind = "read",
  toolName = "Read",
): ToolCallBlockRenderContext {
  const toolCall = {
    toolId: "tool-contribution",
    kind,
    toolName,
    input: {},
    output: "真实结果",
    status: "completed",
  };
  return {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "/workspace",
    displayModel: buildToolDisplayModel(toolCall, "/workspace"),
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "已完成",
    childToolList: null,
  };
}

function ContributedToolCallBlock({ toolCallNode }: ToolCallBlockRenderContext) {
  return (
    <output>
      {toolCallNode.toolCall.toolId}:{String(toolCallNode.toolCall.output)}
    </output>
  );
}

function Consumer({ value }: { value: ToolCallBlockRenderContext }) {
  const contributions = useToolCallRendererContributions();
  const Renderer = resolveToolCallRenderer(value, contributions);
  return Renderer === ContributedToolCallBlock ? (
    <Renderer {...value} />
  ) : (
    <output>原工具卡</output>
  );
}

it("未安装贡献provider时保留原工具卡和未知工具fallback", () => {
  const value = context();
  const view = render(<Consumer value={value} />);

  expect(view.getByRole("status").textContent).toBe("原工具卡");
  expect(resolveToolCallRenderer(value)).toBe(ReadToolCallBlock);
  expect(resolveToolCallRenderer(context("opaque", "opaque"))).toBe(
    FallbackToolCallBlock,
  );
});

it("贡献未匹配时仍使用原工具renderer", () => {
  const value = context();
  const matches = vi.fn(() => false);
  const renderers: ToolCallRendererContribution[] = [
    { id: "unmatched", matches, component: ContributedToolCallBlock },
  ];
  const view = render(
    <ToolCallRendererProvider renderers={renderers}>
      <Consumer value={value} />
    </ToolCallRendererProvider>,
  );

  expect(view.getByRole("status").textContent).toBe("原工具卡");
  expect(matches).toHaveBeenCalledWith(value);
  expect(resolveToolCallRenderer(value, renderers)).toBe(ReadToolCallBlock);
});

it("首个匹配贡献展示原上下文，撤下贡献后恢复原renderer", () => {
  const value = context();
  const laterMatches = vi.fn(() => true);
  const renderers: ToolCallRendererContribution[] = [
    {
      id: "matched",
      matches: () => true,
      component: ContributedToolCallBlock,
    },
    {
      id: "later",
      matches: laterMatches,
      component: ContributedToolCallBlock,
    },
  ];
  const view = render(
    <ToolCallRendererProvider renderers={renderers}>
      <Consumer value={value} />
    </ToolCallRendererProvider>,
  );

  expect(view.getByRole("status").textContent).toBe(
    "tool-contribution:真实结果",
  );
  expect(laterMatches).not.toHaveBeenCalled();

  view.rerender(
    <ToolCallRendererProvider renderers={[]}>
      <Consumer value={value} />
    </ToolCallRendererProvider>,
  );
  expect(view.getByRole("status").textContent).toBe("原工具卡");
});

const groupedRenderers: Array<{
  kind: string;
  renderer: ComponentType<ToolCallBlockRenderContext>;
}> = [
  { kind: "changesGroup", renderer: ChangesGroupToolCallBlock },
  { kind: "executeGroup", renderer: ExecuteGroupToolCallBlock },
  { kind: "cuaGroup", renderer: CuaGroupToolCallBlock },
];
it.each(groupedRenderers)("原$kind分组优先于匹配贡献", ({ kind, renderer }) => {
  const matches = vi.fn(() => true);

  expect(
    resolveToolCallRenderer(context(kind), [
      { id: "catch-all", matches, component: ContributedToolCallBlock },
    ]),
  ).toBe(renderer);
  expect(matches).not.toHaveBeenCalled();
});

it.each([
  "mcp__computer-use__get_app_state",
  "mcp__plugin_zcode_cua_computer_use__get_app_state",
])("原CUA工具%s优先于匹配贡献", (toolName) => {
  const matches = vi.fn(() => true);

  expect(
    resolveToolCallRenderer(context("cua", toolName), [
      { id: "catch-all", matches, component: ContributedToolCallBlock },
    ]),
  ).toBe(CuaToolCallBlock);
  expect(matches).not.toHaveBeenCalled();
});
