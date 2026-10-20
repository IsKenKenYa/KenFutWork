import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DesignReviewService } from "../features/design-review/design-review-service.js";
import type { LocalActor } from "../features/local-instance/types.js";
import { registerDesignReviewRoutes } from "./design-review.js";

/**
 * 设计评审路由：鉴权门 + 入参收口 + 404 语义。
 * 业务映射在服务单测里钉，这里只管 HTTP 形状。
 */

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};

const comment = {
  id: "c-1",
  projectId: "p-1",
  file: "index.html",
  body: "标题太浅",
  status: "open" as const,
  anchor: {
    path: "body > h1",
    rect: { x: 20, y: 40, w: 200, h: 40 },
    excerpt: "登录",
  },
  createdAt: 1792477257537,
  updatedAt: 1792477257537,
};

function fixture(
  options: {
    authorized?: boolean;
    service?: Partial<DesignReviewService>;
  } = {},
) {
  const service: DesignReviewService = {
    list: vi.fn(async () => ({ comments: [comment], annotations: [] })),
    addComment: vi.fn(async () => comment),
    updateComment: vi.fn(async () => comment),
    deleteComment: vi.fn(async () => true),
    addAnnotation: vi.fn(async () => ({
      id: "a-1",
      projectId: "p-1",
      file: "index.html",
      kind: "pen" as const,
      color: "#ef4444",
      strokeWidth: 3,
      points: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      createdAt: 1792477257537,
      updatedAt: 1792477257537,
    })),
    deleteAnnotation: vi.fn(async () => true),
    ...(options.service ?? {}),
  } as DesignReviewService;
  const app = Fastify();
  void registerDesignReviewRoutes(app, {
    localAccess: {
      authenticate: async () => (options.authorized === false ? null : actor),
    } as never,
    designReviewService: service,
  });
  return { app, service };
}

describe("/api/design-review", () => {
  it("未授权一律 401，不碰服务", async () => {
    const { app, service } = fixture({ authorized: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/design-review?projectId=p-1&file=index.html",
    });
    expect(response.statusCode).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("读取按 projectId+file 作用域；缺任一参数 400", async () => {
    const { app, service } = fixture();
    const ok = await app.inject({
      method: "GET",
      url: "/api/design-review?projectId=p-1&file=index.html",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().comments[0]?.anchor.path).toBe("body > h1");
    expect(service.list).toHaveBeenCalledWith(actor, {
      projectId: "p-1",
      file: "index.html",
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/design-review?projectId=p-1",
    });
    expect(missing.statusCode).toBe(400);
  });

  it("建评论校验锚点形状；正文空或锚点缺路径都 400", async () => {
    const { app } = fixture();
    const noBody = await app.inject({
      method: "POST",
      url: "/api/design-review/comments",
      payload: {
        projectId: "p-1",
        file: "index.html",
        body: "  ",
        anchor: { path: "body > h1", rect: { x: 0, y: 0, w: 1, h: 1 }, excerpt: "" },
      },
    });
    expect(noBody.statusCode).toBe(400);

    const badAnchor = await app.inject({
      method: "POST",
      url: "/api/design-review/comments",
      payload: {
        projectId: "p-1",
        file: "index.html",
        body: "这里",
        anchor: { rect: { x: 0, y: 0, w: 1, h: 1 }, excerpt: "" },
      },
    });
    expect(badAnchor.statusCode).toBe(400);
  });

  it("改/删打不到行时出 404，而不是假装成功", async () => {
    const { app } = fixture({
      service: {
        updateComment: vi.fn(async () => null),
        deleteComment: vi.fn(async () => false),
        deleteAnnotation: vi.fn(async () => false),
      } as Partial<DesignReviewService>,
    });
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/design-review/comments/gone",
      payload: { status: "resolved" },
    });
    expect(patch.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/design-review/comments/gone",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/design-review/annotations/gone",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("标注按归一化点集入库；点数不足 400", async () => {
    const { app, service } = fixture();
    const ok = await app.inject({
      method: "POST",
      url: "/api/design-review/annotations",
      payload: {
        projectId: "p-1",
        file: "index.html",
        kind: "rect",
        color: "#111111",
        strokeWidth: 2,
        points: [
          [0.1, 0.1],
          [0.5, 0.6],
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(service.addAnnotation).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ kind: "rect", strokeWidth: 2 }),
    );

    const tooShort = await app.inject({
      method: "POST",
      url: "/api/design-review/annotations",
      payload: {
        projectId: "p-1",
        file: "index.html",
        kind: "pen",
        color: "#111111",
        strokeWidth: 2,
        points: [[0.1, 0.1]],
      },
    });
    expect(tooShort.statusCode).toBe(400);
  });
});
