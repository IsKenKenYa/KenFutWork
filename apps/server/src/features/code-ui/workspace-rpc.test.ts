import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeUiWorkspace,
  codeUiWorkspaceSchema,
  type ProjectCreateRequest,
  type ProjectSummary,
} from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { createHumanWorkspaceRpc } from "./workspace-rpc.js";

const actor: AuthenticatedUser = {
  id: randomUUID(),
  email: "human@example.test",
  accessToken: "private",
  userMetadata: {},
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function world() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-human-workspace-")),
  );
  temporary.push(root);
  const workspaces: CodeUiWorkspace[] = [];
  let preferences: Record<string, unknown> = {};
  const createProject = vi.fn(
    async (
      _actor: AuthenticatedUser,
      input: ProjectCreateRequest,
    ): Promise<ProjectSummary> => {
      const id = randomUUID();
      const path = input.work_dir ?? join(root, id);
      await mkdir(path, { recursive: true });
      workspaces.push({
        projectId: id,
        name: input.name,
        path,
        additionalDirectories: [],
      });
      return {
        id,
        kind: "code",
        name: input.name,
        slug: id,
        description: null,
        workDir: path,
        additionalDirectories: [],
        workspace: {
          id: randomUUID(),
          name: "人类工作区",
          type: "personal",
          ownerUserId: actor.id,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  );
  const preferencesApi = {
    readHumanPreferences: async () => preferences,
    updateHumanPreferences: vi.fn(
      async (_workspace: string, patch: Record<string, unknown>) => {
        preferences = { ...preferences, ...patch };
        return true;
      },
    ),
  };
  const createRpc = () =>
    createHumanWorkspaceRpc({
      projects: { createProject } as unknown as ProjectService,
      preferences: preferencesApi,
      workspaceId: async () => "workspace",
      listWorkspaces: async () => workspaces,
      maxEntries: async () => 5,
    });
  const rpc = createRpc();
  return { root, rpc, createRpc, createProject, preferencesApi, workspaces };
}
describe("Human-only Code workspace RPC", () => {
  it("原ensureConversationWorkspace并发和cold复用真实Code Project，返回可注册身份且不靠Canvas或Task", async () => {
    const { rpc, createRpc, createProject, preferencesApi, workspaces, root } =
      await world();
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: { recentProjects: [] },
    });
    expect(createProject).not.toHaveBeenCalled();
    const [first, concurrent] = await Promise.all([
      rpc.call(actor, "file", "ensureConversationWorkspace", []),
      rpc.call(actor, "file", "ensureConversationWorkspace", []),
    ]);
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({
      result: { created: true, workspacePurpose: "conversation" },
    });
    const project = codeUiWorkspaceSchema.parse(first?.result);
    expect(project).toEqual(workspaces[0]);
    expect(await realpath(project.path)).toBe(project.path);
    expect(first?.result).not.toHaveProperty("canvasId");
    expect(first?.result).not.toHaveProperty("taskId");
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith(actor, {
      kind: "code",
      name: "默认对话",
    });
    expect(await preferencesApi.readHumanPreferences()).toMatchObject({
      defaultConversationProjectId: project.projectId,
    });
    const cold = createRpc();
    expect(
      await cold.call(actor, "file", "ensureConversationWorkspace", []),
    ).toMatchObject({
      result: { ...project, created: false, workspacePurpose: "conversation" },
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    const nextRoot = join(root, "new-default");
    await mkdir(nextRoot);
    const owner = workspaces.find(
      (entry) => entry.projectId === project.projectId,
    );
    if (!owner) throw new Error("真实Project未登记。");
    owner.path = nextRoot;
    expect(
      await cold.call(actor, "file", "ensureConversationWorkspace", []),
    ).toMatchObject({
      result: { projectId: project.projectId, path: nextRoot, created: false },
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    for (const method of ["get", "update"] as const) {
      if (method === "get")
        expect(
          (await cold.call(actor, "setting", method, []))?.result,
        ).not.toHaveProperty("defaultConversationProjectId");
      else
        await expect(
          cold.call(actor, "setting", method, [
            { defaultConversationProjectId: randomUUID() },
          ]),
        ).rejects.toThrow("尚不支持");
    }
  });
  it("默认对话Project归档后旧引用失效，新建真实ID后cold只复用新Project", async () => {
    const { rpc, createRpc, createProject, preferencesApi, workspaces } =
      await world();
    const first = codeUiWorkspaceSchema.parse(
      (await rpc.call(actor, "file", "ensureConversationWorkspace", []))
        ?.result,
    );
    workspaces.splice(
      workspaces.findIndex((entry) => entry.projectId === first.projectId),
      1,
    );
    const cold = createRpc();
    const secondResult = await cold.call(
      actor,
      "file",
      "ensureConversationWorkspace",
      [],
    );
    const second = codeUiWorkspaceSchema.parse(secondResult?.result);
    expect(secondResult).toMatchObject({
      result: { created: true, workspacePurpose: "conversation" },
    });
    expect(second.projectId).not.toBe(first.projectId);
    expect(await realpath(second.path)).toBe(second.path);
    expect(await preferencesApi.readHumanPreferences()).toMatchObject({
      defaultConversationProjectId: second.projectId,
    });
    expect(
      await createRpc().call(actor, "file", "ensureConversationWorkspace", []),
    ).toMatchObject({ result: { ...second, created: false } });
    expect(createProject).toHaveBeenCalledTimes(2);
  });
  it("默认引用全量保存false不能返回伪成功，拒绝后同workspace单flight可显式重试", async () => {
    const { rpc, createProject, preferencesApi, workspaces } = await world();
    preferencesApi.updateHumanPreferences.mockImplementationOnce(async () => {
      // 模拟Project在引用写入的live guard前已被归档，未保存任何偏好叶子。
      workspaces.splice(0);
      return false;
    });
    await expect(
      rpc.call(actor, "file", "ensureConversationWorkspace", []),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await preferencesApi.readHumanPreferences()).not.toHaveProperty(
      "defaultConversationProjectId",
    );
    const created = await rpc.call(
      actor,
      "file",
      "ensureConversationWorkspace",
      [],
    );
    const project = codeUiWorkspaceSchema.parse(created?.result);
    expect(created).toMatchObject({
      result: { created: true, workspacePurpose: "conversation" },
    });
    expect(await preferencesApi.readHumanPreferences()).toMatchObject({
      defaultConversationProjectId: project.projectId,
    });
    expect(preferencesApi.updateHumanPreferences).toHaveBeenLastCalledWith(
      "workspace",
      { defaultConversationProjectId: project.projectId },
      { referencedProjectIds: [project.projectId] },
    );
    expect(createProject).toHaveBeenCalledTimes(2);
  });
  it("同一路径并发显式打开只创建一个无Canvas项目，刷新后复用身份", async () => {
    const { rpc, root, createProject } = await world();
    const [first, second] = await Promise.all([
      rpc.call(actor, "workspace", "open", [{ path: root }]),
      rpc.call(actor, "workspace", "open", [{ path: root }]),
    ]);
    expect(first).toEqual(second);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ kind: "code", work_dir: root }),
    );
    expect(
      (await rpc.call(actor, "workspace", "open", [{ path: root }]))?.result,
    ).toEqual(first?.result);
    expect(first?.result).not.toHaveProperty("canvasId");
  });
  it("目录选择仅返回目录元数据，普通readdir不会获得Human浏览authority", async () => {
    const { root, rpc } = await world();
    await mkdir(join(root, "folder"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "secret.txt"), "内容不应返回");
    const listed = await rpc.call(actor, "file", "readdir", [
      { path: root, humanPurpose: "directory-picker" },
    ]);
    expect(listed?.result).toEqual([
      { name: "folder", path: join(root, "folder"), type: "directory" },
    ]);
    expect(
      await rpc.call(actor, "file", "readdir", [{ path: root }]),
    ).toBeNull();
    const hidden = await rpc.call(actor, "file", "readdir", [
      { path: root, includeHidden: true, humanPurpose: "directory-picker" },
    ]);
    if (!hidden || !Array.isArray(hidden.result))
      throw new Error("目录选择器未返回真实目录列表");
    expect(
      (hidden.result as Array<{ name: string }>).map((entry) => entry.name),
    ).toContain(".hidden");
  });
  it("选择symlink目录按canonical项目身份，失效/文件路径不留假项目", async () => {
    const { root, rpc, createProject } = await world();
    const target = join(root, "target");
    await mkdir(target);
    const link = join(root, "alias");
    await symlink(target, link);
    expect(
      (await rpc.call(actor, "workspace", "open", [{ path: link }]))?.result,
    ).toMatchObject({ path: target });
    await writeFile(join(root, "file.txt"), "x");
    await expect(
      rpc.call(actor, "workspace", "open", [{ path: join(root, "file.txt") }]),
    ).rejects.toThrow("不是目录");
    expect(createProject).toHaveBeenCalledTimes(1);
  });
  it("默认/临时项目必须经人工create动作，偏好读不隐式创建", async () => {
    const { rpc, createProject } = await world();
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: { recentProjects: [] },
    });
    expect(createProject).not.toHaveBeenCalled();
    const defaultCreated = await rpc.call(
      actor,
      "file",
      "createDefaultWorkspace",
      [],
    );
    const defaultProject = codeUiWorkspaceSchema.parse(defaultCreated?.result);
    const scratchCreated = await rpc.call(
      actor,
      "file",
      "createScratchWorkspace",
      [{ name: "实验" }],
    );
    const scratchProject = codeUiWorkspaceSchema.parse(scratchCreated?.result);
    expect(defaultProject.projectId).not.toBe(scratchProject.projectId);
    expect(await realpath(defaultProject.path)).toBe(defaultProject.path);
    expect(await realpath(scratchProject.path)).toBe(scratchProject.path);
    expect(defaultCreated?.result).not.toHaveProperty("canvasId");
    expect(scratchCreated?.result).not.toHaveProperty("taskId");
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(createProject).toHaveBeenLastCalledWith(actor, {
      kind: "code",
      name: "实验",
    });
  });
  it("界面偏好真持久化，凭据/授权字段拒绝且不落库", async () => {
    const { rpc, preferencesApi } = await world();
    await rpc.call(actor, "setting", "update", [
      { locale: "en-US", messageStreamShowReasoning: false },
    ]);
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: { locale: "en-US", messageStreamShowReasoning: false },
    });
    for (const key of ["apiKey", "sandboxMode", "dataBaseDir"])
      await expect(
        rpc.call(actor, "setting", "update", [{ [key]: "secret" }]),
      ).rejects.toThrow("尚不支持");
    expect(preferencesApi.updateHumanPreferences).toHaveBeenCalledTimes(1);
  });
  it("显式关闭全部最近目录后读取保持空列表，不因Project仍存在复活目录", async () => {
    const { rpc, root, createProject, workspaces } = await world();
    await rpc.call(actor, "workspace", "open", [{ path: root }]);
    await rpc.call(actor, "setting", "update", [{ recentProjects: [root] }]);
    await rpc.call(actor, "setting", "update", [{ recentProjects: [] }]);
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: { recentProjects: [] },
    });
    expect(workspaces).toHaveLength(1);
    expect(createProject).toHaveBeenCalledTimes(1);
  });
  it("过滤归档tab后仍激活原目录，不能把原active索引移给另一目录", async () => {
    const { rpc, root, workspaces, preferencesApi } = await world();
    const projects = ["closed", "active", "last"].map((name) => ({
      projectId: randomUUID(),
      name,
      path: join(root, name),
      additionalDirectories: [],
    }));
    workspaces.push(...projects);
    await rpc.call(actor, "setting", "update", [
      {
        lastWorkspaceSession: projects.map((project) => ({
          kind: "local",
          workspacePath: project.path,
        })),
        lastActiveTabIndex: 1,
      },
    ]);
    workspaces.splice(0, 1);
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: {
        lastWorkspaceSession: projects.slice(1).map((project) => ({
          kind: "local",
          workspacePath: project.path,
          workspaceIdentity: JSON.stringify([project.projectId, project.path]),
        })),
        lastActiveTabIndex: 0,
      },
    });
    expect(preferencesApi.updateHumanPreferences).toHaveBeenCalledTimes(1);
  });
  it("共享目录的项目必须明确选择身份，不任取首项或创建第三个项目", async () => {
    const { rpc, root, createProject, workspaces } = await world();
    const first = {
      projectId: randomUUID(),
      name: "一",
      path: root,
      additionalDirectories: [],
    };
    const second = { ...first, projectId: randomUUID(), name: "二" };
    workspaces.push(first, second);
    await expect(
      rpc.call(actor, "workspace", "open", [{ path: root }]),
    ).rejects.toMatchObject({ code: "command_conflict" });
    expect(
      (
        await rpc.call(actor, "workspace", "open", [
          { path: root, projectId: second.projectId },
        ])
      )?.result,
    ).toEqual(second);
    expect(createProject).not.toHaveBeenCalled();
  });
  it("原terminal字体与继承设置真实持久化，空字体不落库", async () => {
    const { rpc, preferencesApi } = await world();
    await rpc.call(actor, "setting", "update", [
      { terminalFontFamily: "Fira Code", terminalInheritSystemProfile: false },
    ]);
    expect(await rpc.call(actor, "setting", "get", [])).toMatchObject({
      result: {
        terminalFontFamily: "Fira Code",
        terminalInheritSystemProfile: false,
      },
    });
    await expect(
      rpc.call(actor, "setting", "update", [{ terminalFontFamily: " " }]),
    ).rejects.toThrow();
    expect(preferencesApi.updateHumanPreferences).toHaveBeenCalledTimes(1);
  });
});
