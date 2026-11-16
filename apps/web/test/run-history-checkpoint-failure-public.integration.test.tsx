// @vitest-environment node
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_GOVERNANCE_LIMITS,
  type AgentGovernanceOverrides,
  runTimelineResponseSchema,
  taskRunsResponseSchema,
  zcodeUiProtocol,
} from "@kenfutwork/shared";
import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import {
  createPublicSiblingTask,
  type PublicFixture,
} from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type BoundaryFilesRow = { phase: string; status: string };
type Fixture = PublicFixture & {
  directory: string;
  origin: string;
  cookie: string;
  database: {
    persistence: {
      query<T>(sql: string, values: unknown[]): Promise<T[]>;
      execute(sql: string, values?: unknown[]): Promise<number>;
    };
  };
};

const beforeMessage = "无法保存运行前的检查点，请检查本机数据目录。";
const afterMessage = "无法保存运行后的检查点，请检查本机数据目录。";

async function readCompletedRuns(host: Host, count: number) {
  return vi.waitFor(
    async () => {
      const snapshot = zcodeUiProtocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("completedSuccess");
      const result = await host.client.request(
        `/api/agent/tasks/${host.sessionId}/runs?projectId=${host.projectId}`,
      );
      expect(result.status).toBe(200);
      const { runs } = taskRunsResponseSchema.parse(result.body);
      expect(runs).toHaveLength(count);
      expect(runs.every((row) => row.status === "completed")).toBe(true);
      return runs;
    },
    { timeout: 30_000 },
  );
}

async function readBoundaryFiles(fixture: Fixture, runId: string) {
  return fixture.database.persistence.query<BoundaryFilesRow>(
    `select phase, boundary #>> '{files,status}' as status
       from public.agent_turn_boundaries where run_id = $1
       order by phase desc`,
    [runId],
  );
}

