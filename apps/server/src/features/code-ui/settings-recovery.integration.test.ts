import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeUiWorkspace } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";
import { createHumanWorkspaceRpc } from "./workspace-rpc.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const database = await createTaskWorkDatabase();
  cleanups.push(() => database.close());
  const { workspaceId, projectId, rootDirectory } = database.context.scope;
  const owner = await database.persistence.queryOne<{ owner_user_id: string }>(
    "select owner_user_id from public.workspaces where id=$1",
    [workspaceId],
  );
  if (!owner) throw new Error("独占工作区不存在");
  const actor: AuthenticatedUser = {
    id: owner.owner_user_id,
    email: "settings-recovery@integration.local",
    accessToken: "private-test",
    userMetadata: {},
  };
  const repository = createCodeUiRepository(database.persistence);
  const projects = createProjectRepository(database.persistence);
  const createTask = async (id = projectId, path = rootDirectory) => {
    const taskId = randomUUID();
    const scope = {
      ...database.context.scope,
      projectId: id,
      rootDirectory: path,
      taskId,
    };
    const conversation = createCodeUiConversation({
      sessionId: taskId,
      workspacePath: path,
      config: {
        provider: "zcode",
        model: "metadata-test",
        thought: "",
        followupMode: "queue",
      },
    });
    await repository.createRoot(workspaceId, {
      sessionId: taskId,
      projectId: id,
      scope,
      userId: actor.id,
      threadId: `settings-recovery:${taskId}`,
      state: conversation.exportState(),
      command: {
        clientId: randomUUID(),
        commandId: randomUUID(),
        fingerprint: "settings-recovery",
      },
    });
    return taskId;
  };
  const createRpc = () =>
    createHumanWorkspaceRpc({
      projects: {} as ProjectService,
      preferences: repository,
      workspaceId: async () => workspaceId,
      listWorkspaces: async () =>
        (
          await database.persistence
            .forWorkspace(workspaceId)
            .query<{ id: string; name: string; work_dir: string }>(
              "select id,name,work_dir from public.projects where workspace_id=:workspace and kind='code' and archived_at is null",
            )
        ).map(
          (project): CodeUiWorkspace => ({
            projectId: project.id,
            name: project.name,
            path: project.work_dir,
            additionalDirectories: [],
          }),
        ),
      resolveTaskPreference: async (_actor, id) => {
        const root = await repository.find(workspaceId, id);
        if (
          !root?.state ||
          root.parent_session_id ||
          root.id !== root.root_session_id ||
          root.archived ||
          root.deleted_at ||
          !root.root_directory
        )
          return null;
        return {
          projectId: root.project_id,
          rootDirectory: root.root_directory,
        };
      },
      maxEntries: async () => 5,
    });
  const rpc = createRpc();
  const call = (method: string, value?: unknown) =>
    rpc.call(actor, "setting", method, value === undefined ? [] : [value]);
  const taskId = await createTask();
  const identity = JSON.stringify([projectId, rootDirectory]);
  const tab = {
    kind: "local",
    workspacePath: rootDirectory,
    workspaceIdentity: identity,
    workspacePurpose: "conversation",
  };
  const saved = {
    lastWorkspaceSession: [tab],
    lastActiveTabIndex: 0,
    lastActiveTaskByWorkspace: { [identity]: taskId },
  };
  const anotherProject = async () =>
    (
      await projects.createProject({
        workspaceId,
        userId: actor.id,
        kind: "code",
        name: "同路径另一项目",
        slug: `same-path-${randomUUID()}`,
        description: null,
        canvasName: "unused",
        workDir: rootDirectory,
      })
    ).project;
  return {
    database,
    workspaceId,
    projectId,
    rootDirectory,
    repository,
    projects,
    actor,
    createTask,
    createRpc,
    call,
    taskId,
    identity,
    tab,
    saved,
    anotherProject,
  };
}

/** 偏好RPC与真实元数据/数据库边界；只使用独占临时Postgres。 */
describe.skipIf(process.env.KENFUTWORK_SETTINGS_HOST_TEST_PG !== "1")(
  "Code Root 本机身份偏好恢复真实Postgres integration",
  () => {
    it("qualified本机tab与Task焦点持久保存，Project默认A改B后cold读取仍精确恢复Task固定A", async () => {
      const f = await fixture();
      await f.call("update", f.saved);
      expect(await f.call("get")).toMatchObject({ result: f.saved });
      const nextRoot = join(f.database.directory, "new-default-B");
      await mkdir(nextRoot);
      await f.projects.update(f.workspaceId, f.projectId, {
        workDir: nextRoot,
      });
      expect(
        await f.createRpc().call(f.actor, "setting", "get", []),
      ).toMatchObject({ result: f.saved });
    });
    it("旧path入口只用真实Task事实升级Q，默认A改B且另一项目拥有A时不猜新Project或写读时迁移", async () => {
      const f = await fixture();
      const legacy = {
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: f.rootDirectory,
            workspacePurpose: "conversation",
          },
        ],
        lastActiveTabIndex: 0,
        lastActiveTaskByWorkspace: { [f.rootDirectory]: f.taskId },
      };
      await f.repository.updateHumanPreferences(f.workspaceId, legacy);
      const nextRoot = join(f.database.directory, "new-default-B");
      await mkdir(nextRoot);
      await f.projects.update(f.workspaceId, f.projectId, {
        workDir: nextRoot,
      });
      await f.anotherProject();
      const read = await f.createRpc().call(f.actor, "setting", "get", []);
      if (!read) throw new Error("设置RPC没有返回结果。");
      expect(read).toMatchObject({ result: f.saved });
      expect((read.result as typeof f.saved).lastActiveTaskByWorkspace).toEqual(
        { [f.identity]: f.taskId },
      );
      expect(await f.repository.readHumanPreferences(f.workspaceId)).toEqual(
        legacy,
      );
    });
    it("同路径两Project的Qtab与焦点隔离，legacy无证明、跨ProjectTask及外部目录不部分保存", async () => {
      const f = await fixture();
      const other = await f.anotherProject();
      const otherTask = await f.createTask(other.id);
      const otherIdentity = JSON.stringify([other.id, f.rootDirectory]);
      const saved = {
        lastWorkspaceSession: [
          f.tab,
          { ...f.tab, workspaceIdentity: otherIdentity },
        ],
        lastActiveTabIndex: 1,
        lastActiveTaskByWorkspace: {
          [f.identity]: f.taskId,
          [otherIdentity]: otherTask,
        },
      };
      await f.call("update", saved);
      expect(await f.call("get")).toMatchObject({ result: saved });
      const stored = await f.repository.readHumanPreferences(f.workspaceId);
      for (const patch of [
        {
          locale: "en-US",
          lastWorkspaceSession: [
            { kind: "local", workspacePath: f.rootDirectory },
          ],
          lastActiveTaskByWorkspace: {},
        },
        {
          locale: "en-US",
          lastActiveTaskByWorkspace: { [otherIdentity]: f.taskId },
        },
        {
          locale: "en-US",
          lastWorkspaceSession: [
            {
              kind: "local",
              workspacePath: "/not-a-project-root",
              workspaceIdentity: JSON.stringify([
                f.projectId,
                "/not-a-project-root",
              ]),
            },
          ],
          lastActiveTaskByWorkspace: {},
        },
      ]) {
        await expect(f.call("update", patch)).rejects.toMatchObject({
          code: "not_found",
        });
        expect(await f.repository.readHumanPreferences(f.workspaceId)).toEqual(
          stored,
        );
      }
    });
  },
);
