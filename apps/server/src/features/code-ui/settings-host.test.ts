import { randomUUID } from "node:crypto";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

async function fixture() {
  const instanceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const actor = { instanceId: instanceId, accessClientId: null };
  const rootA = "/owned/fixed-task-A";
  const rootB = "/owned/new-default-B";
  const project = {
    id: projectId,
    kind: "code",
    name: "任务所有者",
    workDir: rootA,
    additionalDirectories: [],
  };
  const projects = [project];
  const task = {
    id: taskId,
    instance_id: instanceId,
    project_id: projectId,
    root_session_id: taskId,
    parent_session_id: null,
    root_directory: rootA,
    state: { snapshots: [] },
    archived: false,
    deleted_at: null,
    execution_state: "ready",
  };
  let preferences: Record<string, unknown> = {};
  const updates = vi.fn(
    async (_instanceId: string, patch: Record<string, unknown>) => {
      preferences = { ...preferences, ...patch };
      return true;
    },
  );
  const initialize = vi.fn(async () => []);
  const recoverRuntimeInputs = vi.fn(async () => {});
  const openTask = vi.fn(async () => {
    throw new Error("设置读取不能签发Task权限。");
  });
  const service = new CodeUiService({
    repository: {
      preparations: { recover: async () => {} },
      recoverRuntimeInputs,
      readHumanPreferences: async () => preferences,
      updateHumanPreferences: updates,
      find: async (workspace: string, id: string) =>
        workspace === instanceId && id === taskId ? task : null,
    },
    localInstance: createCodeUiTestInstance(instanceId).localInstance,
    projects: { listProjects: async () => projects },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "fixture-model" }),
    },
    modelProviders: {
      listInstances: async () => [],
      listProviderPresets: () => [],
    },
    modelCatalog: { listCatalog: async () => [] },
    taskWork: { initialize },
    executionScopes: { openTask },
    env: {},
  } as unknown as CodeUiServiceDeps);
  const connection = await service.openConnection(
    actor,
    async () => {},
    () => {},
  );
  const call = (method: string, patch?: unknown) =>
    service.hostRpc(
      actor,
      "setting",
      method,
      patch === undefined ? [] : [patch],
      connection.hello.connectionId,
    );
  return {
    service,
    actor,
    connection,
    call,
    projects,
    project,
    projectId,
    otherProjectId,
    rootA,
    rootB,
    task,
    taskId,
    updates,
    initialize,
    recoverRuntimeInputs,
    openTask,
    readStored: () => preferences,
    overwriteStored: (saved: Record<string, unknown>) => {
      preferences = structuredClone(saved);
    },
  };
}

function recentPaths(f: Awaited<ReturnType<typeof fixture>>) {
  // 11 条是原 UI 前10项展示行为的边界夹具，不是运行时限额。
  for (let index = 1; index <= 10; index += 1) {
    f.projects.push({
      id: randomUUID(),
      kind: "code",
      name: `最近项目${index}`,
      workDir: `/owned/recent-${index}`,
      additionalDirectories: [],
    });
  }
  return f.projects.map((project) => project.workDir).reverse();
}

it("公开setting读取旧recent去重保序前10项，过滤失效目录但不改原保存态或签权限", async () => {
  const f = await fixture();
  try {
    const paths = recentPaths(f);
    f.overwriteStored({
      recentProjects: ["/foreign-directory", paths[0], ...paths],
    });
    const before = structuredClone(f.readStored());
    expect(await f.call("get")).toMatchObject({
      result: { recentProjects: paths.slice(0, 10) },
    });
    expect(f.readStored()).toEqual(before);
    expect(f.updates).not.toHaveBeenCalled();
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.recoverRuntimeInputs).toHaveBeenCalledTimes(1);
    expect(f.openTask).not.toHaveBeenCalled();
  } finally {
    await f.connection.dispose();
    await f.service.closeConnections();
  }
});