async function historyTestRuntime() {
  const fixturePath = fileURLToPath(
    new URL(
      "../../server/src/features/code-ui/code-ui-http.fixture.ts",
      import.meta.url,
    ),
  );
  return Promise.all([
    import(fixturePath) as Promise<{
      createCodeUiHttpFixture(options: {
        governanceEnv: AgentGovernanceOverrides;
      }): Promise<Fixture>;
    }>,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
  ]);
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "实际检查点保存失败会出现在对应轮次且不改变完成状态",
  async () => {
    const [http, sessions, models] = await historyTestRuntime();
    // 运行真实本机助手，避免编译器首启的耗时成为第二个故障源。
    const fixture = await http.createCodeUiHttpFixture({
      governanceEnv: {
        processKillGraceMs: AGENT_GOVERNANCE_LIMITS.processKillGraceMs.max,
      },
    });
    const model = await models.heldModel();
    let host: Host | undefined;
    let releaseDom: (() => void) | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const task = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      host = task;
      const root = join(fixture.directory, "checkpoints");
      await rm(root, { recursive: true, force: true });
      await writeFile(root, "测试使私有快照目录暂不可用");
      expect(
        (await task.command("sendText", { text: "运行前无法保存" })).body.result
          .status,
      ).toBe("accepted");
      await model.firstRequest;
      await rm(root);
      model.finish(0);
      const [first] = await readCompletedRuns(task, 1);
      if (!first) throw new Error("第一轮缺少运行记录");
      expect(await readBoundaryFiles(fixture, first.runId)).toEqual([
        { phase: "pre", status: "failed" },
        { phase: "post", status: "captured" },
      ]);

      expect(
        (await task.command("sendText", { text: "运行后无法保存" })).body.result
          .status,
      ).toBe("accepted");
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 30_000,
      });
      await rename(root, `${root}-backup`);
      await writeFile(root, "测试使私有快照目录暂不可用");
      model.finish(1);
      const second = (await readCompletedRuns(task, 2)).find(
        ({ runId }) => runId !== first.runId,
      );
      if (!second) throw new Error("第二轮缺少运行记录");
      expect(await readBoundaryFiles(fixture, second.runId)).toEqual([
        { phase: "pre", status: "captured" },
        { phase: "post", status: "failed" },
      ]);
      const otherTask = await createPublicSiblingTask(task);
      const denied = await task.client.request(
        `/api/agent/tasks/${otherTask}/runs/${second.runId}/timeline?projectId=${task.projectId}`,
      );
      expect(denied.status).toBe(404);
      const readTimeline = async (runId: string) => {
        const result = await task.client.request(
          `/api/agent/tasks/${task.sessionId}/runs/${runId}/timeline?projectId=${task.projectId}`,
        );
        expect(result.status).toBe(200);
        return runTimelineResponseSchema.parse(result.body);
      };
      const start = await readTimeline(first.runId);
      const end = await readTimeline(second.runId);
      expect(start.run).toMatchObject({
        status: "completed",
        errorMessage: null,
      });
      expect(end.run).toMatchObject({
        status: "completed",
        errorMessage: null,
      });
      expect(start.entries).toContainEqual(
        expect.objectContaining({ title: "开始运行", detail: beforeMessage }),
      );
      expect(JSON.stringify(start.entries)).not.toContain(afterMessage);
      expect(end.entries).toContainEqual(
        expect.objectContaining({
          title: "运行完成",
          detail: expect.stringContaining(afterMessage),
        }),
      );
      expect(JSON.stringify(end.entries)).not.toContain(beforeMessage);
      expect(JSON.stringify(end)).not.toContain(fixture.directory);

      releaseDom = await installCodePublicHostDom();
      const [
        { RunHistoryEntry },
        { setSurfaceApiBase },
        { useZCodeSessionStore },
      ] = await Promise.all([
        import("../src/components/workbench/zcode/host/RunTimelineDialog.js"),
        import("../src/components/workbench/zcode/host/surfaceApi.js"),
        import("@zui/store/zcodeSessionStore.js"),
      ]);
      const nativeFetch = globalThis.fetch;
      const headers = { origin: fixture.origin, cookie: fixture.cookie };
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
        nativeFetch(url, { ...init, headers }),
      );
      const exportResponse = await nativeFetch(
        `${fixture.baseUrl}/api/agent/tasks/${task.sessionId}/runs/${second.runId}/timeline/export?projectId=${task.projectId}`,
        { headers },
      );
      expect(exportResponse.status).toBe(200);
      expect(await exportResponse.text()).toContain(afterMessage);
      setSurfaceApiBase(fixture.baseUrl);
      const identity = JSON.stringify([task.projectId, task.workspacePath]);
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(task.workspacePath, task.sessionId, identity);
      view = render(
        <RunHistoryEntry
          workspacePath={task.workspacePath}
          workspaceIdentity={identity}
        />,
      );
      fireEvent.click(view.getByTestId("run-history-trigger"));
      fireEvent.click(await view.findByTestId(`run-row-${second.runId}`));
      await view.findByText(afterMessage, { exact: false });
      expect(view.getByText("状态 已完成")).toBeTruthy();
      expect(view.queryByText(beforeMessage, { exact: false })).toBeNull();
    } finally {
      view?.unmount();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseDom?.();
      vi.unstubAllGlobals();
      await host?.dispose();
      await model.close();
      await fixture.close();
    }
  },
  120_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "启动前失败在原运行记录显示未开始并保留处理方法",
  async () => {
    const [http, sessions, models] = await historyTestRuntime();
    const fixture = await http.createCodeUiHttpFixture({ governanceEnv: {} });
    const model = await models.heldModel();
    let host: Host | undefined;
    let releaseDom: (() => void) | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      const task = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      host = task;
      await fixture.database.persistence.execute(
        "create function public.reject_start_history() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_START_HISTORY_FAILURE'; end $$",
      );
      await fixture.database.persistence.execute(
        "create trigger reject_start_history before insert on public.agent_runs for each row execute function public.reject_start_history()",
      );
      expect(
        (await task.command("sendText", { text: "这次无法开始" })).body.result
          .status,
      ).toBe("accepted");
      await vi.waitFor(
        async () =>
          expect(
            zcodeUiProtocol.conversationSnapshotSchema.parse(
              await task.snapshot(),
            ).control.phase,
          ).toBe("error"),
        { timeout: 30_000 },
      );
      expect(model.requests).toHaveLength(0);
      const history = await task.client.request(
        `/api/agent/tasks/${task.sessionId}/runs?projectId=${task.projectId}`,
      );
      const [attempt] = taskRunsResponseSchema.parse(history.body).runs;
      if (!attempt) throw new Error("未开始的尝试没有保存到原任务");
      releaseDom = await installCodePublicHostDom();
      const [
        { RunHistoryEntry },
        { setSurfaceApiBase },
        { useZCodeSessionStore },
      ] = await Promise.all([
        import("../src/components/workbench/zcode/host/RunTimelineDialog.js"),
        import("../src/components/workbench/zcode/host/surfaceApi.js"),
        import("@zui/store/zcodeSessionStore.js"),
      ]);
      const nativeFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
        nativeFetch(url, {
          ...init,
          headers: { origin: fixture.origin, cookie: fixture.cookie },
        }),
      );
      setSurfaceApiBase(fixture.baseUrl);
      const identity = JSON.stringify([task.projectId, task.workspacePath]);
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(task.workspacePath, task.sessionId, identity);
      view = render(
        <RunHistoryEntry
          workspacePath={task.workspacePath}
          workspaceIdentity={identity}
        />,
      );
      fireEvent.click(view.getByTestId("run-history-trigger"));
      const row = await view.findByTestId(`run-row-${attempt.runId}`);
      expect(row.textContent).toContain("未开始");
      expect(row.textContent).not.toContain("耗时");
      fireEvent.click(row);
      await view.findByText("状态 未开始");
      expect(view.getByText("未开始运行")).toBeTruthy();
      expect(
        view.getAllByText("无法保存运行记录，请检查本机存储后重试。").length,
      ).toBeGreaterThan(0);
      expect(view.queryByText(/耗时/)).toBeNull();
      expect(view.container.textContent).not.toContain(
        "PRIVATE_START_HISTORY_FAILURE",
      );
      expect(model.requests).toHaveLength(0);
    } finally {
      view?.unmount();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseDom?.();
      vi.unstubAllGlobals();
      await host?.dispose();
      await model.close();
      await fixture.close();
    }
  },
  120_000,
);
