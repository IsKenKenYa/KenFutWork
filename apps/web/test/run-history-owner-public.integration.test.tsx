// @vitest-environment node
import { fileURLToPath } from "node:url";
import { taskRunsResponseSchema, zcodeUiProtocol } from "@kenfutwork/shared";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import {
  createPublicSiblingTask,
  type PublicFixture,
} from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Fixture = PublicFixture & { origin: string; cookie: string };
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function readRuns(host: Host) {
  const path = `/api/agent/tasks/${host.sessionId}/runs?projectId=${host.projectId}`;
  const result = await host.client.request(path);
  expect(result.status).toBe(200);
  return taskRunsResponseSchema.parse(result.body).runs;
}

async function prepareTwoRuns(
  host: Host,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  expect(
    (await host.command("sendText", { text: "第一轮已结束" })).status,
  ).toBe(200);
  await model.firstRequest;
  model.finish(0);
  const previous = await vi.waitFor(
    async () => {
      const snapshot = zcodeUiProtocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("completedSuccess");
      const run = (await readRuns(host)).find(
        (row) => row.status === "completed",
      );
      if (!run) throw new Error("第一轮记录尚未保存");
      return run.runId;
    },
    { timeout: 30_000 },
  );
  expect(
    (await host.command("sendText", { text: "第二轮未结束" })).status,
  ).toBe(200);
  const current = await vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(2);
      const run = (await readRuns(host)).find(
        (row) => row.status === "running",
      );
      if (!run) throw new Error("第二轮记录尚未保存");
      return run.runId;
    },
    { timeout: 30_000 },
  );
  return { previous, current };
}

function bindTransport(fixture: Fixture) {
  const nativeFetch = globalThis.fetch;
  const hold = new Map<string, (response: Response) => Promise<void>>();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", fixture.origin);
    headers.set("cookie", fixture.cookie);
    const path = new URL(url).pathname;
    const delay = hold.get(path);
    hold.delete(path);
    // 本机真实响应已完整读取，只推迟交付以模拟晚于任务切换的响应。
    const response = await nativeFetch(url, {
      ...init,
      headers,
      ...(delay ? { signal: null } : {}),
    });
    if (delay) {
      await response.clone().arrayBuffer();
      await delay(response);
    }
    return response;
  });
  return (path: string) => {
    let deliver!: () => void;
    let arrived!: (response: Response) => void;
    const cutoff = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      arrived = resolve;
    });
    hold.set(path, (result) => {
      arrived(result);
      return cutoff;
    });
    return { response, deliver };
  };
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "换轮次、换任务和关闭窗口后不接受迟到的真实运行记录",
  async () => {
    const httpLoading: Promise<{
      createCodeUiHttpFixture(): Promise<Fixture>;
    }> = import(fixturePath);
    const [http, sessions, models] = await Promise.all([
      httpLoading,
      import("../../server/src/features/code-ui/host-session.fixture.js"),
      import("../../server/src/features/code-ui/model-stream.fixture.js"),
    ]);
    const fixture = await http.createCodeUiHttpFixture();
    const model = await models.heldModel();
    let host: Host | undefined;
    let releaseDom: (() => void) | undefined;
    let view: ReturnType<typeof render> | undefined;
    try {
      host = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      const otherTask = await createPublicSiblingTask(host);
      const { previous, current } = await prepareTwoRuns(host, model);
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
      setSurfaceApiBase(fixture.baseUrl);
      const path = host.workspacePath;
      const taskId = host.sessionId;
      const identity = JSON.stringify([host.projectId, path]);
      const setActiveTask = (id: string) =>
        useZCodeSessionStore.getState().setActiveTaskId(path, id, identity);
      setActiveTask(taskId);
      const delay = bindTransport(fixture);
      const panel = render(
        <RunHistoryEntry workspacePath={path} workspaceIdentity={identity} />,
      );
      view = panel;
      const endpoint = `/api/agent/tasks/${taskId}/runs`;
      fireEvent.click(panel.getByTestId("run-history-trigger"));
      const oldDetail = delay(`${endpoint}/${previous}/timeline`);
      try {
        fireEvent.click(await panel.findByTestId(`run-row-${previous}`));
        expect((await oldDetail.response).status).toBe(200);
        fireEvent.click(panel.getByRole("button", { name: "轮次列表" }));
        fireEvent.click(await panel.findByTestId(`run-row-${current}`));
        await panel.findByText("状态 进行中");
      } finally {
        await act(async () => oldDetail.deliver());
      }
      const detail = within(panel.getByRole("dialog", { name: "运行记录" }));
      expect(detail.getByText("状态 进行中")).toBeTruthy();
      expect(detail.queryByText("状态 已完成")).toBeNull();

      const oldList = delay(endpoint);
      try {
        fireEvent.click(detail.getByRole("button", { name: "轮次列表" }));
        expect((await oldList.response).status).toBe(200);
        await act(async () => setActiveTask(otherTask));
        expect(panel.queryByRole("dialog")).toBeNull();
        fireEvent.click(panel.getByTestId("run-history-trigger"));
        await panel.findByText("这个 Task 还没有运行记录");
      } finally {
        await act(async () => oldList.deliver());
      }
      expect(panel.getByText("这个 Task 还没有运行记录")).toBeTruthy();
      expect(panel.queryByTestId(`run-row-${current}`)).toBeNull();

      await act(async () => setActiveTask(taskId));
      const closedList = delay(endpoint);
      try {
        fireEvent.click(panel.getByTestId("run-history-trigger"));
        expect((await closedList.response).status).toBe(200);
        fireEvent.click(panel.getByRole("button", { name: "关闭" }));
        model.finish(1);
        const bound = host;
        await vi.waitFor(
          async () => {
            const runs = await readRuns(bound);
            expect(runs).toHaveLength(2);
            expect(runs.every((row) => row.status === "completed")).toBe(true);
          },
          { timeout: 30_000 },
        );
        fireEvent.click(panel.getByTestId("run-history-trigger"));
        await waitFor(() =>
          expect(
            within(panel.getByTestId(`run-row-${current}`)).getByText("已完成"),
          ).toBeTruthy(),
        );
      } finally {
        await act(async () => closedList.deliver());
      }
      expect(
        within(panel.getByTestId(`run-row-${current}`)).getByText("已完成"),
      ).toBeTruthy();
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
