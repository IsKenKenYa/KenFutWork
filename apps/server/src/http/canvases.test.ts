import { canvasContentSchema } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type CanvasService,
  CanvasServiceError,
} from "../features/canvas/canvas-service.js";
import { CanvasFileStoreError } from "../features/canvas/file-store.js";
import { ProjectFileError } from "../features/project-files/types.js";
import { registerCanvasRoutes } from "./canvases.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: "client",
};
const revision = "a".repeat(64);
const nextRevision = "b".repeat(64);
const content = canvasContentSchema.parse({
  elements: [{ id: "shape", type: "rectangle" }],
});

async function fixture(
  options: {
    authenticated?: boolean;
    saveError?: Error;
    readError?: Error;
  } = {},
) {
  const save = vi.fn<CanvasService["saveCanvasContent"]>(async () => {
    if (options.saveError) throw options.saveError;
    return {
      revision: nextRevision,
      fileReferences: { image: "oss://project-assets/image.png" },
    };
  });
  const service: CanvasService = {
    readCanvasContent: async () => content,
    getCanvas: async () => {
      if (options.readError) throw options.readError;
      return {
        id: "canvas",
        projectId: "project",
        name: "画布",
        content,
        revision,
      };
    },
    saveCanvasContent: save,
    insertImageElement: async () => ({ elementId: "image" }),
    insertVideoElement: async () => ({ elementId: "video" }),
  };
  const app = Fastify();
  await registerCanvasRoutes(app, {
    canvasService: service,
    localAccess: {
      authenticate: async () =>
        options.authenticated === false ? null : actor,
    },
  });
  return { app, save };
}

describe("画布文件版本的HTTP边界", () => {
  it("素材缺失和素材冲突保留恢复指引与拒绝状态", async () => {
    const missing = await fixture({
      readError: new ProjectFileError(
        "file_missing",
        "素材缺失，请重新关联文件。",
      ),
    });
    const conflict = await fixture({
      saveError: new ProjectFileError(
        "file_conflict",
        "素材已在外部修改，请重新加载。",
      ),
    });
    try {
      const read = await missing.app.inject({
        method: "GET",
        url: "/api/canvases/canvas",
      });
      expect(read.statusCode).toBe(409);
      expect(read.json()).toEqual({
        error: {
          code: "canvas_file_missing",
          message: "素材缺失，请重新关联文件。",
        },
      });
      const write = await conflict.app.inject({
        method: "PUT",
        url: "/api/canvases/canvas",
        payload: { content, expectedRevision: revision },
      });
      expect(write.statusCode).toBe(409);
      expect(write.json()).toEqual({
        error: {
          code: "canvas_revision_conflict",
          message: "素材已在外部修改，请重新加载。",
        },
      });
    } finally {
      await missing.app.close();
      await conflict.app.close();
    }
  });
  it("读取返回权威文件版本，保存将期望版本传入服务并返回引用回执", async () => {
    const { app, save } = await fixture();
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/canvases/canvas",
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().canvas.revision).toBe(revision);
      const result = await app.inject({
        method: "PUT",
        url: "/api/canvases/canvas",
        payload: { content, expectedRevision: revision },
      });
      expect(result.statusCode).toBe(200);
      expect(save).toHaveBeenCalledExactlyOnceWith(
        actor,
        "canvas",
        content,
        revision,
      );
      expect(result.json()).toEqual({
        ok: true,
        revision: nextRevision,
        fileReferences: { image: "oss://project-assets/image.png" },
      });
    } finally {
      await app.close();
    }
  });

  it.each([undefined, "old", 42])(
    "缺失或非法版本 %s 不能进入写入服务",
    async (expectedRevision) => {
      const { app, save } = await fixture();
      try {
        const result = await app.inject({
          method: "PUT",
          url: "/api/canvases/canvas",
          payload: { content, expectedRevision },
        });
        expect(result.statusCode).toBe(400);
        expect(save).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("文件冲突保留409与可读错误，而非被错误契约转换成500", async () => {
    const { app } = await fixture({
      saveError: new CanvasFileStoreError(
        "revision_conflict",
        "画布已改变，请重新加载。",
      ),
    });
    try {
      const result = await app.inject({
        method: "PUT",
        url: "/api/canvases/canvas",
        payload: { content, expectedRevision: revision },
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual({
        error: {
          code: "canvas_revision_conflict",
          message: "画布已改变，请重新加载。",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("已索引文件缺失保持明确失败，未获授权的保存不调用服务", async () => {
    const missing = await fixture({
      readError: new CanvasServiceError(
        "canvas_file_missing",
        "画布文件缺失，请恢复项目文件。",
        409,
      ),
    });
    const denied = await fixture({ authenticated: false });
    try {
      const read = await missing.app.inject({
        method: "GET",
        url: "/api/canvases/canvas",
      });
      expect(read.statusCode).toBe(409);
      expect(read.json().error.code).toBe("canvas_file_missing");
      const write = await denied.app.inject({
        method: "PUT",
        url: "/api/canvases/canvas",
        payload: { content, expectedRevision: revision },
      });
      expect(write.statusCode).toBe(401);
      expect(denied.save).not.toHaveBeenCalled();
    } finally {
      await missing.app.close();
      await denied.app.close();
    }
  });
});
