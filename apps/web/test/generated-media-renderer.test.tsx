import { zcodeUiProtocol } from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  GeneratedMediaToolCallBlock,
  generatedMediaRenderer,
} from "../src/components/workbench/zcode/host/GeneratedMediaRenderer.js";
import { buildToolDisplayModel } from "../src/components/workbench/zcode/lib/toolDisplay.js";
import {
  resolveContributedToolCallRenderer,
  ToolCallRendererProvider,
  useToolCallRendererContributions,
} from "../src/components/workbench/zcode/ToolCallBlocks/contributedRenderers.js";
import type { ToolCallBlockRenderContext } from "../src/components/workbench/zcode/ToolCallBlocks/shared.js";

type GeneratedMediaDisplay = zcodeUiProtocol.GeneratedMediaDisplay;
const { generatedMediaDisplaySchema } = zcodeUiProtocol;
const mocks = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: mocks.json,
  getSurfaceApiBase: () => "https://local.test",
}));
vi.mock(
  "../src/components/workbench/zcode/ToolCallBlocks/ToolLayout.js",
  () => ({
    ToolLayout: ({ renderContent }: { renderContent: () => ReactNode }) => (
      <div>{renderContent()}</div>
    ),
  }),
);
vi.mock(
  "../src/components/workbench/zcode/ToolCallBlocks/renderers/fallback.js",
  () => ({
    FallbackToolCallBlock: (props: ToolCallBlockRenderContext) => (
      <div role="status">
        {props.toolCallNode.toolCall.status}:{props.errorText}
      </div>
    ),
  }),
);
const image = generatedMediaDisplaySchema.parse({
  kind: "generated_media",
  version: 1,
  jobId: "10000000-0000-4000-8000-000000000001",
  assetId: "20000000-0000-4000-8000-000000000001",
  mediaType: "image",
  mimeType: "image/png",
  width: 400,
  height: 300,
  title: "海报",
});
function context(
  display: unknown = image,
  status = "completed",
): ToolCallBlockRenderContext {
  const toolCall = {
    toolId: "tool-a",
    kind: "opaque-plugin-tool",
    input: {},
    output: "已生成",
    status,
    raw: { display },
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
beforeEach(() => {
  mocks.json
    .mockReset()
    .mockResolvedValue({ url: "https://asset.test/signed" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("通用注册接口按display选择贡献renderer，不按工具名或会话模式分支", async () => {
  const value = context();
  function Consumer() {
    const Renderer = resolveContributedToolCallRenderer(
      value,
      useToolCallRendererContributions(),
    );
    return Renderer ? <Renderer {...value} /> : null;
  }
  const view = render(
    <ToolCallRendererProvider renderers={[generatedMediaRenderer]}>
      <Consumer />
    </ToolCallRendererProvider>,
  );
  const preview = await view.findByRole("img", { name: "海报" });
  expect(preview.getAttribute("src")).toBe("https://asset.test/signed");
  expect(mocks.json.mock.calls[0]?.[0]).toBe(
    `/api/uploads/${image.assetId}/url`,
  );
  expect(
    resolveContributedToolCallRenderer(context(undefined), []),
  ).toBeUndefined();
});

test("视频使用授权URL与原生controls，同ID重复卡片共用在飞请求", async () => {
  const video: GeneratedMediaDisplay = {
    ...image,
    mediaType: "video",
    mimeType: "video/mp4",
    title: "短片",
  };
  let resolve: ((value: { url: string }) => void) | undefined;
  mocks.json.mockImplementation(
    () =>
      new Promise<{ url: string }>((done) => {
        resolve = done;
      }),
  );
  const view = render(
    <>
      <GeneratedMediaToolCallBlock {...context(video)} />
      <GeneratedMediaToolCallBlock {...context(video)} />
    </>,
  );
  expect(mocks.json).toHaveBeenCalledOnce();
  resolve?.({ url: "https://asset.test/video" });
  await waitFor(() =>
    expect(view.container.querySelectorAll("video")).toHaveLength(2),
  );
  for (const preview of view.container.querySelectorAll("video")) {
    expect(preview.controls).toBe(true);
    expect(preview.getAttribute("src")).toBe("https://asset.test/video");
  }
});

test("失败、取消与坏schema不获取预览，过期URL不写入display事实", () => {
  const failed = render(
    <GeneratedMediaToolCallBlock
      {...context(image, "failed")}
      errorText="生成失败"
    />,
  );
  expect(failed.queryByRole("img")).toBeNull();
  failed.unmount();
  const cancelled = render(
    <GeneratedMediaToolCallBlock {...context(image, "stopped")} />,
  );
  expect(cancelled.queryByRole("img")).toBeNull();
  cancelled.unmount();
  const malformed = render(
    <GeneratedMediaToolCallBlock
      {...context({ ...image, version: 2, url: "https://expired.test" })}
    />,
  );
  expect(malformed.getByRole("alert").textContent).toContain(
    "生成结果无法显示",
  );
  expect(
    generatedMediaDisplaySchema.safeParse({
      ...image,
      url: "https://expired.test",
    }).success,
  ).toBe(false);
  expect(mocks.json).not.toHaveBeenCalled();
});

test("URL解析失败与媒体加载失败明确报错，显式重试重新取得授权", async () => {
  mocks.json
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ url: "https://asset.test/new-signed" });
  const view = render(<GeneratedMediaToolCallBlock {...context()} />);
  await view.findByRole("alert");
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  const imageNode = await view.findByRole("img", { name: "海报" });
  expect(mocks.json).toHaveBeenCalledTimes(2);
  fireEvent.error(imageNode);
  expect(view.getByRole("alert").textContent).toContain("预览无法加载");
});

test("同条重放不重复取URL，取消后的迟到URL不重新显示成果", async () => {
  let resolve: ((value: { url: string }) => void) | undefined;
  mocks.json.mockImplementation(
    () =>
      new Promise<{ url: string }>((done) => {
        resolve = done;
      }),
  );
  const view = render(<GeneratedMediaToolCallBlock {...context()} />);
  view.rerender(
    <GeneratedMediaToolCallBlock {...context(structuredClone(image))} />,
  );
  expect(mocks.json).toHaveBeenCalledOnce();
  view.rerender(<GeneratedMediaToolCallBlock {...context(image, "stopped")} />);
  await act(async () => {
    resolve?.({ url: "https://asset.test/late" });
  });
  await waitFor(() => expect(view.queryByRole("img")).toBeNull());
  expect(view.getByRole("status").textContent).toBe("stopped:");
});
