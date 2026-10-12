import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import type {
  DesignTaskPolicy,
  DesignTasksService,
} from "../features/execution/design-task-types.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import { registerDesignTaskRoutes } from "./design-tasks.js";

const actor: LocalActor = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  accessClientId: "00000000-0000-4000-8000-000000000002",
};
const taskId = "00000000-0000-4000-8000-000000000003";
const task: DesignTaskPolicy = {
  taskId,
  projectId: "00000000-0000-4000-8000-000000000004",
  canvasId: "00000000-0000-4000-8000-000000000005",
  rootDirectory: "/workspace",
  additionalDirectories: [],
  sandboxMode: "workspace-write",
  scopeGeneration: 2,
  branchGeneration: 3,
  mode: "build",
  planEnabled: false,
  planningEpoch: 0,
  activeRunId: null,
  executionState: "ready",
};

async function appFor(options: {
  actor?: LocalActor | null;
  provision?: (actor: LocalActor, taskId: string) => Promise<DesignTaskPolicy>;
  readPolicy?: (actor: LocalActor, taskId: string) => Promise<DesignTaskPolicy>;
  updatePolicy?: DesignTasksService["updatePolicy"];
}) {
  const app = Fastify();
  const localAccess = {
    authenticate: vi.fn(async () =>
      Object.hasOwn(options, "actor") ? (options.actor ?? null) : actor,
    ),
  } as unknown as LocalAccessVerifier;
  const designTasks = {
    provision: options.provision ?? vi.fn(async () => task),
    readPolicy: options.readPolicy ?? vi.fn(async () => task),
    updatePolicy: options.updatePolicy ?? vi.fn(async () => task),
  };
  await registerDesignTaskRoutes(app, { localAccess, designTasks });
  return { app, localAccess, designTasks };
}

it("requires a real local actor and a UUID Task ID", async () => {
  const unauthenticated = await appFor({ actor: null });
  const rejected = await unauthenticated.app.inject({
    method: "GET",
    url: `/api/design-tasks/${taskId}`,
  });
  expect(rejected.statusCode).toBe(401);
  expect(unauthenticated.designTasks.readPolicy).not.toHaveBeenCalled();
  await unauthenticated.app.close();

  const authenticated = await appFor({});
  const invalid = await authenticated.app.inject({
    method: "GET",
    url: "/api/design-tasks/not-a-uuid",
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({
    error: { code: "invalid_request" },
  });
  expect(authenticated.designTasks.readPolicy).not.toHaveBeenCalled();
  await authenticated.app.close();
});

it("explicitly provisions a legacy task and reads policy without provisioning", async () => {
  const provision = vi.fn(async () => task);
  const readPolicy = vi.fn(async () => task);
  const f = await appFor({ provision, readPolicy });
  try {
    const created = await f.app.inject({
      method: "POST",
      url: `/api/design-tasks/${taskId}/provision`,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ task });
    expect(provision).toHaveBeenCalledWith(actor, taskId);
    expect(readPolicy).not.toHaveBeenCalled();

    const read = await f.app.inject({
      method: "GET",
      url: `/api/design-tasks/${taskId}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ task });
    expect(readPolicy).toHaveBeenCalledWith(actor, taskId);
    expect(provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.app.close();
  }
});

it("returns a stable not-found response for a Task without provisioned metadata", async () => {
  const f = await appFor({
    readPolicy: async () => {
      throw new DesignTaskError(
        "design_task_unprovisioned",
        "任务尚未配置执行目录",
      );
    },
  });
  try {
    const response = await f.app.inject({
      method: "GET",
      url: `/api/design-tasks/${taskId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "session_not_found", message: "任务尚未配置执行目录" },
    });
  } finally {
    await f.app.close();
  }
});

it("policy mutation maps client generations to actual server planning CAS and rejects forged authority", async () => {
  const app = await appFor({});
  try {
    const good = await app.app.inject({
      method: "PATCH",
      url: `/api/design-tasks/${taskId}`,
      payload: {
        expectedScopeGeneration: 2,
        expectedBranchGeneration: 3,
        planEnabled: true,
      },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ task });
    expect(app.designTasks.updatePolicy).toHaveBeenCalledWith(actor, {
      taskId,
      scopeGeneration: 2,
      planningEpoch: 0,
      planEnabled: true,
    });
    const stale = await app.app.inject({
      method: "PATCH",
      url: `/api/design-tasks/${taskId}`,
      payload: {
        expectedScopeGeneration: 2,
        expectedBranchGeneration: 2,
        mode: "yolo",
      },
    });
    expect(stale.statusCode).toBe(409);
    const forged = await app.app.inject({
      method: "PATCH",
      url: `/api/design-tasks/${taskId}`,
      payload: {
        expectedScopeGeneration: 2,
        expectedBranchGeneration: 3,
        planEnabled: true,
        planningEpoch: 50,
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(app.designTasks.updatePolicy).toHaveBeenCalledTimes(1);
  } finally {
    await app.app.close();
  }
});

it("active Run or stale CAS from the real mutation Provider surfaces 409", async () => {
  const app = await appFor({
    updatePolicy: async () => {
      throw new DesignTaskError("design_task_busy", "请先停止当前任务");
    },
  });
  try {
    const result = await app.app.inject({
      method: "PATCH",
      url: `/api/design-tasks/${taskId}`,
      payload: {
        expectedScopeGeneration: 2,
        expectedBranchGeneration: 3,
        mode: "edit",
      },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.message).toBe("请先停止当前任务");
  } finally {
    await app.app.close();
  }
});
