// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkpointListResponseSchema,
  zcodeUiProtocol,
} from "@kenfutwork/shared";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Fixture = PublicFixture & { origin: string; cookie: string };

async function listCheckpoints(host: Host) {
  const result = await host.client.request(
    `/api/code/checkpoints?taskId=${host.sessionId}`,
  );
  expect(result.status).toBe(200);
  return checkpointListResponseSchema.parse(result.body).checkpoints;
}

function bindCheckpointTransport(fixture: Fixture) {
  const nativeFetch = globalThis.fetch;
  const listStatuses: number[] = [];
  const control = { allowList: true, listStatuses };
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input);
      if (!target.pathname.startsWith("/api/code/checkpoints"))
        return nativeFetch(input, init);
      const isList = target.pathname === "/api/code/checkpoints";
      const headers = new Headers(init?.headers);
      headers.set("origin", fixture.origin);
      // 只改变本机连接凭据；拒绝响应仍由实际服务返回。
      if (!isList || control.allowList) headers.set("cookie", fixture.cookie);
      const response = await nativeFetch(input, { ...init, headers });
      if (isList) listStatuses.push(response.status);
      return response;
    },
  );
  return control;
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "同一 Task 的首个检查点在轮次结束后显示且读取失败可恢复",
  async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../server/src/features/code-ui/code-ui-http.fixture.ts",
        import.meta.url,
      ),
    );
    const http: { createCodeUiHttpFixture(): Promise<Fixture> } = await import(
      fixturePath
    );
    const [sessions, models] = await Promise.all([
      import("../../server/src/features/code-ui/host-session.fixture.js"),
      import("../../server/src/features/code-ui/model-stream.fixture.js"),
    ]);
    const fixture = await http.createCodeUiHttpFixture();
    const model = await models.heldModel();
    let host: Host | undefined;
    let ui: Awaited<ReturnType<typeof renderOriginalSession>> | undefined;
    try {
      const task = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initializeGit: false,
      });
      host = task;
      const path = join(task.workspacePath, "first-checkpoint.txt");
      await writeFile(path, "轮次前的文件\n");
      expect(await listCheckpoints(task)).toEqual([]);

      ui = await renderOriginalSession(fixture, task, () => {
        vi.stubGlobal("Text", window.Text);
      });
      const [{ setSurfaceApiBase }, { useZCodeSessionStore }] =
        await Promise.all([
          import("../src/components/workbench/zcode/host/surfaceApi.js"),
          import("@zui/store/zcodeSessionStore.js"),
        ]);
      setSurfaceApiBase(fixture.baseUrl);
      const transport = bindCheckpointTransport(fixture);
      await act(async () => {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(
            task.workspacePath,
            task.sessionId,
            JSON.stringify([task.projectId, task.workspacePath]),
          );
      });
      const view = ui.view;
      await waitFor(() => expect(transport.listStatuses).toEqual([200]));
      expect(view.queryByTestId("checkpoint-timeline-trigger")).toBeNull();

      expect(
        (await task.command("sendText", { text: "第一轮不修改文件" })).status,
      ).toBe(200);
      await model.firstRequest;
      expect(view.queryByTestId("checkpoint-timeline-trigger")).toBeNull();
      model.finish(0);
      await vi.waitFor(
        async () => {
          const snapshot = zcodeUiProtocol.conversationSnapshotSchema.parse(
            await task.snapshot(),
          );
          expect(snapshot.control.phase).toBe("completedSuccess");
          const header = snapshot.rows.window.find(
            (row) => row.kind === "turnHeader",
          );
          expect(header).toMatchObject({ state: "completedSuccess" });
          expect(header?.actions?.canRewindFiles).toBeUndefined();
          expect(await listCheckpoints(task)).not.toHaveLength(0);
        },
        { timeout: 30_000 },
      );

      const expand = view.queryByRole("button", { name: "展开状态" });
      if (expand) fireEvent.click(expand);
      fireEvent.click(await view.findByRole("button", { name: "检查点" }));
      await view.findByRole("dialog", { name: "回滚到检查点" });
      await waitFor(() => {
        expect(
          view.getByRole("button", { name: "回滚" }).hasAttribute("disabled"),
        ).toBe(false);
      });

      const beforeRefresh = [...transport.listStatuses];
      transport.allowList = false;
      expect(
        (await task.command("sendText", { text: "第二轮也不修改文件" })).status,
      ).toBe(200);
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 30_000,
      });
      model.writeText(1, "第二轮已结束");
      model.finish(1);
      await view.findByText(/第二轮已结束/u);
      await vi.waitFor(
        async () => {
          const snapshot = zcodeUiProtocol.conversationSnapshotSchema.parse(
            await task.snapshot(),
          );
          expect(snapshot.control.phase).toBe("completedSuccess");
        },
        { timeout: 30_000 },
      );
      expect(view.getByRole("dialog", { name: "回滚到检查点" })).toBeTruthy();
      expect(transport.listStatuses).toEqual(beforeRefresh);
      fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
      const error = await view.findByRole("alert");
      expect(error.textContent).toContain("本机连接已失效");
      expect(transport.listStatuses).toEqual([...beforeRefresh, 401]);
      transport.allowList = true;
      fireEvent.click(view.getByRole("button", { name: "重试读取检查点" }));
      await view.findByRole("button", { name: "检查点" });
      expect(transport.listStatuses).toEqual([...beforeRefresh, 401, 200]);
    } finally {
      ui?.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      ui?.releaseDom();
      vi.unstubAllGlobals();
      await host?.dispose();
      await model.close();
      await fixture.close();
    }
  },
  120_000,
);
