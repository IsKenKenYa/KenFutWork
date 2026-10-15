import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import { ToastProvider } from "../src/components/toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("现有图片面板发送用户添加的参考图", async () => {
  let submitted: { inputImages?: string[] } | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: "11111111-1111-4111-8111-111111111111:gpt-image-1",
            displayName: "图片模型",
            provider: "我的供应商",
          },
        ],
      });
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      { error: { code: "test_rejection", message: "测试停止" } },
      { status: 502 },
    );
  });
  // Excalidraw 是外部编辑器边界；测试只提供此工作流消费的接口。
  const api = {
    getSceneElements: () => [],
    updateScene: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
  render(
    <ToastProvider>
      <ImageGeneratorPanel
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={{
          type: "image-generator",
          prompt: "一只猫",
          model: "11111111-1111-4111-8111-111111111111:gpt-image-1",
          aspectRatio: "1:1",
          quality: "hd",
          status: "idle",
        }}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("参考图入口未渲染");
  fireEvent.change(input, {
    target: {
      files: [new File(["image"], "reference.png", { type: "image/png" })],
    },
  });
  await screen.findByAltText("ref");
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted?.inputImages?.[0]).toMatch(/^data:image\/png;base64,/),
  );
});
