import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { restartCodeUiHttpFixture } from "./code-ui-restart.fixture.js";
import {
  type Host,
  sendToTask,
  snapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

function taskIdOf(row: protocol.ConversationRow) {
  const input = row.kind === "toolCall" ? row.input : null;
  return input &&
    typeof input === "object" &&
    "task_id" in input &&
    typeof input.task_id === "string"
    ? input.task_id
    : undefined;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "继承完整子输出独立归属 integration",
  () => {
    it("分叉后父删除与源日志消失，实际TaskOutput仍读完整子结果且不继承停止权限", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await heldModel({
        initialTool: {
          id: "child-full-output",
          name: "Task",
          arguments: {
            subagent_type: "explore",
            description: "CHILD_WITH_LONG_PRIVATE_RESULT",
            ownership: ["."],
            completion_criteria: "返回完整结果",
            run_in_background: false,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        expect(
          (
            await host.client.request(
              "/api/instance/settings",
              { processPreviewMaxChars: 128 },
              "PATCH",
            )
          ).status,
        ).toBe(200);
        await host.command("sendText", {
          text: "PARENT_WITH_COMPLETE_CHILD_LOG",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const long = `FULL_CHILD_RESULT_${"x".repeat(300)}_PRIVATE_TAIL`;
        model.writeText(1, long);
        model.finish(1);
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        model.finish(2);
        const source = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const tool = source.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Task",
        );
        if (tool?.kind !== "toolCall" || !tool.output?.text)
          throw new Error("实际Task结果缺失");
        const result = JSON.parse(tool.output.text);
        expect(result.summary).not.toContain("PRIVATE_TAIL");
        const assistant = source.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId) throw new Error("实际父回复缺失");
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
          randomUUID(),
          { baseRevision: source.revision, baseLogEpoch: source.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("继承Task创建失败");
        const forkId = ack.result.sessionId;
        const copied = await snapshot(fixture, forkId);
        const copiedTool = copied.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Task",
        );
        if (copiedTool?.kind !== "toolCall" || !copiedTool.output?.text)
          throw new Error("继承Task结果缺失");
        const inherited = JSON.parse(copiedTool.output.text);
        expect(inherited.taskId).not.toBe(result.taskId);
        expect(inherited.outputPath).not.toBe(result.outputPath);
        expect(inherited.outputPath).toContain(forkId);
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
        // 公开删除已清理源宿主日志，副本不能再依赖该缓存。
        if (
          typeof result.outputPath !== "string" ||
          !result.outputPath.startsWith(fixture.directory)
        )
          throw new Error("源日志不在独占fixture内");
        await expect(readFile(result.outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        tools[3] = {
          id: "read-copied-child-output",
          name: "TaskOutput",
          arguments: { task_id: inherited.taskId, offset: 0, max_bytes: 4096 },
        };
        expect(
          (await sendToTask(host, forkId, "READ_INHERITED_COMPLETE_OUTPUT"))
            .body.result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(5), {
          timeout: 30_000,
        });
        const nativeMessages = JSON.stringify(model.requests[3]?.body.messages);
        expect(nativeMessages).toContain(inherited.outputPath);
        expect(nativeMessages).not.toContain(result.outputPath);
        const reading = await snapshot(fixture, forkId);
        const outputRow = reading.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "TaskOutput",
        );
        if (outputRow?.kind !== "toolCall" || !outputRow.output?.text)
          throw new Error("实际TaskOutput结果缺失");
        expect(outputRow.status, outputRow.output.text).toBe("success");
        const output = JSON.parse(outputRow.output.text);
        expect(output.output.data).toBe(`正在运行 2${long}`);
        expect(output.output.done).toBe(true);
        expect(output.output.discardedBytes).toBe(0);
        expect(output.outputRef).toBe(inherited.outputPath);
        model.finish(4);
        await waitPhase(fixture, forkId, "completedSuccess");
        const stop = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              sessionId: forkId,
              clientId: host.clientId,
              commandId: randomUUID(),
              type: "cancelBackgroundWork",
              payload: { workId: inherited.taskId },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(stop.body.result.status).toBe("failed");
        expect((await snapshot(fixture, forkId)).backgroundWorks).toEqual([]);
        expect(model.requests).toHaveLength(5);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "继承前台命令完整输出 integration",
  () => {
    it("真实沙箱Bash日志独立复制，TaskOutput公开发现只读ID后读取完整字节", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const text = `FULL_BASH_RESULT_${"b".repeat(300)}_PRIVATE_TAIL_中文`;
      const model = await heldModel({
        initialTool: {
          id: "source-bash-log",
          name: "Bash",
          arguments: {
            command: `printf '%s' '${text}'`,
            run_in_background: false,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      let cold:
        | Awaited<ReturnType<typeof restartCodeUiHttpFixture>>
        | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        expect(
          (
            await host.client.request(
              "/api/instance/settings",
              { processPreviewMaxChars: 128 },
              "PATCH",
            )
          ).status,
        ).toBe(200);
        await host.command("sendText", { text: "CREATE_BASH_CAPTURE" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const source = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const bash = source.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Bash",
        );
        if (bash?.kind !== "toolCall" || !bash.output?.text)
          throw new Error("真实Bash结果缺失");
        const result = JSON.parse(bash.output.text);
        expect(bash.status, bash.output.text).toBe("success");
        expect(result.state).toBe("exited");
        expect(result.output).not.toContain("PRIVATE_TAIL");
        expect(result.retainedBytes).toBe(Buffer.byteLength(text));
        const assistant = source.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId) throw new Error("父完成回复缺失");
        const fork = await host.command(
          "forkAssistant",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
          randomUUID(),
          { baseRevision: source.revision, baseLogEpoch: source.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(fork.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("命令历史分叉失败");
        const forkId = ack.result.sessionId;
        const copied = await snapshot(fixture, forkId);
        const copiedBash = copied.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Bash",
        );
        if (copiedBash?.kind !== "toolCall" || !copiedBash.output?.text)
          throw new Error("复制Bash行缺失");
        const copiedResult = JSON.parse(copiedBash.output.text);
        expect(copiedResult.outputPath).not.toBe(result.outputPath);
        expect(copiedResult.outputPath).toContain(forkId);
        expect(copiedBash.output.display).toMatchObject({
          outputPath: copiedResult.outputPath,
        });
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
        await expect(readFile(result.outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        tools[2] = {
          id: "discover-history-output",
          name: "TaskOutput",
          arguments: {},
        };
        await sendToTask(host, forkId, "LIST_READONLY_OUTPUTS");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        const discovering = await snapshot(fixture, forkId);
        const listRow = discovering.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "TaskOutput",
        );
        if (listRow?.kind !== "toolCall" || !listRow.output?.text)
          throw new Error("实际只读输出发现缺失");
        const list = JSON.parse(listRow.output.text);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          kind: "command",
          status: "completed",
          readOnly: true,
        });
        const outputId = list[0].taskId;
        model.finish(3);
        await waitPhase(fixture, forkId, "completedSuccess");
        tools[4] = {
          id: "read-history-bash",
          name: "TaskOutput",
          arguments: { task_id: outputId, offset: 0, max_bytes: 4096 },
        };
        await sendToTask(host, forkId, "READ_COMPLETE_BASH_LOG");
        await vi.waitFor(() => expect(model.requests).toHaveLength(6), {
          timeout: 30_000,
        });
        const reading = await snapshot(fixture, forkId);
        const read = reading.rows.window.find(
          (row) =>
            row.kind === "toolCall" &&
            row.toolName === "TaskOutput" &&
            taskIdOf(row) === outputId,
        );
        if (read?.kind !== "toolCall" || !read.output?.text)
          throw new Error("完整Bash读取缺失");
        const output = JSON.parse(read.output.text);
        expect(read.status, read.output.text).toBe("success");
        expect(output.output.data).toBe(text);
        expect(output.output.retainedBytes).toBe(Buffer.byteLength(text));
        expect(output.outputRef).toBe(copiedResult.outputPath);
        expect(JSON.stringify(model.requests[4]?.body.messages)).not.toContain(
          result.outputPath,
        );
        model.finish(5);
        await waitPhase(fixture, forkId, "completedSuccess");
        expect((await snapshot(fixture, forkId)).backgroundWorks).toEqual([]);
        const beforeGrand = await snapshot(fixture, forkId);
        const lastAssistant = [...beforeGrand.rows.window]
          .reverse()
          .find(
            (row) => row.kind === "assistantText" && row.state === "complete",
          );
        if (!lastAssistant?.entityId) throw new Error("完整读取后的回复缺失");
        const next = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: forkId,
              clientId: host.clientId,
              commandId: randomUUID(),
              issuedAt: Date.now(),
              baseRevision: beforeGrand.revision,
              baseLogEpoch: beforeGrand.logEpoch,
              payload: {
                target: {
                  rowId: lastAssistant.rowId,
                  entityId: lastAssistant.entityId,
                },
              },
            },
          },
        ]);
        const nextAck = protocol.commandAckSchema.parse(next.body.result);
        expect(nextAck.status, JSON.stringify(nextAck)).toBe("accepted");
        if (nextAck.result?.type !== "forkAssistant")
          throw new Error("再次完整输出分叉失败");
        const grandId = nextAck.result.sessionId;
        const grand = await snapshot(fixture, grandId);
        const grandRead = grand.rows.window.find(
          (row) =>
            row.kind === "toolCall" &&
            row.toolName === "TaskOutput" &&
            taskIdOf(row),
        );
        if (grandRead?.kind !== "toolCall" || !grandRead.output?.text)
          throw new Error("孙Task读取映射缺失");
        const grandOutput = JSON.parse(grandRead.output.text);
        const grandOutputId = taskIdOf(grandRead);
        if (!grandOutputId) throw new Error("孙Task只读输出身份缺失");
        expect(grandOutputId).not.toBe(outputId);
        expect(grandOutput.outputRef).not.toBe(copiedResult.outputPath);
        expect(grandOutput.outputRef).toContain(grandId);
        expect(
          (
            await host.client.request("/api/code-ui/rpc", {
              service: "zcode-task",
              method: "deleteTask",
              args: [{ taskId: forkId, workspacePath: host.workspacePath }],
            })
          ).status,
        ).toBe(200);
        tools[6] = {
          id: "read-grand-bash",
          name: "TaskOutput",
          arguments: { task_id: grandOutputId, offset: 0, max_bytes: 4096 },
        };
        await sendToTask(host, grandId, "READ_AFTER_BOTH_ANCESTORS_DELETED");
        await vi.waitFor(() => expect(model.requests).toHaveLength(8), {
          timeout: 30_000,
        });
        const currentGrand = await snapshot(fixture, grandId);
        const actual = [...currentGrand.rows.window]
          .reverse()
          .find(
            (row) =>
              row.kind === "toolCall" &&
              row.toolName === "TaskOutput" &&
              taskIdOf(row) === grandOutputId,
          );
        if (actual?.kind !== "toolCall" || !actual.output?.text)
          throw new Error("孙Task实际读取缺失");
        expect(actual.status, actual.output.text).toBe("success");
        expect(JSON.parse(actual.output.text).output.data).toBe(text);
        model.finish(7);
        await waitPhase(fixture, grandId, "completedSuccess");
        const activeHost = host;
        cold = await restartCodeUiHttpFixture(fixture);
        const coldClient = cold.client;
        const connectionId = cold.stream.ready.hello.connectionId;
        activeHost.client.request = (path, body, method) =>
          coldClient.request(
            path,
            path === "/api/code-ui/rpc" && body && typeof body === "object"
              ? { ...body, connectionId }
              : body,
            method,
          );
        const coldHost = {
          ...activeHost,
          stream: cold.stream,
          clientId: cold.clientId,
        };
        const restored = await snapshot(fixture, grandId);
        expect(restored.backgroundWorks).toEqual([]);
        expect(model.requests).toHaveLength(8);
        tools[8] = {
          id: "read-cold-output",
          name: "TaskOutput",
          arguments: { task_id: grandOutputId, offset: 0, max_bytes: 4096 },
        };
        await sendToTask(coldHost, grandId, "READ_AFTER_FULL_SERVICE_RESTART");
        await vi.waitFor(() => expect(model.requests).toHaveLength(10), {
          timeout: 30_000,
        });
        const afterCold = await snapshot(fixture, grandId);
        const coldRead = [...afterCold.rows.window]
          .reverse()
          .find(
            (row) =>
              row.kind === "toolCall" &&
              row.toolName === "TaskOutput" &&
              taskIdOf(row) === grandOutputId,
          );
        if (coldRead?.kind !== "toolCall" || !coldRead.output?.text)
          throw new Error("冷恢复真实读取缺失");
        expect(coldRead.status, coldRead.output.text).toBe("success");
        expect(JSON.parse(coldRead.output.text).output.data).toBe(text);
        model.finish(9);
        await waitPhase(fixture, grandId, "completedSuccess");
        const keep = await coldClient.request(
          "/api/instance/settings",
          { compactKeepMessages: 2, autoCompactEnabled: false },
          "PATCH",
        );
        expect(keep.status, JSON.stringify(keep.body)).toBe(200);
        const compacted = await cold.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "compact",
              sessionId: grandId,
              clientId: cold.clientId,
              commandId: randomUUID(),
              issuedAt: Date.now(),
              payload: {},
            },
          },
        ]);
        expect(compacted.body.result.status).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(11), {
          timeout: 30_000,
        });
        model.finish(10);
        await waitPhase(fixture, grandId, "completedSuccess");
        tools[11] = {
          id: "read-after-real-compact",
          name: "TaskOutput",
          arguments: { task_id: grandOutputId, offset: 0, max_bytes: 4096 },
        };
        await sendToTask(coldHost, grandId, "READ_AFTER_NEW_NATIVE_SUMMARY");
        await vi.waitFor(() => expect(model.requests).toHaveLength(13), {
          timeout: 30_000,
        });
        const afterSummary = await snapshot(fixture, grandId);
        const summaryRead = [...afterSummary.rows.window]
          .reverse()
          .find(
            (row) =>
              row.kind === "toolCall" &&
              row.toolName === "TaskOutput" &&
              taskIdOf(row) === grandOutputId,
          );
        if (summaryRead?.kind !== "toolCall" || !summaryRead.output?.text)
          throw new Error("新摘要后的输出读取缺失");
        expect(summaryRead.status, summaryRead.output.text).toBe("success");
        expect(JSON.parse(summaryRead.output.text).output.data).toBe(text);
        const modelContext = JSON.stringify(model.requests[11]?.body.messages);
        expect(modelContext).toContain("正在运行 11");
        expect(modelContext).toContain("<history-outputs>");
        expect(modelContext).toContain(grandOutputId);
        expect(modelContext).toContain(grandOutput.outputRef);
        model.finish(12);
        await waitPhase(fixture, grandId, "completedSuccess");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await cold?.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
