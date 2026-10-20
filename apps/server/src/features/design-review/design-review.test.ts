import { describe, expect, it, vi } from "vitest";
import type { LocalActor } from "../local-instance/types.js";
import { createDesignReviewService } from "./design-review-service.js";
import type {
  DesignReviewAnnotationRow,
  DesignReviewCommentRow,
  DesignReviewRepository,
} from "./repository.js";

/**
 * 设计评审服务：行→契约的映射与实例作用域。
 *
 * 这两件事是这个缝全部的可观察行为——SQL 在 repository（集成测试覆盖），
 * 归属在 `:instance` 谓词（客户端强制）。这里钉的是「面板拿到的形状」和
 * 「有没有可能读到别人实例的数据」。
 */

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const otherInstance = "22222222-2222-4222-8222-222222222222";

const commentRow: DesignReviewCommentRow = {
  id: "c-1",
  project_id: "p-1",
  file_name: "index.html",
  body: "标题太浅",
  status: "open",
  anchor_path: "body > h1",
  anchor_rect: { x: 20, y: 40, w: 200, h: 40 },
  anchor_excerpt: "登录",
  created_at: 1792477257537,
  updated_at: 1792477257600,
};

const annotationRow: DesignReviewAnnotationRow = {
  id: "a-1",
  project_id: "p-1",
  file_name: "index.html",
  kind: "pen",
  color: "#ef4444",
  stroke_width: "3",
  points: [
    [0.1, 0.2],
    [0.3, 0.4],
  ],
  created_at: 1792477257537,
  updated_at: 1792477257600,
};

type RepositorySpies = Record<keyof DesignReviewRepository, ReturnType<typeof vi.fn>>;

/** 假 repository：`service` 拿契约形状，`spies` 拿调用记录（两套类型各管各的）。 */
function fakeRepository(
  overrides: Partial<RepositorySpies> = {},
): { service: DesignReviewRepository; spies: RepositorySpies } {
  const spies: RepositorySpies = {
    listComments: vi.fn(async () => [commentRow]),
    insertComment: vi.fn(async () => commentRow),
    updateComment: vi.fn(async () => commentRow),
    deleteComment: vi.fn(async () => 1),
    listAnnotations: vi.fn(async () => [annotationRow]),
    insertAnnotation: vi.fn(async () => annotationRow),
    deleteAnnotation: vi.fn(async () => 1),
    ...overrides,
  };
  return { spies, service: spies as unknown as DesignReviewRepository };
}

describe("design-review service", () => {
  it("list：两份清单都按实例作用域读，行形状映射成契约", async () => {
    const { service: repository, spies } = fakeRepository();
    const service = createDesignReviewService({ repository });
    const result = await service.list(actor, {
      projectId: "p-1",
      file: "index.html",
    });
    expect(spies.listComments).toHaveBeenCalledWith(
      actor.instanceId,
      "p-1",
      "index.html",
    );
    expect(spies.listAnnotations).toHaveBeenCalledWith(
      actor.instanceId,
      "p-1",
      "index.html",
    );
    expect(result).toEqual({
      comments: [
        {
          id: "c-1",
          projectId: "p-1",
          file: "index.html",
          body: "标题太浅",
          status: "open",
          anchor: {
            path: "body > h1",
            rect: { x: 20, y: 40, w: 200, h: 40 },
            excerpt: "登录",
          },
          createdAt: 1792477257537,
          updatedAt: 1792477257600,
        },
      ],
      annotations: [
        {
          id: "a-1",
          projectId: "p-1",
          file: "index.html",
          kind: "pen",
          color: "#ef4444",
          strokeWidth: 3,
          points: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
          createdAt: 1792477257537,
          updatedAt: 1792477257600,
        },
      ],
    });
  });

  it("写路径一律带调用者的 instanceId，不吃参数里的实例", async () => {
    const { service: repository, spies } = fakeRepository();
    const service = createDesignReviewService({ repository });
    await service.addComment(actor, {
      projectId: "p-1",
      file: "index.html",
      body: "标题太浅",
      anchor: {
        path: "body > h1",
        rect: { x: 20, y: 40, w: 200, h: 40 },
        excerpt: "登录",
      },
    });
    expect(spies.insertComment.mock.calls[0]?.[0]).toBe(actor.instanceId);
    await service.deleteComment({ ...actor, instanceId: otherInstance }, "c-1");
    expect(spies.deleteComment.mock.calls[0]?.[0]).toBe(otherInstance);
  });

  it("未知状态与未知 kind 落到可读的默认档，数值列从 numeric 字符串转出来", async () => {
    const { service: repository } = fakeRepository({
      listComments: vi.fn(async () => [
        { ...commentRow, status: "archived" },
      ] as DesignReviewCommentRow[]),
      listAnnotations: vi.fn(async () => [
        { ...annotationRow, kind: "arrow", stroke_width: 4.5 },
      ] as DesignReviewAnnotationRow[]),
    });
    const service = createDesignReviewService({ repository });
    const result = await service.list(actor, {
      projectId: "p-1",
      file: "index.html",
    });
    expect(result.comments[0]?.status).toBe("open");
    expect(result.annotations[0]?.kind).toBe("pen");
    expect(result.annotations[0]?.strokeWidth).toBe(4.5);
  });

  it("锚点矩形形状不对时立即失败，不把残缺对象透给面板", async () => {
    const { service: repository } = fakeRepository({
      listComments: vi.fn(async () => [
        { ...commentRow, anchor_rect: "not-a-rect" },
      ] as DesignReviewCommentRow[]),
    });
    const service = createDesignReviewService({ repository });
    await expect(
      service.list(actor, { projectId: "p-1", file: "index.html" }),
    ).rejects.toThrow();
  });

  it("update/delete 打不到行时返回 null/false，路由据此出 404", async () => {
    const { service: repository } = fakeRepository({
      updateComment: vi.fn(async () => null),
      deleteComment: vi.fn(async () => 0),
      deleteAnnotation: vi.fn(async () => 0),
    });
    const service = createDesignReviewService({ repository });
    await expect(
      service.updateComment(actor, "gone", { status: "resolved" }),
    ).resolves.toBeNull();
    await expect(service.deleteComment(actor, "gone")).resolves.toBe(false);
    await expect(service.deleteAnnotation(actor, "gone")).resolves.toBe(false);
  });
});
