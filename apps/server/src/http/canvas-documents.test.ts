import type { CanvasDetail } from "@kenfutwork/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CanvasService,
  CanvasServiceError,
} from "../features/canvas/canvas-service.js";
import { CanvasFileStoreError } from "../features/canvas/file-store.js";
import { createConsumerLocalAccessService } from "../features/local-access/test-consumer-service.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import { registerCanvasRoutes } from "./canvases.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: "canvas-document-client",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const canvasId = "33333333-3333-4333-8333-333333333333";
const secondaryCanvasId = "44444444-4444-4444-8444-444444444444";
const revision = "a".repeat(64);
const canvas: CanvasDetail = {
  id: canvasId,
  projectId,
  name: "海报",
  content: { elements: [{ id: "rectangle" }], appState: {}, files: {} },
  revision,
};
const listUrl = `/api/projects/${projectId}/canvases`;
const documentUrl = `/api/canvases/${canvasId}`;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(
  options: { authenticated?: boolean; error?: Error } = {},
) {
  const result = <T>(value: T): T => {
    if (options.error) throw options.error;
    return value;
  };
  const listCanvases = vi.fn<CanvasService["listCanvases"]>(async () =>
    result([
      { id: canvasId, name: canvas.name, isPrimary: true },
      { id: secondaryCanvasId, name: "副画布", isPrimary: false },
    ]),
  );
  const createCanvas = vi.fn<CanvasService["createCanvas"]>(
    async (_actor, _project, input) => result({ ...canvas, name: input.name }),
  );
  const renameCanvas = vi.fn<CanvasService["renameCanvas"]>(
    async (_actor, _canvas, input) => result({ ...canvas, name: input.name }),
  );
  const deleteCanvas = vi.fn<CanvasService["deleteCanvas"]>(async () =>
    result(undefined),
  );
  const unused = async (): Promise<never> => {
    throw new Error("文档路由不应调用其他画布操作");
  };
  const app = Fastify();
  apps.push(app);
  await registerCanvasRoutes(app, {
    localAccess: createConsumerLocalAccessService(async () =>
      options.authenticated === false ? null : actor,
    ),
    canvasService: {
      listCanvases,
      createCanvas,
      renameCanvas,
      deleteCanvas,
      getCanvas: unused,
      readCanvasContent: unused,
      saveCanvasContent: unused,
      insertImageElement: unused,
      insertVideoElement: unused,
    },
  });
  return { app, listCanvases, createCanvas, renameCanvas, deleteCanvas };
}

const requests = [
  { method: "GET", url: listUrl },
  {
    method: "POST",
    url: listUrl,
    payload: { name: "海报", requestId: canvasId },
  },
  {
    method: "PATCH",
    url: documentUrl,
    payload: {
      name: "新名",
      expectedName: "海报",
      expectedRevision: revision,
    },
  },
  {
    method: "DELETE",
    url: documentUrl,
    payload: { expectedRevision: revision },
  },
] as const;

type Fixture = Awaited<ReturnType<typeof fixture>>;
function expectNoDocumentOperation(f: Fixture) {
  expect(f.listCanvases).not.toHaveBeenCalled();
  expect(f.createCanvas).not.toHaveBeenCalled();
  expect(f.renameCanvas).not.toHaveBeenCalled();
  expect(f.deleteCanvas).not.toHaveBeenCalled();
}

