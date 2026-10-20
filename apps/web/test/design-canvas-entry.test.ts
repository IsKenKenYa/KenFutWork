import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: mocks.json,
}));

import {
  ensureDesignCanvasEntry,
  resolveDesignDocumentEntry,
} from "../src/components/workbench/zcode/host/canvasDocumentNavigation.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const primaryId = "20000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";
const revision = "a".repeat(64);

beforeEach(() => mocks.json.mockReset());

describe("ensureDesignCanvasEntry", () => {
  test("主画布优先", async () => {
    mocks.json.mockResolvedValue({
      canvases: [
        { id: secondId, name: "副画布", isPrimary: false },
        { id: primaryId, name: "主画布", isPrimary: true },
      ],
    });
    await expect(ensureDesignCanvasEntry(projectId)).resolves.toEqual({
      documentId: primaryId,
      title: "主画布",
    });
  });

  test("没有主画布时退回第一个，不新建", async () => {
    mocks.json.mockResolvedValue({
      canvases: [
        { id: secondId, name: "副画布", isPrimary: false },
        { id: primaryId, name: "别的", isPrimary: false },
      ],
    });
    await expect(ensureDesignCanvasEntry(projectId)).resolves.toEqual({
      documentId: secondId,
      title: "副画布",
    });
    expect(
      mocks.json.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  test("项目一个画布都没有时自动建一个再返回", async () => {
    mocks.json
      .mockResolvedValueOnce({ canvases: [] })
      .mockResolvedValueOnce({
        canvas: {
          id: primaryId,
          name: "未命名画布",
          projectId,
          revision,
          content: { elements: [], appState: {}, files: {} },
        },
      });
    await expect(ensureDesignCanvasEntry(projectId)).resolves.toEqual({
      documentId: primaryId,
      title: "未命名画布",
    });
    const post = mocks.json.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(String(post?.[0])).toBe(
      `/api/projects/${projectId}/canvases`,
    );
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.name).toBe("未命名画布");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("建出来的画布不属于本项目时不返回它（防串项目）", async () => {
    mocks.json
      .mockResolvedValueOnce({ canvases: [] })
      .mockResolvedValueOnce({
        canvas: {
          id: primaryId,
          name: "别人的",
          projectId: "99999999-0000-4000-8000-000000000009",
          revision,
          content: { elements: [], appState: {}, files: {} },
        },
      });
    await expect(ensureDesignCanvasEntry(projectId)).rejects.toThrow(
      /画布创建失败/,
    );
  });

  test("列表契约不符时给出可读原因", async () => {
    mocks.json.mockResolvedValue({ nope: true });
    await expect(ensureDesignCanvasEntry(projectId)).rejects.toThrow(
      /画布列表不可用/,
    );
  });
});

/**
 * 回归锁：宿主在没有文档标签时只能给出 `{title:"画布"}` 且没有 documentId。
 * 直接拿它开标签就会留下一个空白标签，画布视图再请求真实画布时得到第二个标签
 * （2026-10-20 用户截图：空白的「画布」与「未命名画布」并排）。
 * 正确用法是先 ensureDesignCanvasEntry 拿到真实 documentId 再开。
 */
describe("Design 入口不产生空白标签", () => {
  test("无文档标签时 resolveDesignDocumentEntry 确实给不出 documentId", () => {
    const entry = resolveDesignDocumentEntry(null, {
      projectId,
      workspaceKey: "k",
    });
    expect(entry.documentId).toBeUndefined();
    expect(entry.title).toBe("画布");
  });

  test("补上 ensureDesignCanvasEntry 后拿到的是真实画布文档", async () => {
    mocks.json.mockResolvedValue({
      canvases: [{ id: primaryId, name: "主画布", isPrimary: true }],
    });
    const blank = resolveDesignDocumentEntry(null, {
      projectId,
      workspaceKey: "k",
    });
    const canvasEntry = await ensureDesignCanvasEntry(projectId);
    expect(canvasEntry.documentId).toBeTruthy();
    expect(blank.documentId ?? canvasEntry.documentId).toBe(primaryId);
  });
});