it("公开setting保存recent去重保序前10项，关闭保持空，非法尾项不能被截断隐藏", async () => {
  const f = await fixture();
  try {
    const paths = recentPaths(f);
    await f.call("update", { recentProjects: [paths[0], ...paths] });
    expect(f.readStored().recentProjects).toEqual(paths.slice(0, 10));
    expect(await f.call("get")).toMatchObject({
      result: { recentProjects: paths.slice(0, 10) },
    });
    const before = structuredClone(f.readStored());
    await expect(
      f.call("update", {
        locale: "en-US",
        recentProjects: [...paths, "/foreign-tail-beyond-display"],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.readStored()).toEqual(before);
    await f.call("update", { recentProjects: [paths[8], paths[0], paths[8]] });
    expect(await f.call("get")).toMatchObject({
      result: { recentProjects: [paths[8], paths[0]] },
    });
    await f.call("update", { recentProjects: [] });
    expect(f.readStored().recentProjects).toEqual([]);
    expect(await f.call("get")).toMatchObject({
      result: { recentProjects: [] },
    });
    expect(f.updates).toHaveBeenCalledTimes(3);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.recoverRuntimeInputs).toHaveBeenCalledTimes(1);
    expect(f.openTask).not.toHaveBeenCalled();
  } finally {
    await f.connection.dispose();
    await f.service.closeConnections();
  }
});

it("公开setting宿主稀疏保存语言和显示偏好，空recent真实保留，非法混合patch不部分保存", async () => {
  const f = await fixture();
  try {
    await f.call("update", { locale: "en-US", messageStreamShowTodos: true });
    await f.call("update", {
      messageStreamShowReasoning: false,
      recentProjects: [],
    });
    expect(await f.call("get")).toMatchObject({
      result: {
        locale: "en-US",
        messageStreamShowTodos: true,
        messageStreamShowReasoning: false,
        recentProjects: [],
      },
    });
    const before = structuredClone(f.readStored());
    for (const patch of [
      { locale: "invalid", messageStreamShowTodos: false },
      { locale: "zh-CN", apiKey: "private-key" },
      { locale: "zh-CN", httpProxy: "http://unsupported" },
    ])
      await expect(f.call("update", patch)).rejects.toThrow();
    expect(f.readStored()).toEqual(before);
    expect(f.updates).toHaveBeenCalledTimes(2);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.recoverRuntimeInputs).toHaveBeenCalledTimes(1);
    expect(f.openTask).not.toHaveBeenCalled();
  } finally {
    await f.connection.dispose();
    await f.service.closeConnections();
  }
});

it("Task固定A与Project默认B的tab归属精准，Task关闭不能借同路径另一Project复活焦点", async () => {
  const f = await fixture();
  const identity = JSON.stringify([f.projectId, f.rootA]);
  try {
    await f.call("update", {
      recentProjects: [f.rootA],
      lastWorkspaceSession: [{ kind: "local", workspacePath: f.rootA }],
      lastActiveTaskByWorkspace: { [f.rootA]: f.taskId },
    });
    f.project.workDir = f.rootB;
    expect(await f.call("get")).toMatchObject({
      result: {
        recentProjects: [f.rootA],
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: f.rootA,
            workspaceIdentity: identity,
          },
        ],
        lastActiveTaskByWorkspace: { [identity]: f.taskId },
      },
    });
    const restored = await f.call("get");
    if (!restored) throw new Error("设置RPC没有返回结果。");
    expect(
      (
        restored.result as {
          lastActiveTaskByWorkspace: Record<string, string>;
        }
      ).lastActiveTaskByWorkspace,
    ).toEqual({ [identity]: f.taskId });
    f.projects.push({
      id: f.otherProjectId,
      kind: "code",
      name: "同路径的另一项目",
      workDir: f.rootA,
      additionalDirectories: [],
    });
    f.task.archived = true;
    expect(await f.call("get")).toMatchObject({
      result: {
        recentProjects: [],
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
        lastActiveTaskByWorkspace: {},
      },
    });
    const before = structuredClone(f.readStored());
    await expect(
      f.call("update", {
        locale: "en-US",
        lastWorkspaceSession: [{ kind: "local", workspacePath: f.rootA }],
        lastActiveTaskByWorkspace: { [f.rootA]: f.taskId },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.readStored()).toEqual(before);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.recoverRuntimeInputs).toHaveBeenCalledTimes(1);
    expect(f.openTask).not.toHaveBeenCalled();
  } finally {
    await f.connection.dispose();
    await f.service.closeConnections();
  }
});
