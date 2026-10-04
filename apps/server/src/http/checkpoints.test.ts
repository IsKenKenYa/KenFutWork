import type { CodeExecutionScope } from "@kenfutwork/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestAuthenticator } from "../features/auth/types.js";
import {
  type CheckpointService,
  CodeCheckpointError,
} from "../features/checkpoints/checkpoint-service.js";
import type { CheckpointRow } from "../features/checkpoints/repository.js";
import type { ExecutionScopeHandle } from "../features/execution/scope-service.js";
import { registerCheckpointsRoutes } from "./checkpoints.js";

const actor = {
  id: "actor",
  email: "dev@example.test",
  accessToken: "private",
  userMetadata: {},
};
const identity: CodeExecutionScope = {
  workspaceId: "workspace",
  projectId: "project",
  taskId: "task",
  generation: 1,
  rootDirectory: "/work",
  additionalDirectories: [],
  sandboxMode: "workspace-write",
};
const scope = { describe: () => identity } as ExecutionScopeHandle;
const row: CheckpointRow = {
  id: "checkpoint",
  ...identity,
  directorySnapshots: [
    { rootDirectory: "/work", shadowCommit: "a".repeat(40) },
  ],
  runId: null,
  kind: "turn",
  label: "开始",
  shadowCommit: "a".repeat(40),
  filesChanged: 1,
  insertions: 1,
  deletions: 0,
  createdAt: "2026-10-02T00:00:00Z",
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function appWith(
  options: {
    unauthorized?: boolean;
    service?: Partial<CheckpointService>;
  } = {},
) {
  const app = Fastify();
  apps.push(app);
  const service: CheckpointService = {
    captureTurnBoundary: vi.fn(async (input) => ({
      phase: input.phase,
      created: null,
      effective: null,
    })),
    forgetTask: vi.fn(),
    beforeTurn: vi.fn(async () => null),
    afterTurn: vi.fn(async () => null),
    list: vi.fn(async () => [row]),
    diffFor: vi.fn(async () => ({
      text: "diff",
      files: [{ rootDirectory: "/work", path: "a.txt", added: 1, deleted: 0 }],
    })),
    turnFiles: vi.fn(async () => ({ files: [] })),
    readFileSnapshot: vi.fn(async () => ({ bytes: null })),
    previewRestore: vi.fn(async () => ({
      targetSha: row.shadowCommit,
      expectedVersion: "preview-token",
      files: [],
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    })),
    restore: vi.fn(async () => row),
    restoreFile: vi.fn(async () => row),
    ...options.service,
  };
  const openTask = vi.fn(async () => scope);
  await registerCheckpointsRoutes(app, {
    auth: {
      authenticate: async () => (options.unauthorized ? null : actor),
    } as RequestAuthenticator,
    executionScopes: { openTask },
    checkpointsService: service,
  });
  return { app, service, openTask };
}
describe("Task checkpoint HTTP", () => {
  it("鉴权与Task入参先于scope和checkpoint消费者", async () => {
    const missing = await appWith();
    const denied = await appWith({ unauthorized: true });
    expect(
      (
        await missing.app.inject({
          method: "GET",
          url: "/api/code/checkpoints?canvasId=old",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: "/api/code/checkpoints?taskId=task",
        })
      ).statusCode,
    ).toBe(401);
    expect(missing.openTask).not.toHaveBeenCalled();
    expect(denied.openTask).not.toHaveBeenCalled();
  });
  it("列表返回真实Task/project身份，不外发内部DTO或凭据", async () => {
    const { app, service, openTask } = await appWith();
    const response = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints?taskId=task",
    });
    expect(response.statusCode).toBe(200);
    expect(openTask).toHaveBeenCalledWith(actor, "task");
    expect(service.list).toHaveBeenCalledWith({ actor, scope });
    expect(response.json().checkpoints[0]).toMatchObject({
      id: "checkpoint",
      taskId: "task",
      projectId: "project",
    });
    expect(response.json().checkpoints[0]).not.toHaveProperty("workspaceId");
    expect(response.json().checkpoints[0]).not.toHaveProperty("accessToken");
  });
  it("diff/files/preview都先打开同Task；preview透传文件范围和版本", async () => {
    const { app, service } = await appWith();
    const diff = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints/checkpoint/diff?taskId=task&path=a.txt",
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().files[0].rootDirectory).toBe("/work");
    const preview = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/checkpoint/preview?taskId=task&path=a.txt",
    });
    expect(preview.json().expectedVersion).toBe("preview-token");
    expect(service.previewRestore).toHaveBeenCalledWith({
      actor,
      scope,
      checkpointId: "checkpoint",
      path: "a.txt",
    });
  });
  it("未提供观察版本不执行恢复；版本/路径真实传入消费者", async () => {
    const { app, service } = await appWith();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/code/checkpoints/checkpoint/restore?taskId=task",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(service.restore).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/checkpoint/restore-file?taskId=task",
      payload: { path: "a.txt", expectedVersion: "preview-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.restoreFile).toHaveBeenCalledWith({
      actor,
      scope,
      checkpointId: "checkpoint",
      path: "a.txt",
      expectedVersion: "preview-token",
    });
  });
  it("409预览冲突与404归属拒绝保持明确语义", async () => {
    const { app } = await appWith({
      service: {
        restore: async () => {
          throw new CodeCheckpointError("checkpoint_failed", "文件已变化", 409);
        },
        diffFor: async () => {
          throw new CodeCheckpointError("not_found", "其他Task", 404);
        },
      },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/code/checkpoints/checkpoint/restore?taskId=task",
      payload: { expectedVersion: "stale" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toBe("文件已变化");
    const denied = await app.inject({
      method: "GET",
      url: "/api/code/checkpoints/checkpoint/diff?taskId=task",
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe("checkpoint_not_found");
  });
});
