import type { CanvasContent } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  type CanvasContentStore,
  insertImageElement,
  insertVideoElement,
} from "./canvas-element-writer.js";

/**
 * 落画布必须走「原子追加」，不能「读-改-写」。
 * 回归锁：曾经是 read → append → writeContent(整份覆盖)，并发任务互相覆盖（丢元素）。
 */
function createRecordingStore(
  options: { content?: unknown; emptyContent?: boolean } = {},
) {
  const calls: Array<{ elements: unknown[]; files?: Record<string, unknown> }> =
    [];
  let writeContentCalls = 0;

  const store: CanvasContentStore = {
    async readContent() {
      if (options.emptyContent) {
        return null;
      }
      return (options.content ?? {
        appState: {},
        elements: [{ id: "existing" }],
        files: {},
      }) as CanvasContent;
    },
    async writeContent() {
      writeContentCalls += 1;
    },
    async appendContent(_canvasId, input) {
      calls.push({
        elements: [...input.elements],
        ...(input.files ? { files: input.files } : {}),
      });
    },
    async downloadObject() {
      return Buffer.from("image-bytes");
    },
  };

  return {
    calls,
    get writeContentCalls() {
      return writeContentCalls;
    },
    store,
  };
}

describe("画布元素写入器：原子追加", () => {
  it("图片：只追加新元素与新文件项，不整份覆盖写", async () => {
    const recorder = createRecordingStore();

    const result = await insertImageElement(recorder.store, {
      canvasId: "canvas-1",
      height: 100,
      mimeType: "image/png",
      objectPath: "project-assets/canvas-1/a.png",
      width: 200,
    });

    expect(recorder.writeContentCalls).toBe(0);
    expect(recorder.calls).toHaveLength(1);
    const appended = recorder.calls[0]!;
    // 只带新增的一个元素（不是整份元素表）
    expect(appended.elements).toHaveLength(1);
    expect((appended.elements[0] as { id: string }).id).toBe(result.elementId);
    // 只带新增的一个文件项，且是 base64 dataURL（Excalidraw 原生渲染需要）
    const fileKeys = Object.keys(appended.files ?? {});
    expect(fileKeys).toHaveLength(1);
    expect(appended.files?.[fileKeys[0]!]).toMatchObject({
      id: fileKeys[0],
      mimeType: "image/png",
    });
    expect(
      (appended.files?.[fileKeys[0]!] as { dataURL: string } | undefined)
        ?.dataURL,
    ).toBe(
      `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`,
    );
  });

  it("视频：只追加新元素，不写 files（可嵌入类型无需文件表项）", async () => {
    const recorder = createRecordingStore();

    await insertVideoElement(recorder.store, {
      canvasId: "canvas-1",
      height: 300,
      mimeType: "video/mp4",
      signedUrl: "http://127.0.0.1:3001/api/blobs/canvases/v.mp4?sig=x",
      width: 400,
    });

    expect(recorder.writeContentCalls).toBe(0);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.elements).toHaveLength(1);
    expect(recorder.calls[0]?.files).toBeUndefined();
  });

  it("显式位置优先于自动排布（两个并发落图里第二个可指定落点避免重叠）", async () => {
    const recorder = createRecordingStore();
    const placement = { height: 50, width: 60, x: 7, y: 9 };

    await insertVideoElement(
      recorder.store,
      {
        canvasId: "canvas-1",
        height: 300,
        mimeType: "video/mp4",
        signedUrl: "http://x/v.mp4",
        width: 400,
      },
      placement,
    );

    expect(recorder.calls[0]?.elements[0]).toMatchObject({ x: 7, y: 9 });
  });

  it("画布不存在时抛错且不写（读回 null 即中止）", async () => {
    const recorder = createRecordingStore({ emptyContent: true });
    // 读回 null → 写入器抛 Canvas not found
    await expect(
      insertImageElement(recorder.store, {
        canvasId: "missing",
        height: 10,
        mimeType: "image/png",
        objectPath: "x.png",
        width: 10,
      }),
    ).rejects.toThrow(/Canvas not found/);
    expect(recorder.calls).toHaveLength(0);
    expect(recorder.writeContentCalls).toBe(0);
  });
});
