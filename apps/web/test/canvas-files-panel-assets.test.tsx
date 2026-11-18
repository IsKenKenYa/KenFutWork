import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  move: vi.fn(),
  relink: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  ApiApplicationError: class ApiApplicationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  inspectProjectFile: mocks.inspect,
  moveCanvasAsset: mocks.move,
  relinkProjectFile: mocks.relink,
}));
vi.mock("@/components/toast", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));
vi.mock("@/lib/download", () => ({ triggerDownload: vi.fn() }));

import { ApiApplicationError } from "@/lib/server-api";
import { CanvasFilesPanel } from "../src/components/canvas-files-panel";

const assetId = "asset-1";
const version = "a".repeat(64);
const element = {
  id: "video-1",
  type: "video",
  customData: { assetId, relativePath: "media/clip.mp4", version },
};
const api = {
  getSceneElements: () => [element],
  getFiles: () => ({}),
  onChange: () => () => {},
};
const onCanvasSync = vi.fn(async () => {});
const onRestoreAssets = vi.fn(async () => {});
const prepareCanvasAssetOperation = vi.fn(async () => "r".repeat(64));

function renderPanel(excalidrawApi: typeof api = api) {
  return render(
    <CanvasFilesPanel
      excalidrawApi={excalidrawApi as never}
      canvasId="canvas-1"
      prepareCanvasAssetOperation={prepareCanvasAssetOperation}
      active
      accessToken="token"
      onCanvasSync={onCanvasSync}
      onRestoreAssets={onRestoreAssets}
    />,
  );
}

describe("CanvasFilesPanel registered assets", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mocks.inspect.mockReset();
    mocks.move.mockReset();
    mocks.relink.mockReset();
    mocks.toastError.mockReset();
    onCanvasSync.mockClear();
    onRestoreAssets.mockClear();
    prepareCanvasAssetOperation.mockClear();
  });

  it("enables explicit relink only after inspect confirms the referenced file is missing", async () => {
    mocks.inspect.mockRejectedValue(
      new ApiApplicationError("file_missing", "文件不存在"),
    );
    renderPanel();

    expect(await screen.findByText(/文件缺失/)).toBeTruthy();
    const input = screen.getByLabelText(`素材目标路径 ${assetId}`);
    fireEvent.change(input, { target: { value: "media/recovered.mp4" } });
    fireEvent.click(screen.getByRole("button", { name: "重新关联" }));

    await waitFor(() =>
      expect(mocks.relink).toHaveBeenCalledWith("token", assetId, {
        relativePath: "media/recovered.mp4",
        expectedRelativePath: "media/clip.mp4",
        expectedVersion: version,
        fileVersion: version,
      }),
    );
    expect(onCanvasSync).toHaveBeenCalledOnce();
  });

  it("shows inspect authorization or network errors without labeling the asset missing", async () => {
    mocks.inspect.mockRejectedValue(
      new ApiApplicationError("unauthenticated", "请重新连接"),
    );
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("请重新连接");
    expect(screen.queryByText(/文件缺失/)).toBeNull();
    expect(screen.getByRole("button", { name: "重新关联" })).toBeDisabled();
  });

  it("refreshes after move and reports version conflicts from the API", async () => {
    mocks.inspect.mockResolvedValue({
      assetId,
      relativePath: "media/clip.mp4",
      version,
    });
    mocks.move
      .mockResolvedValueOnce({
        assetId,
        relativePath: "media/new.mp4",
        version,
      })
      .mockRejectedValueOnce(
        new ApiApplicationError("file_conflict", "素材版本已变化"),
      );
    renderPanel();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "移动" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText(`素材目标路径 ${assetId}`), {
      target: { value: "media/new.mp4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "移动" }));

    await waitFor(() =>
      expect(mocks.move).toHaveBeenCalledWith("token", "canvas-1", assetId, {
        relativePath: "media/new.mp4",
        expectedRelativePath: "media/clip.mp4",
        expectedVersion: version,
        expectedRevision: "r".repeat(64),
      }),
    );
    expect(prepareCanvasAssetOperation).toHaveBeenCalledOnce();
    expect(element.customData.relativePath).toBe("media/clip.mp4");
    await waitFor(() => expect(onCanvasSync).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "移动" }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("素材版本已变化"),
    );
    expect(onCanvasSync).toHaveBeenCalledOnce();
  });

  it("shows server path drift and offers explicit index restoration", async () => {
    const driftedApi = {
      ...api,
      getSceneElements: () => [
        {
          ...element,
          customData: { ...element.customData, assetError: "请恢复素材索引" },
        },
      ],
    };
    mocks.inspect.mockResolvedValue({
      assetId,
      relativePath: "media/moved.mp4",
      version: "b".repeat(64),
    });
    renderPanel(driftedApi);

    expect(
      await screen.findByText(/media\/clip\.mp4 → media\/moved\.mp4/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复素材索引" }));
    await waitFor(() => expect(onRestoreAssets).toHaveBeenCalledOnce());
    expect(screen.getByLabelText(`素材目标路径 ${assetId}`)).toHaveValue("");
  });
});
