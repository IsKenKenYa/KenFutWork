import { randomUUID } from "node:crypto";
import { readFile, truncate, writeFile } from "node:fs/promises";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  type Host,
  sendToTask,
  snapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "运行中输出的历史截点独立归属 integration",
  () => {
    it("真实TaskOutput字节截点之后源继续写入，旧回复分叉不复制尾部，父删除后仍读独立只读副本", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await heldModel({
        initialTool: {
          id: "live-cutoff-bash",
          name: "Bash",
          arguments: {
            command:
              "printf 'VISIBLE_PREFIX_中文🙂\\n'; IFS= read -r line; printf 'AFTER_VISIBLE:%s\\n' \"$line\"; IFS= read -r tail; printf 'AFTER_FORK:%s\\n' \"$tail\"",
            run_in_background: true,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const currentHost = host;
        await host.command("sendText", { text: "START_LIVE_HISTORY_OUTPUT" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const started = await snapshot(fixture, host.sessionId);
        const work = started.backgroundWorks.find(
          (entry) => entry.kind === "bash" && entry.status === "running",
        );
        if (!work) throw new Error("真实运行中命令缺失");
        const query = {
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          workId: work.workId,
        };
        await vi.waitFor(
          async () =>
            expect(
              (await currentHost.stream.rpc("backgroundBashOutputV4", [query]))
                .body.result,
            ).toMatchObject({
              output: "VISIBLE_PREFIX_中文🙂\n",
              status: "running",
            }),
          { timeout: 30_000 },
        );
        model.finish(1);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        tools[2] = {
          id: "read-live-prefix",
          name: "TaskOutput",
          arguments: { task_id: work.workId, offset: 0, max_bytes: 4096 },
        };
        await host.command("sendText", {
          text: "OBSERVE_RUNNING_OUTPUT_PREFIX",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        model.finish(3);
        const observed = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const outputRow = observed.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "TaskOutput",
        );
        if (outputRow?.kind !== "toolCall" || !outputRow.output?.text)
          throw new Error("真实TaskOutput观察缺失");
        const visible = JSON.parse(outputRow.output.text);
        expect(visible.status).toBe("running");
        expect(visible.output).toMatchObject({
          data: "VISIBLE_PREFIX_中文🙂\n",
          done: false,
          retainedBytes: Buffer.byteLength("VISIBLE_PREFIX_中文🙂\n"),
        });
        const target = observed.rows.window.find(
          (row) =>
            row.kind === "assistantText" &&
            row.turnId === outputRow.turnId &&
            row.state === "complete",
        );
        if (!target?.entityId) throw new Error("观察输出后的实际回复缺失");
        tools[4] = {
          id: "advance-after-visible",
          name: "TaskInput",
          arguments: {
            task_id: work.workId,
            data: "MUST_NOT_ENTER_FORK\n",
            close: false,
          },
        };
        await host.command("sendText", {
          text: "ADVANCE_SOURCE_AFTER_OBSERVATION",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(6), {
          timeout: 30_000,
        });
        model.finish(5);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        await vi.waitFor(
          async () =>
            expect(
              (await currentHost.stream.rpc("backgroundBashOutputV4", [query]))
                .body.result,
            ).toMatchObject({
              status: "running",
              output: expect.stringContaining("MUST_NOT_ENTER_FORK"),
            }),
          { timeout: 30_000 },
        );
        const current = await snapshot(fixture, host.sessionId);
        const list = async () =>
          (
            await currentHost.client.request("/api/code-ui/rpc", {
              service: "zcode-task",
              method: "listTasks",
              args: [
                {
                  workspacePath: currentHost.workspacePath,
                  projectId: currentHost.projectId,
                },
              ],
            })
          ).body.result;
        const beforeList = await list();
        const original = await readFile(visible.outputRef);
        await truncate(visible.outputRef, 1);
        const rejectedId = randomUUID();
        const targetPayload = {
          target: { rowId: target.rowId, entityId: target.entityId },
        };
        const guard = {
          baseRevision: current.revision,
          baseLogEpoch: current.logEpoch,
        };
        const rejected = await host.command(
          "forkAssistant",
          targetPayload,
          rejectedId,
          guard,
        );
        expect(rejected.body.result).toMatchObject({
          status: "failed",
          reasonCode: "fork_failed",
          message: expect.stringContaining("字节事实"),
        });
        expect(await list()).toEqual(beforeList);
        await writeFile(visible.outputRef, original);
        const replay = await host.command(
          "forkAssistant",
          targetPayload,
          rejectedId,
          guard,
        );
        expect(replay.body.result).toMatchObject({
          status: "duplicate",
          message: rejected.body.result.message,
        });
        expect(await list()).toEqual(beforeList);
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: target.rowId, entityId: target.entityId } },
          randomUUID(),
          { baseRevision: current.revision, baseLogEpoch: current.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("输出截点分叉没有发表");
        const forkId = ack.result.sessionId;
        const copied = await snapshot(fixture, forkId);
        const copiedRow = copied.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "TaskOutput",
        );
        if (copiedRow?.kind !== "toolCall" || !copiedRow.output?.text)
          throw new Error("副本观察行缺失");
        const frozen = JSON.parse(copiedRow.output.text);
        expect(frozen.taskId).not.toBe(work.workId);
        expect(frozen.outputRef).toMatch(/^code-output:/);
        const denied = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              sessionId: forkId,
              clientId: host.clientId,
              commandId: randomUUID(),
              type: "cancelBackgroundWork",
              payload: { workId: frozen.taskId },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(denied.body.result.status).toBe("failed");
        expect((await snapshot(fixture, forkId)).backgroundWorks).toEqual([]);
        expect(
          (await currentHost.stream.rpc("backgroundBashOutputV4", [query])).body
            .result,
        ).toMatchObject({ status: "running" });
        expect(
          (
            await host.client.request("/api/code-ui/rpc", {
              service: "zcode-task",
              method: "deleteTask",
              args: [
                { taskId: host.sessionId, workspacePath: host.workspacePath },
              ],
            })
          ).status,
        ).toBe(200);
        await expect(readFile(visible.outputRef)).rejects.toMatchObject({
          code: "ENOENT",
        });
        tools[6] = {
          id: "read-frozen-prefix",
          name: "TaskOutput",
          arguments: { task_id: frozen.taskId, offset: 0, max_bytes: 4096 },
        };
        expect(
          (await sendToTask(host, forkId, "READ_FROZEN_PREFIX_ONLY")).body
            .result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(8), {
          timeout: 30_000,
        });
        const reading = await snapshot(fixture, forkId);
        const resultRow = reading.rows.window.find(
          (row) =>
            row.kind === "toolCall" &&
            row.toolName === "TaskOutput" &&
            row.toolCallId !== copiedRow.toolCallId,
        );
        if (resultRow?.kind !== "toolCall" || !resultRow.output?.text)
          throw new Error("实际副本读取缺失");
        const result = JSON.parse(resultRow.output.text);
        expect(result.output).toMatchObject({
          data: "VISIBLE_PREFIX_中文🙂\n",
          done: true,
          retainedBytes: visible.output.retainedBytes,
        });
        expect(result.statisticsComplete).toBe(false);
        expect(result.readOnly).toBe(true);
        expect(result.frozenAt).toEqual({
          sourceStatus: "running",
          outputStats: {
            retainedBytes: visible.output.retainedBytes,
            totalBytes: visible.output.totalBytes,
            discardedBytes: visible.output.discardedBytes,
          },
        });
        expect(result.output.data).not.toContain("MUST_NOT_ENTER_FORK");
        expect(JSON.stringify(model.requests[6]?.body.messages)).toContain(
          frozen.outputRef,
        );
        expect(JSON.stringify(model.requests[6]?.body.messages)).not.toContain(
          visible.outputRef,
        );
        model.finish(7);
        const ended = await waitPhase(fixture, forkId, "completedSuccess");
        const nextTarget = ended.rows.window.find(
          (row) =>
            row.kind === "assistantText" &&
            row.turnId === resultRow.turnId &&
            row.state === "complete",
        );
        if (!nextTarget?.entityId) throw new Error("副本读取后的回复缺失");
        const again = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: forkId,
              commandId: randomUUID(),
              clientId: host.clientId,
              payload: {
                target: {
                  rowId: nextTarget.rowId,
                  entityId: nextTarget.entityId,
                },
              },
              baseRevision: ended.revision,
              baseLogEpoch: ended.logEpoch,
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(
          again.body.result.status,
          JSON.stringify(again.body.result),
        ).toBe("accepted");
        const grandId = again.body.result.result.sessionId;
        const grand = await snapshot(fixture, grandId);
        const grandRow = grand.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "TaskOutput",
        );
        if (grandRow?.kind !== "toolCall" || !grandRow.output?.text)
          throw new Error("再次分叉观察缺失");
        const grandOutput = JSON.parse(grandRow.output.text);
        expect(grandOutput.taskId).not.toBe(frozen.taskId);
        expect(
          (
            await host.client.request("/api/code-ui/rpc", {
              service: "zcode-task",
              method: "deleteTask",
              args: [{ taskId: forkId, workspacePath: host.workspacePath }],
            })
          ).status,
        ).toBe(200);
        const view = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, sessionId: grandId, workId: grandOutput.taskId },
        ]);
        expect(view.body.result).toMatchObject({
          kind: "output",
          output: "VISIBLE_PREFIX_中文🙂\n",
        });
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 180_000);
  },
);
