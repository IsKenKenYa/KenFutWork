import type { CanvasContent } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  type CanvasContentStore,
  insertImageElement,
  insertVideoElement,
} from "./canvas-element-writer.js";

it("相同生成Job重复发布只创建一个元素，不复活用户删除或覆盖用户调整", async () => {
  let content: CanvasContent = { elements: [], files: {}, appState: {} };
  let writes = 0;
  const store: CanvasContentStore = {
    readContent: async () => structuredClone(content),
    appendContent: async (_canvas, input) => {
      writes++;
      content = {
        ...content,
        elements: [...content.elements, ...input.elements],
        files: { ...content.files, ...input.files },
      };
    },
  };
  const input = {
    canvasId: "canvas",
    insertionId: "job",
    objectPath: "file",
    width: 100,
    height: 200,
    mimeType: "image/png",
  };
  const first = await insertImageElement(store, input);
  const second = await insertImageElement(store, input);
  expect(second).toEqual(first);
  expect(writes).toBe(1);
  const element = content.elements[0];
  if (!element) throw new Error("测试前置缺失");
  element.x = 999;
  element.isDeleted = true;
  expect(await insertImageElement(store, input)).toEqual(first);
  expect(writes).toBe(1);
  expect(content.elements[0]).toMatchObject({ x: 999, isDeleted: true });
  await expect(
    insertImageElement(store, { ...input, objectPath: "different-source" }),
  ).rejects.toThrow("身份冲突");
});

it("同一视频Job的URL刷新不创建新元素，素材身份变化则拒绝", async () => {
  const content: CanvasContent = { elements: [], files: {}, appState: {} };
  const store: CanvasContentStore = {
    readContent: async () => content,
    appendContent: async (_id, input) => {
      content.elements.push(...input.elements);
    },
  };
  const input = {
    canvasId: "canvas",
    insertionId: "video-job",
    assetId: "asset",
    signedUrl: "http://file?sig=old",
    width: 640,
    height: 360,
    mimeType: "video/mp4",
  };
  const first = await insertVideoElement(store, input);
  expect(
    await insertVideoElement(store, {
      ...input,
      signedUrl: "http://file?sig=fresh",
    }),
  ).toEqual(first);
  expect(content.elements).toHaveLength(1);
  await expect(
    insertVideoElement(store, { ...input, assetId: "other-asset" }),
  ).rejects.toThrow("身份冲突");
});

/**
 * 落画布必须走「原子追加」，不能「读-改-写」。
 * 回归锁：曾经是 read → append → writeContent(整份覆盖)，并发任务互相覆盖（丢元素）。
 */
function createRecordingStore(
  options: { content?: unknown; emptyContent?: boolean } = {},
) {
  const calls: Array<{ elements: unknown[]; files?: Record<string, unknown> }> =
    [];

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
    async appendContent(_canvasId, input) {
      calls.push({
        elements: [...input.elements],
        ...(input.files ? { files: input.files } : {}),
      });
    },
  };

  return {
    calls,

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

    expect(recorder.calls).toHaveLength(1);
    const appended = recorder.calls[0];
    if (!appended) {
      throw new Error("未记录到追加写调用");
    }
    // 只带新增的一个元素（不是整份元素表）
    expect(appended.elements).toHaveLength(1);
    expect((appended.elements[0] as { id: string }).id).toBe(result.elementId);
    // 只带新增的一个文件项，保留原对象引用（不下载重编码）
    const fileKeys = Object.keys(appended.files ?? {});
    expect(fileKeys).toHaveLength(1);
    const fileKey = fileKeys[0];
    if (fileKey === undefined) {
      throw new Error("未记录到文件项");
    }
    expect(appended.files?.[fileKey]).toMatchObject({
      id: fileKey,
      mimeType: "image/png",
    });
    expect(
      (appended.files?.[fileKey] as { dataURL: string } | undefined)?.dataURL,
    ).toBe("oss://project-assets/project-assets/canvas-1/a.png");
  });

  it("视频：只追加新元素，不写 files（可嵌入类型无需文件表项）", async () => {
    const recorder = createRecordingStore();

    await insertVideoElement(recorder.store, {
      canvasId: "canvas-1",
      height: 300,
      mimeType: "video/mp4",
      signedUrl: "http://127.0.0.1:3001/api/blobs/canvases/v.mp4?sig=x",
      width: 400,
      assetId: "video-asset",
      relativePath: "clips/video.mp4",
      assetVersion: "sha256-original",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.elements).toHaveLength(1);
    expect(recorder.calls[0]?.files).toBeUndefined();
    expect(recorder.calls[0]?.elements[0]).toMatchObject({
      customData: {
        assetId: "video-asset",
        relativePath: "clips/video.mp4",
        version: "sha256-original",
      },
    });
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
  });
});
