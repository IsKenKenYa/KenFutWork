import {
  codeProjectTreeTaskSchema,
  codeUiWorkspaceSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zcodeTaskMetaSchema } from "../../../packages/zcode-shared/dist/index.js";
import type { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import {
  createTarget,
  moveUsingCurrentControl,
  type ProjectionContext,
  type ProjectionResources,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
type View = ReturnType<typeof render>;

async function loadProjectSurface() {
  const [
    { ServiceProvider },
    { ProjectDirectoryProvider, useProjectDirectory },
    { SharedProjectNavigationProvider, useSharedProjectCatalog },
  ] = await Promise.all([
    import("@zui/hooks/useServices.js"),
    import("@zui/project-sidebar/ProjectDirectoryProvider.js"),
    import("../src/components/workbench/zcode/host/SharedProjectNavigation.js"),
  ]);
  function ProjectProbe({
    taskId,
    projectId,
  }: {
    taskId: string;
    projectId: string;
  }) {
    const catalog = useSharedProjectCatalog();
    const directory = useProjectDirectory();
    const task = directory.tree.tasks.find((entry) => entry.taskId === taskId);
    const project = catalog?.find((entry) => entry.projectId === projectId);
    return (
      <section
        data-testid="project-provider-facts"
        data-ready={!directory.loading && directory.groups.available}
      >
        <output data-testid="directory-task">
          {JSON.stringify(task ?? null)}
        </output>
        <output data-testid="catalog-project">
          {JSON.stringify(project ?? null)}
        </output>
        <output data-testid="directory-error">{directory.error}</output>
      </section>
    );
  }
  return function ProjectSurface({
    client,
    taskId,
    projectId,
  }: {
    client: CodeHttpChannelClient;
    taskId: string;
    projectId: string;
  }) {
    const services = useSyncExternalStore(
      client.subscribeServices,
      () => client.services,
    );
    return (
      <SharedProjectNavigationProvider client={client}>
        <ServiceProvider services={services}>
          <ProjectDirectoryProvider>
            <ProjectProbe taskId={taskId} projectId={projectId} />
          </ProjectDirectoryProvider>
        </ServiceProvider>
      </SharedProjectNavigationProvider>
    );
  };
}

function readFact(view: View, testId: string): unknown {
  const text = view.getByTestId(testId).textContent;
  if (!text) throw new Error("真实项目Provider尚未显示读取结果。");
  return JSON.parse(text);
}

function expectDirectoryReady(view: View) {
  expect(
    view.getByTestId("project-provider-facts").getAttribute("data-ready"),
  ).toBe("true");
  expect(view.getByTestId("directory-error").textContent).toBe("");
}

function expectTask(
  view: View,
  taskId: string,
  projectId: string,
  workspacePath: string,
  branchGeneration: number,
) {
  const task = codeProjectTreeTaskSchema.parse(
    readFact(view, "directory-task"),
  );
  expect(task).toMatchObject({
    taskId,
    projectId,
    workspacePath,
    workspaceIdentity: JSON.stringify([projectId, workspacePath]),
    taskControl: { projectId, branchGeneration },
  });
}

async function mountProjectProviders(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { fixture, session, client } = context;
  const before = zcodeTaskMetaSchema.parse(
    await client.services.zcodeTaskService.getTaskMeta({
      taskId: session.sessionId,
      workspacePath: session.workspacePath,
      workspaceIdentity: JSON.stringify([
        session.projectId,
        session.workspacePath,
      ]),
    }),
  );
  const initialControl = protocol.conversationTaskControlSchema.parse(
    before.taskControl,
  );
  const targetProjectId = await createTarget(fixture, session);
  resources.targetProjectId = targetProjectId;
  const target = (await client.refreshWorkspaces()).find(
    (project) => project.projectId === targetProjectId,
  );
  if (!target) throw new Error("真实项目目录缺少重连目标项目。");
  resources.releaseDom = await installCodePublicHostDom();
  const ProjectSurface = await loadProjectSurface();
  const view = render(
    <ProjectSurface
      client={client}
      taskId={session.sessionId}
      projectId={targetProjectId}
    />,
  );
  resources.unmount = () => view.unmount();
  await waitFor(
    () => {
      expectDirectoryReady(view);
      expectTask(
        view,
        session.sessionId,
        session.projectId,
        before.workspacePath,
        initialControl.branchGeneration,
      );
      const project = codeUiWorkspaceSchema.parse(
        readFact(view, "catalog-project"),
      );
      expect(project).toMatchObject({
        projectId: targetProjectId,
        path: target.path,
      });
      expect(project.additionalDirectories).toEqual([]);
    },
    { timeout: 30_000 },
  ); // 原Provider的目录、分组登记和初始Project读取完成后才中断网络。
  return { view, before, initialControl, target };
}

async function assertProjectProviderRecovery(
  context: ProjectionContext,
  resources: ProjectionResources,
) {
  const { session, model, client } = context;
  const gate = resources.connectionGate;
  if (!gate) throw new Error("真实连接转发门尚未准备。");
  const { view, before, initialControl, target } = await mountProjectProviders(
    context,
    resources,
  );
  act(() => gate.blockAndDisconnect());
  await vi.waitFor(() => expect(gate.blockedConnections).toBeGreaterThan(0), {
    timeout: 30_000,
  }); // 观察真实新连接已到达阻断门，不读取客户端内部连接状态。
  for (const projectId of [
    target.projectId,
    session.projectId,
    target.projectId,
  ])
    await moveUsingCurrentControl(session, before.workspacePath, projectId);
  const current = protocol.conversationSnapshotSchema.parse(
    await session.snapshot(),
  );
  expect(current.taskControl).toEqual({
    projectId: target.projectId,
    branchGeneration: initialControl.branchGeneration + 3,
  });
  await act(async () => {
    gate.release();
    await client.connect();
  });
  await waitFor(
    () => {
      expectDirectoryReady(view);
      expectTask(
        view,
        session.sessionId,
        target.projectId,
        before.workspacePath,
        initialControl.branchGeneration + 3,
      );
      const project = codeUiWorkspaceSchema.parse(
        readFact(view, "catalog-project"),
      );
      expect(project).toMatchObject({
        projectId: target.projectId,
        path: target.path,
      });
      expect(project.additionalDirectories).toContainEqual({
        path: before.workspacePath,
        access: "read-write",
      });
    },
    { timeout: 30_000 },
  ); // 只等原Provider自行重读；不主动刷新项目树、目录或触发窗口focus。
  expect(model.requests).toHaveLength(1);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目Provider的真实HTTP、SSE与PostgreSQL重连 integration",
  () => {
    it("同一客户端断线期间项目往返三次，重连后原Provider恢复Task与共享项目目录", async () => {
      await withProjectionResources(assertProjectProviderRecovery, true);
    }, 120_000); // 真实Provider、透明TCP门、SSE恢复、三次公开移动和全部资源关闭期限。
  },
);
// @vitest-environment node
