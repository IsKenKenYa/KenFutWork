import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原前台子独立Stop控制 integration",
  () => {
    it("原UI所需唯一work/child联接存在，异Task拒绝且独立Stop只关子流、父继续", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "foreground-child-control",
          name: "Task",
          arguments: {
            subagent_type: "explore",
            description: "FOREGROUND_CONTROL_CHILD",
            ownership: ["."],
            completion_criteria: "返回调研证据",
            run_in_background: false,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", {
          text: "PARENT_WAIT_FOREGROUND_CHILD",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const parent = await snapshot(fixture, host.sessionId);
        const child = parent.rows.window.find((row) => row.kind === "subagent");
        if (child?.kind !== "subagent" || !child.childSessionId)
          throw new Error("真实前台子身份缺失");
        const controls = parent.backgroundWorks.filter(
          (work) =>
            work.kind === "subagent" &&
            work.childSessionId === child.childSessionId &&
            work.status === "running",
        );
        expect(controls, JSON.stringify(parent)).toHaveLength(1);
        const control = controls[0];
        if (!control) throw new Error("原Stop没有唯一控制work");
        expect(control.cancellable).toBe(true);
        expect(parent.control.phase).toBe("running");
        const parentExecution = parent.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        if (!parentExecution) throw new Error("真实父运行标识缺失");
        const neighborPath = join(fixture.directory, "neighbor-project");
        await mkdir(neighborPath);
        const opened = await host.client.request("/api/code-ui/rpc", {
          service: "workspace",
          method: "open",
          args: [{ path: neighborPath }],
        });
        expect(opened.status).toBe(200);
        const currentHost = host;
        const neighborCommand = (
          sessionId: string | null,
          type: string,
          payload: unknown,
        ) =>
          currentHost.stream.rpc("sendConversationCommandV4", [
            {
              workspacePath: opened.body.result.path,
              projectId: opened.body.result.projectId,
              envelope: {
                sessionId,
                type,
                payload,
                clientId: currentHost.clientId,
                commandId: randomUUID(),
                issuedAt: Date.now(),
              },
            },
          ]);
        const created = await neighborCommand(null, "createSession", {
          workspaceId: opened.body.result.projectId,
          config: { modelSelection: parent.config.modelSelection },
        });
        const createdAck = protocol.commandAckSchema.parse(created.body.result);
        if (createdAck.result?.type !== "createSession")
          throw new Error("邻居Task创建失败");
        const neighborId = createdAck.result.sessionId;
        const neighbor = {
          sessionId: neighborId,
          command: (type: string, payload: unknown) =>
            neighborCommand(neighborId, type, payload),
        };
        await neighbor.command("sendText", { text: "NEIGHBOR_MUST_CONTINUE" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const wrong = await neighbor.command("cancelBackgroundWork", {
          workId: control.workId,
        });
        expect(wrong.body.result).toMatchObject({ status: "failed" });
        expect(model.requests[1]?.closed).toBe(false);
        const commandId = randomUUID();
        const stopped = await host.command(
          "cancelBackgroundWork",
          {
            workId: control.workId,
          },
          commandId,
        );
        expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
        expect(stopped.body.result).toMatchObject({ status: "accepted" });
        await vi.waitFor(() => expect(model.requests[1]?.closed).toBe(true), {
          timeout: 30_000,
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        const waiting = await snapshot(fixture, host.sessionId);
        expect(waiting.control.phase).toBe("running");
        expect(waiting.control.activeWorks).toContainEqual(
          expect.objectContaining({ foregroundExecutionId: parentExecution }),
        );
        expect(
          waiting.backgroundWorks.some(
            (work) => work.childSessionId === child.childSessionId,
          ),
        ).toBe(false);
        expect(
          waiting.rows.window.find(
            (row) =>
              row.kind === "subagent" &&
              row.childSessionId === child.childSessionId,
          ),
        ).toMatchObject({ status: "cancelled" });
        expect(
          (await snapshot(fixture, child.childSessionId)).control.phase,
        ).toBe("completedInterrupted");
        expect(model.requests[2]?.closed).toBe(false);
        const replayed = await host.command(
          "cancelBackgroundWork",
          {
            workId: control.workId,
          },
          commandId,
        );
        expect(replayed.body.result).toEqual({
          ...stopped.body.result,
          status: "duplicate",
        });
        expect(model.requests).toHaveLength(4);
        expect(
          waiting.rows.window.some(
            (row) =>
              row.kind === "userInput" && row.origin === "backgroundResult",
          ),
        ).toBe(false);
        model.finish(3);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        model.finish(2);
        await waitPhase(fixture, neighbor.sessionId, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
    it("同名嵌套子由根Task提供两项准确控制，停止孙不关闭子或父，正常结束后全部移除", async () => {
      const fixture = await createCodeUiHttpFixture();
      const dispatch = (id: string) => ({
        id,
        name: "Task",
        arguments: {
          subagent_type: "explore",
          description: "SAME_NESTED_TITLE",
          ownership: ["."],
          completion_criteria: "返回结果",
          run_in_background: false,
        },
      });
      const model = await heldModel({
        initialTool: dispatch("child-control"),
        toolsByRequest: { 1: dispatch("grandchild-control") },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const depth = await host.client.request(
          "/api/instance/settings",
          { subagentMaxDepth: 2 },
          "PATCH",
        );
        expect(depth.status).toBe(200);
        await host.command("sendText", { text: "ROOT_WITH_NESTED_CONTROLS" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const root = await snapshot(fixture, host.sessionId);
        const child = root.subagents?.running[0];
        if (!child) throw new Error("根直接子缺失");
        const childSnapshot = await snapshot(fixture, child.childSessionId);
        const grandchild = childSnapshot.subagents?.running[0];
        if (!grandchild) throw new Error("嵌套孙缺失");
        expect(root.subagents?.running).toHaveLength(1);
        expect(childSnapshot.subagents?.running).toHaveLength(1);
        expect(childSnapshot.backgroundWorks).toEqual([]);
        const controls = root.backgroundWorks.filter(
          (work) => work.kind === "subagent",
        );
        expect(controls).toHaveLength(2);
        expect(new Set(controls.map((work) => work.childSessionId))).toEqual(
          new Set([child.childSessionId, grandchild.childSessionId]),
        );
        expect(new Set(controls.map((work) => work.workId)).size).toBe(2);
        const target = controls.find(
          (work) => work.childSessionId === grandchild.childSessionId,
        );
        if (!target) throw new Error("孙控制缺失");
        expect(
          (
            await host.command("cancelBackgroundWork", {
              workId: target.workId,
            })
          ).body.result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        expect(model.requests[2]?.closed).toBe(true);
        const waitingRoot = await snapshot(fixture, host.sessionId);
        expect(waitingRoot.control.phase).toBe("running");
        expect(waitingRoot.control.activeWorks).toEqual(
          root.control.activeWorks,
        );
        expect(waitingRoot.backgroundWorks).toMatchObject([
          { childSessionId: child.childSessionId, status: "running" },
        ]);
        expect(
          (await snapshot(fixture, child.childSessionId)).control.phase,
        ).toBe("running");
        expect(
          (await snapshot(fixture, grandchild.childSessionId)).control.phase,
        ).toBe("completedInterrupted");
        model.finish(3);
        await vi.waitFor(() => expect(model.requests).toHaveLength(5), {
          timeout: 30_000,
        });
        const waiting = await snapshot(fixture, host.sessionId);
        expect(waiting.backgroundWorks).toEqual([]);
        expect(waiting.subagents?.running).toEqual([]);
        expect(
          (await snapshot(fixture, child.childSessionId)).control.phase,
        ).toBe("completedSuccess");
        model.finish(4);
        const completed = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        expect(
          completed.rows.window.some(
            (row) =>
              row.kind === "userInput" && row.origin === "backgroundResult",
          ),
        ).toBe(false);
        expect(model.requests).toHaveLength(5);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
