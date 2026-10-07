import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "独立子Harness生命周期 integration",
  () => {
    it.each([true, false])(
      "后台=%s：父自然结束不取消后台，显式停止与前台父取消仍关闭真实子流",
      async (detached) => {
        const fixture = await createCodeUiHttpFixture();
        const description = "LIFETIME_CHILD_EXPLICIT_ROLE";
        const model = await heldModel({
          initialTool: {
            id: "lifetime-real-child",
            name: "Task",
            arguments: {
              subagent_type: "explore",
              description,
              ownership: ["."],
              completion_criteria: "返回证据",
              run_in_background: detached,
            },
          },
        });
        let host: Host | undefined;
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          await host.command("sendText", { text: "LIFETIME_PARENT" });
          await vi.waitFor(
            () => expect(model.requests).toHaveLength(detached ? 3 : 2),
            { timeout: 30_000 },
          );
          const childIndex = model.requests.findIndex(
            (request, index) =>
              index > 0 &&
              Array.isArray(request.body.messages) &&
              request.body.messages.some(
                (message) =>
                  typeof message === "object" &&
                  message !== null &&
                  "role" in message &&
                  message.role === "user" &&
                  "content" in message &&
                  JSON.stringify(message.content).includes(description) &&
                  JSON.stringify(message.content).includes("角色：explore"),
              ),
          );
          if (childIndex < 0) throw new Error("真实子请求不可识别");
          let current = await snapshot(fixture, host.sessionId);
          const child = current.rows.window.find(
            (row) => row.kind === "subagent",
          );
          if (child?.kind !== "subagent" || !child.childSessionId)
            throw new Error("真实child派发缺失");
          if (detached) {
            const parentIndex = model.requests.findIndex(
              (_request, index) => index > 0 && index !== childIndex,
            );
            if (parentIndex < 0) throw new Error("父续轮请求缺失");
            model.finish(parentIndex);
            current = await waitPhase(
              fixture,
              host.sessionId,
              "completedSuccess",
            );
            expect(
              (await snapshot(fixture, child.childSessionId)).control.phase,
            ).toBe("running");
            expect(model.requests[childIndex]?.closed).toBe(false);
            const work = current.backgroundWorks.find(
              (item) =>
                item.childSessionId === child.childSessionId &&
                item.status === "running",
            );
            if (!work) throw new Error("真实后台工作不再running");
            const stopped = await host.command("cancelBackgroundWork", {
              workId: work.workId,
            });
            expect(
              stopped.body.result,
              JSON.stringify(stopped.body),
            ).toMatchObject({ status: "accepted" });
          } else {
            const execution = current.control.activeWorks.find(
              (work) => work.kind === "primaryTurn",
            )?.foregroundExecutionId;
            if (!execution) throw new Error("父前台身份缺失");
            const stopped = await host.command("stop", {
              expectedForegroundExecutionId: execution,
            });
            expect(
              stopped.body.result,
              JSON.stringify(stopped.body),
            ).toMatchObject({ status: "accepted" });
            await waitPhase(fixture, host.sessionId, "completedInterrupted");
          }
          await vi.waitFor(
            () => expect(model.requests[childIndex]?.closed).toBe(true),
            { timeout: 30_000 },
          );
          const ended = await snapshot(fixture, child.childSessionId);
          expect(ended.control.phase).toBe("completedInterrupted");
          expect(ended.control.canStop).toBe(false);
          // 真子checkpoint写在自己的root namespace，不沿父Pregel工具namespace恢复。
          const namespaces = await fixture.database.persistence.query<{
            checkpoint_ns: string;
          }>(
            "select distinct checkpoint_ns from langgraph.checkpoints where thread_id=$1",
            [`code-child:${child.childSessionId}`],
          );
          expect(namespaces.map((row) => row.checkpoint_ns)).toContain("");
        } finally {
          if (host) await host.dispose();
          await model.close();
          await fixture.close();
        }
      },
      90_000,
    );
  },
);
