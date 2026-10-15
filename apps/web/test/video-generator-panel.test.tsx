import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";
import { ToastProvider } from "../src/components/toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("未声明模型分辨率不等于仅支持720p", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      models: [
        {
          id: "11111111-1111-4111-8111-111111111111:custom-video",
          displayName: "视频模型",
          provider: "我的供应商",
        },
      ],
    }),
  );
  const api = {
    getSceneElements: () => [],
    updateScene: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={{
          type: "video-generator",
          prompt: "一只猫",
          model: "11111111-1111-4111-8111-111111111111:custom-video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          status: "idle",
        }}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
  await screen.findByText("视频模型");
  fireEvent.click(screen.getByRole("button", { name: /16:9.*5s/ }));
  fireEvent.click(screen.getByRole("button", { name: "1080p" }));
  expect(
    screen.getByRole("button", { name: /16:9.*5s/ }).textContent,
  ).toContain("1080");
});
