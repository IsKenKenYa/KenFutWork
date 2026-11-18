import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CanvasFilesPanelProps } from "../src/components/canvas-files-panel";
import type { CanvasLayersPanelProps } from "../src/components/canvas-layers-panel";

vi.mock("../src/components/canvas-layers-panel", () => ({
  CanvasLayersPanel: ({ active }: CanvasLayersPanelProps) => (
    <div data-testid="layers" data-active={active}>
      画布图层
    </div>
  ),
}));
vi.mock("../src/components/canvas-files-panel", () => ({
  CanvasFilesPanel: ({
    active,
    canvasId,
    onRestoreAssets,
  }: CanvasFilesPanelProps) => (
    <div data-testid="files" data-active={active}>
      {canvasId}
      <button
        type="button"
        onClick={() => {
          void onRestoreAssets();
        }}
      >
        恢复素材
      </button>
    </div>
  ),
}));

import { CanvasInspector } from "../src/components/canvas-inspector";

afterEach(cleanup);

test("图层与素材在画布控件中独立切换，保持原资源恢复入口", () => {
  const restore = vi.fn(async () => {});
  const view = render(
    <CanvasInspector
      canvasId="canvas-a"
      excalidrawApi={null}
      accessToken={null}
      prepareCanvasAssetOperation={async () => "revision-a"}
      onCanvasSync={async () => {}}
      onRestoreAssets={restore}
    />,
  );
  expect(view.queryByRole("complementary")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "图层" }));
  expect(view.getByRole("complementary", { name: "图层" })).toBeTruthy();
  expect(view.getByTestId("layers").getAttribute("data-active")).toBe("true");
  expect(view.getByTestId("files").getAttribute("data-active")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "素材" }));
  expect(view.getByRole("complementary", { name: "素材" })).toBeTruthy();
  expect(view.getByTestId("layers").getAttribute("data-active")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "恢复素材" }));
  expect(restore).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole("button", { name: "收起" }));
  expect(view.queryByRole("complementary")).toBeNull();
});
