import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { StoreProvider } from "@zui/store/StoreProvider";
import { ToolCallBlock } from "@zui/ToolCallBlocks";
import { toolCallRowToLegacyNode } from "@zui/v4/toolCallRowAdapter";
import { readRawToolCallFileSummaries } from "@zui/ToolCallBlocks/shared";
import { createFileDisplayPublicFixture } from "../../server/src/features/code-ui/file-display.test-fixture";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

afterEach(() => {
  cleanup();
  restoreCodeRootBrowser();
  vi.unstubAllGlobals();
});

it("原ToolOutput解析保留多文件file_diffs真实partial/truncated展示，row顶层display不被冒充", () => {
  const file = {
    kind: "file_diff",
    filePath: "/work/a.ts",
    additions: 1,
    deletions: 1,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "+new"],
      },
    ],
  };
  const display = {
    kind: "file_diffs",
    files: [file, { ...file, filePath: "/work/b.ts", truncated: true }],
    truncated: true,
  };
  expect(
    protocol.toolOutputSchema.parse({ text: "已提交两项，第三项失败", display })
      .display,
  ).toEqual(display);
  expect(protocol.toolCallDisplaySchema.safeParse(display).success).toBe(false);
});

it("真实Edit经公开Harness事实和原V4解析保留完整diff，原工具卡点击打开补丁详情", async () => {
  installCodeRootBrowser();
  const fixture = await createFileDisplayPublicFixture();
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  try {
    expect(fixture.content).toBe("second\nsame\n");
    expect(fixture.canonicalResult).toMatchObject({
      canonicalOutput: {
        originalFile: "first\nsame\n",
        content: "second\nsame\n",
        oldString: "first",
        newString: "second",
      },
    });
    const event = fixture.events.find(
      (entry) => entry.type === "tool.completed" && entry.toolName === "Edit",
    );
    expect(event).toMatchObject({
      toolCallId: "edit-public",
      output: {
        display: {
          kind: "file_diff",
          filePath: fixture.filePath,
          additions: 1,
          deletions: 1,
          structuredPatch: [{ lines: ["-first", "+second"] }],
        },
      },
    });
    expect(fixture.row.output?.display).toMatchObject({
      kind: "file_diff",
      additions: 1,
      deletions: 1,
    });
    const node = toolCallRowToLegacyNode(fixture.row);
    expect(
      readRawToolCallFileSummaries(node.toolCall.raw, node.toolCall),
    ).toMatchObject([
      {
        path: fixture.filePath,
        changeStat: { added: 1, removed: 1 },
        patch: expect.stringContaining("-first"),
      },
    ]);
    const opened = vi.fn();
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <StoreProvider broadcastService={client.services.broadcastService}>
          <TooltipProvider>
            <ToolCallBlock
              toolCallNode={node}
              workspacePath={fixture.rootDirectory}
              onOpenCodeViewer={opened}
            />
          </TooltipProvider>
        </StoreProvider>
      </ZCodeIntlProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "example.ts" }));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch",
        path: fixture.filePath,
        patch: expect.stringContaining("+second"),
      }),
    );
  } finally {
    client.dispose();
    await fixture.dispose();
  }
});

it("真实ApplyPatch部分提交展示两个真实文件diff与失败，不把失败项或后续未执行伪造为成功", async () => {
  const fixture = await createFileDisplayPublicFixture(true);
  try {
    expect(fixture.content).toBe("second\nsame\n");
    expect(fixture.otherContent).toBe("right\n");
    expect(fixture.canonicalResult).toMatchObject({
      canonicalOutput: {
        files: [
          { filePath: fixture.filePath },
          { filePath: expect.stringContaining("other.ts") },
        ],
        failures: [
          {
            filePath: "missing.ts",
            error: expect.stringContaining("文件不存在"),
          },
        ],
      },
    });
    const event = fixture.events.find(
      (entry) =>
        entry.type === "tool.completed" && entry.toolName === "ApplyPatch",
    );
    expect(event).toMatchObject({
      status: "error",
      output: {
        display: {
          kind: "file_diffs",
          files: [
            { additions: 1, deletions: 1 },
            { additions: 1, deletions: 1 },
          ],
        },
      },
    });
    expect(fixture.row.status).toBe("error");
    const node = toolCallRowToLegacyNode(fixture.row);
    expect(
      readRawToolCallFileSummaries(node.toolCall.raw, node.toolCall),
    ).toMatchObject([
      {
        path: fixture.filePath,
        changeStat: { added: 1, removed: 1 },
        patch: expect.stringContaining("+second"),
      },
      {
        path: expect.stringContaining("other.ts"),
        changeStat: { added: 1, removed: 1 },
        patch: expect.stringContaining("+right"),
      },
    ]);
    expect(fixture.row.output?.text).toContain("失败 1");
  } finally {
    await fixture.dispose();
  }
});

it("真实Edit完整提交但预览受Task预算截断时，原工具卡保留总计数并明确提示部分补丁", async () => {
  installCodeRootBrowser();
  const fixture = await createFileDisplayPublicFixture(false, true);
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  try {
    expect(fixture.content.match(/second/g)).toHaveLength(2);
    expect(fixture.canonicalResult).toMatchObject({
      canonicalOutput: {
        structuredPatch: [
          { lines: [expect.stringMatching(/^-first/), expect.stringMatching(/^\+second/)] },
          { lines: [expect.stringMatching(/^-first/), expect.stringMatching(/^\+second/)] },
        ],
      },
    });
    expect(fixture.row.output?.display).toMatchObject({
      kind: "file_diff",
      additions: 2,
      deletions: 2,
      truncated: true,
      structuredPatch: [
        { lines: [expect.stringMatching(/^-first/), expect.stringMatching(/^\+second/)] },
      ],
    });
    const node = toolCallRowToLegacyNode(fixture.row);
    const summaries = readRawToolCallFileSummaries(node.toolCall.raw, node.toolCall);
    expect(summaries).toMatchObject([
      {
        path: fixture.filePath,
        changeStat: { added: 2, removed: 2 },
        truncated: true,
      },
    ]);
    expect(summaries[0]?.patch?.match(/\+second/g)).toHaveLength(1);
    const opened = vi.fn();
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <StoreProvider broadcastService={client.services.broadcastService}>
          <TooltipProvider>
            <ToolCallBlock
              toolCallNode={node}
              workspacePath={fixture.rootDirectory}
              onOpenCodeViewer={opened}
            />
          </TooltipProvider>
        </StoreProvider>
      </ZCodeIntlProvider>,
    );
    expect(
      (await screen.findByText("补丁预览受工作区字节预算限制，仅展示部分变更。")).textContent,
    ).toBe("补丁预览受工作区字节预算限制，仅展示部分变更。");
    fireEvent.click(screen.getByRole("button", { name: "example.ts" }));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ type: "patch", path: fixture.filePath, patch: summaries[0]?.patch }),
    );
  } finally {
    client.dispose();
    await fixture.dispose();
  }
});