describe("项目画布文档的HTTP边界", () => {
  it("列表保留真实文档顺序和主文档标记，名称查询按字面传入", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "GET",
      url: `${listUrl}?query=${encodeURIComponent("  海报100%  ")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      canvases: [
        { id: canvasId, name: "海报", isPrimary: true },
        { id: secondaryCanvasId, name: "副画布", isPrimary: false },
      ],
    });
    expect(f.listCanvases).toHaveBeenCalledExactlyOnceWith(
      actor,
      projectId,
      "海报100%",
    );
    expect(f.createCanvas).not.toHaveBeenCalled();
  });

  it("创建返回服务持有的文档和版本，保留请求身份且不接纳伪造归属", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "POST",
      url: listUrl,
      payload: {
        name: "  新海报  ",
        requestId: canvasId,
        projectId: "foreign-project",
        taskId: "foreign-task",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ canvas: { ...canvas, name: "新海报" } });
    expect(f.createCanvas).toHaveBeenCalledExactlyOnceWith(actor, projectId, {
      name: "新海报",
      requestId: canvasId,
    });
    expect(f.renameCanvas).not.toHaveBeenCalled();
  });

  it("改名传递原名称和确切版本，响应保留内容与文档身份", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "PATCH",
      url: documentUrl,
      payload: {
        name: "  改名海报  ",
        expectedName: "海报",
        expectedRevision: revision,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      canvas: { ...canvas, name: "改名海报" },
    });
    expect(f.renameCanvas).toHaveBeenCalledExactlyOnceWith(actor, canvasId, {
      name: "改名海报",
      expectedName: "海报",
      expectedRevision: revision,
    });
    expect(f.deleteCanvas).not.toHaveBeenCalled();
  });

  it("删除使用服务端Actor、路径文档与确切版本，成功只返回回执", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "DELETE",
      url: documentUrl,
      payload: { expectedRevision: revision, canvasId: "foreign-canvas" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(f.deleteCanvas).toHaveBeenCalledExactlyOnceWith(
      actor,
      canvasId,
      revision,
    );
    expect(f.createCanvas).not.toHaveBeenCalled();
  });

  it.each(requests)(
    "$method 未鉴权时拒绝请求且不触发文档操作",
    async (request) => {
      const f = await fixture({ authenticated: false });
      const response = await f.app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: "unauthorized",
          message: "缺少或无效的本机接入凭据。",
        },
      });
      expectNoDocumentOperation(f);
    },
  );

  const invalidRequests = [
    {
      method: "GET",
      url: `${listUrl}?query=${"x".repeat(201)}`,
      field: "query",
    },
    { method: "POST", url: listUrl, payload: { name: "  " }, field: "name" },
    {
      method: "POST",
      url: listUrl,
      payload: { name: "x".repeat(201) },
      field: "name",
    },
    {
      method: "POST",
      url: listUrl,
      payload: { name: "海报", requestId: "invalid" },
      field: "requestId",
    },
    {
      method: "PATCH",
      url: documentUrl,
      payload: { name: "  ", expectedName: "海报", expectedRevision: revision },
      field: "name",
    },
    {
      method: "PATCH",
      url: documentUrl,
      payload: { name: "新名", expectedRevision: revision },
      field: "expectedName",
    },
    {
      method: "PATCH",
      url: documentUrl,
      payload: { name: "新名", expectedName: "海报", expectedRevision: "old" },
      field: "expectedRevision",
    },
    {
      method: "DELETE",
      url: documentUrl,
      payload: {},
      field: "expectedRevision",
    },
    {
      method: "DELETE",
      url: documentUrl,
      payload: { expectedRevision: "g".repeat(64) },
      field: "expectedRevision",
    },
  ] as const;

  it.each(invalidRequests)(
    "$method 拒绝无效 $field，不进入文档服务",
    async (request) => {
      const f = await fixture();
      const { field, ...input } = request;
      const response = await f.app.inject(input);
      expect(response.statusCode).toBe(400);
      expect(response.json().issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: [field] })]),
      );
      expectNoDocumentOperation(f);
    },
  );

  describe.each([
    {
      status: 404,
      error: new CanvasServiceError("canvas_not_found", "画布已删除。", 404),
      code: "canvas_not_found",
    },
    {
      status: 409,
      error: new CanvasFileStoreError("revision_conflict", "画布已改变。"),
      code: "canvas_revision_conflict",
    },
    {
      status: 403,
      error: new CanvasServiceError(
        "canvas_save_failed",
        "请先启用Design。",
        403,
      ),
      code: "canvas_save_failed",
    },
  ])("文档服务拒绝 $status", ({ status, error, code }) => {
    it.each(requests)(
      "$method 保留状态、错误码与原因，不返回成功回执",
      async (request) => {
        const f = await fixture({ error });
        const response = await f.app.inject(request);
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({
          error: { code, message: error.message },
        });
      },
    );
  });

  it("列表保留项目不存在的404，不退化成内部错误", async () => {
    const f = await fixture({
      error: new ProjectServiceError("project_not_found", "项目不存在。", 404),
    });
    const response = await f.app.inject({ method: "GET", url: listUrl });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "project_not_found", message: "项目不存在。" },
    });
  });
});
