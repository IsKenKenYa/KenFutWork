import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { zcodeSessionSubagentsResultSchema } from "@zcode/shared";
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
  "子会话转录继承独立归属 integration",
  () => {
    it("原直接子目录按结束二元键分页，非法cursor回首页且错误目录/limit拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      const dispatch = (id: string, description: string) => ({
        id,
        name: "Task",
        arguments: {
          subagent_type: "explore",
          description,
          ownership: ["."],
          completion_criteria: "返回结果",
          run_in_background: false,
        },
      });
      const model = await heldModel({
        initialTool: dispatch("directory-child-a", "DIRECTORY_CHILD_A"),
        toolsByRequest: {
          2: dispatch("directory-child-b", "DIRECTORY_CHILD_B"),
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: "TWO_DIRECT_CHILDREN" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        model.finish(3);
        await vi.waitFor(() => expect(model.requests).toHaveLength(5), {
          timeout: 30_000,
        });
        model.finish(4);
        const root = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const childRows = root.rows.window.filter(
          (row) => row.kind === "subagent",
        );
        expect(childRows).toHaveLength(2);
        const query = {
          sessionId: host.sessionId,
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          endedLimit: 1,
        };
        const first = await host.stream.rpc("listSessionSubagents", [query]);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        const page = zcodeSessionSubagentsResultSchema.parse(first.body.result);
        expect(page.running).toEqual([]);
        expect(page.ended.total).toBe(2);
        expect(page.ended.items).toHaveLength(1);
        if (!page.ended.nextCursor)
          throw new Error("两条ended首屏没有下一页cursor");
        const second = await host.stream.rpc("listSessionSubagents", [
          { ...query, endedCursor: page.ended.nextCursor },
        ]);
        expect(second.status).toBe(200);
        const next = zcodeSessionSubagentsResultSchema.parse(
          second.body.result,
        );
        expect(next.ended.items).toHaveLength(1);
        expect(next.ended.items[0]?.childSessionId).not.toBe(
          page.ended.items[0]?.childSessionId,
        );
        expect(next.ended.nextCursor).toBeUndefined();
        expect(next.childSessionIds).toEqual(page.childSessionIds);
        const invalid = await host.stream.rpc("listSessionSubagents", [
          { ...query, endedCursor: "invalid-base64-json" },
        ]);
        expect(invalid.status).toBe(200);
        expect(
          zcodeSessionSubagentsResultSchema.parse(invalid.body.result).ended,
        ).toEqual(page.ended);
        expect(
          (
            await host.stream.rpc("listSessionSubagents", [
              { ...query, endedLimit: 0 },
            ])
          ).status,
        ).toBe(400);
        expect(
          (
            await host.stream.rpc("listSessionSubagents", [
              { ...query, workspacePath: `${host.workspacePath}-foreign` },
            ])
          ).status,
        ).toBe(404);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("嵌套worker子树及孙真实Write详情随分叉独立读取，父删除后无文件回退权限", async () => {
      const fixture = await createCodeUiHttpFixture();
      const dispatch = (id: string, description: string) => ({
        id,
        name: "Task",
        arguments: {
          subagent_type: "worker",
          description,
          ownership: ["."],
          completion_criteria: "报告实现证据",
          run_in_background: false,
        },
      });
      const model = await heldModel({
        initialTool: dispatch("nested-parent-task", "NESTED_WORKER_ONE"),
        toolsByRequest: {
          1: dispatch("nested-child-task", "NESTED_WORKER_TWO"),
          2: {
            id: "nested-real-write",
            name: "Write",
            arguments: {
              file_path: "nested-copy.txt",
              content: "NESTED_REAL_WRITE\n",
              create_only: true,
            },
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "edit", planEnabled: false },
        });
        const depth = await host.client.request(
          "/api/instance/settings",
          { subagentMaxDepth: 2 },
          "PATCH",
        );
        expect(depth.status, JSON.stringify(depth.body)).toBe(200);
        await host.command("sendText", { text: "ROOT_NESTED_TASK" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        expect(
          await readFile(join(host.workspacePath, "nested-copy.txt"), "utf8"),
        ).toBe("NESTED_REAL_WRITE\n");
        model.finish(3);
        await vi.waitFor(() => expect(model.requests).toHaveLength(5), {
          timeout: 30_000,
        });
        model.finish(4);
        const beforeParentContinue = host;
        await vi.waitFor(
          async () =>
            expect(
              model.requests,
              JSON.stringify(await beforeParentContinue.snapshot()),
            ).toHaveLength(6),
          {
            timeout: 30_000,
          },
        );
        model.finish(5);
        const root = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const reply = root.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!reply?.entityId) throw new Error("嵌套父回复缺失");
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: reply.rowId, entityId: reply.entityId } },
          randomUUID(),
          { baseRevision: root.revision, baseLogEpoch: root.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("嵌套分叉Root缺失");
        const copiedRoot = await snapshot(fixture, ack.result.sessionId);
        const first = copiedRoot.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (first?.kind !== "subagent" || !first.childSessionId)
          throw new Error("第一级复制缺失");
        const copiedFirst = await snapshot(fixture, first.childSessionId);
        const second = copiedFirst.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (second?.kind !== "subagent" || !second.childSessionId)
          throw new Error("第二级复制缺失");
        const removed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
        });
        expect(removed.status).toBe(200);
        const leaf = await snapshot(fixture, second.childSessionId);
        expect(JSON.stringify(leaf.rows.window)).toContain("正在运行 4");
        const header = leaf.rows.window.find(
          (row) => row.kind === "turnHeader",
        );
        if (!header?.entityId) throw new Error("孙Write header缺失");
        expect(header.actions?.canRewindFiles).toBeUndefined();
        const marker = join(host.workspacePath, "nested-copy.txt");
        await writeFile(marker, "CURRENT_FILE_MUST_REMAIN");
        const details = await host.stream.rpc("conversationFileChangesV4", [
          {
            sessionId: second.childSessionId,
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            target: { rowId: header.rowId, entityId: header.entityId },
            baseRevision: leaf.revision,
            baseLogEpoch: leaf.logEpoch,
          },
        ]);
        expect(details.status, JSON.stringify(details.body)).toBe(200);
        expect(
          protocol.v4ConversationFileChangesResultSchema.parse(
            details.body.result,
          ).items,
        ).toMatchObject([
          {
            path: marker,
            writeCount: 1,
            patches: [{ lines: ["+NESTED_REAL_WRITE"] }],
          },
        ]);
        expect(await readFile(marker, "utf8")).toBe("CURRENT_FILE_MUST_REMAIN");
        const directory = await host.stream.rpc("listSessionSubagents", [
          {
            sessionId: first.childSessionId,
            workspacePath: host.workspacePath,
            projectId: host.projectId,
          },
        ]);
        expect(directory.status).toBe(200);
        expect(
          zcodeSessionSubagentsResultSchema.parse(directory.body.result)
            .childSessionIds,
        ).toEqual([second.childSessionId]);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
    it("A完成后后台子继续输出，旧A分叉只复制当时截点，源执行不被停止", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "fork-detached-child",
          name: "Task",
          arguments: {
            subagent_type: "explore",
            description: "FROZEN_BACKGROUND_CHILD",
            ownership: ["."],
            completion_criteria: "报告调研",
            run_in_background: true,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await host.command("sendText", { text: "PARENT_A_BACKGROUND" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
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
                JSON.stringify(message.content).includes(
                  "FROZEN_BACKGROUND_CHILD",
                ) &&
                JSON.stringify(message.content).includes("角色：explore"),
            ),
        );
        const parentIndex = model.requests.findIndex(
          (_request, index) => index > 0 && index !== childIndex,
        );
        if (childIndex < 0 || parentIndex < 0)
          throw new Error("真实主子模型未可识别");
        if (childIndex === parentIndex) throw new Error("模型识别重合");
        model.finish(parentIndex);
        const a = await waitPhase(fixture, host.sessionId, "completedSuccess");
        const dispatch = a.rows.window.find((row) => row.kind === "subagent");
        if (dispatch?.kind !== "subagent" || !dispatch.childSessionId)
          throw new Error("后台子身份缺失");
        const captured = await snapshot(fixture, dispatch.childSessionId);
        expect(
          captured.control.phase,
          JSON.stringify({
            captured,
            root: a,
            childIndex,
            parentIndex,
            streams: model.requests.map((request) => ({
              closed: request.closed,
            })),
          }),
        ).toBe("running");
        model.writeText(childIndex, "CHILD_AFTER_A_MUST_NOT_LEAK");
        const currentHost = host;
        const sourceChildId = dispatch.childSessionId;
        await vi.waitFor(
          async () =>
            expect(
              JSON.stringify(
                (await snapshot(fixture, sourceChildId)).rows.window,
              ),
            ).toContain("CHILD_AFTER_A_MUST_NOT_LEAK"),
          { timeout: 30_000 },
        );
        const current = protocol.conversationSnapshotSchema.parse(
          await currentHost.snapshot(),
        );
        const assistant = current.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId) throw new Error("A回复缺失");
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
          randomUUID(),
          { baseRevision: current.revision, baseLogEpoch: current.logEpoch },
        );
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("截点分叉根缺失");
        const fork = await snapshot(fixture, ack.result.sessionId);
        const inheritedRow = fork.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (inheritedRow?.kind !== "subagent" || !inheritedRow.childSessionId)
          throw new Error("截点子转录缺失");
        const inherited = await snapshot(fixture, inheritedRow.childSessionId);
        expect(JSON.stringify(inherited.rows.window)).not.toContain(
          "CHILD_AFTER_A_MUST_NOT_LEAK",
        );
        expect(inherited.control).toMatchObject({
          phase: "completedInterrupted",
          activeWorks: [],
          canStop: false,
          lastError: {
            code: "guard.historyCutoff",
            message: expect.stringContaining("源子代理仍"),
          },
        });
        expect(model.requests[childIndex]?.closed).toBe(false);
        expect((await snapshot(fixture, sourceChildId)).control.phase).toBe(
          "running",
        );
        model.writeText(childIndex, "CHILD_AFTER_FORK_ALSO_NOT_LEAK");
        model.finish(childIndex);
        await waitPhase(fixture, sourceChildId, "completedSuccess");
        expect(
          JSON.stringify(
            (await snapshot(fixture, inheritedRow.childSessionId)).rows.window,
          ),
        ).not.toContain("CHILD_AFTER_FORK_ALSO_NOT_LEAK");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
    it("实际Task子模型完成后分叉并删除父，分叉Task可独立打开子转录而无运行/停止权限", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "fork-real-child",
          name: "Task",
          arguments: {
            subagent_type: "explore",
            description: "CHILD_TRANSCRIPT_REAL_EVIDENCE",
            ownership: ["."],
            completion_criteria: "报告真实子转录证据",
            run_in_background: false,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        expect(
          (await host.command("sendText", { text: "PARENT_WITH_REAL_CHILD" }))
            .body.result.status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const childMessages = JSON.stringify(model.requests[1]?.body.messages);
        expect(childMessages).toContain("CHILD_TRANSCRIPT_REAL_EVIDENCE");
        expect(childMessages).toContain("explore");
        model.finish(1);
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[2]?.body.messages)).toContain(
          "正在运行 2",
        );
        model.finish(2);
        const parent = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const dispatch = parent.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (dispatch?.kind !== "subagent" || !dispatch.childSessionId)
          throw new Error("真实子派发行缺失");
        expect(dispatch.status).toBe("success");
        const originalChild = await snapshot(fixture, dispatch.childSessionId);
        expect(originalChild.control.phase).toBe("completedSuccess");
        expect(JSON.stringify(originalChild.rows.window)).toContain(
          "正在运行 2",
        );
        const assistant = [...parent.rows.window]
          .reverse()
          .find(
            (row) => row.kind === "assistantText" && row.state === "complete",
          );
        if (!assistant?.entityId) throw new Error("父完成回复缺失");
        const forked = await host.command(
          "forkAssistant",
          { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
          randomUUID(),
          { baseRevision: parent.revision, baseLogEpoch: parent.logEpoch },
        );
        expect(forked.status, JSON.stringify(forked.body)).toBe(200);
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("分叉根Task缺失");
        const forkId = ack.result.sessionId;
        const copied = await snapshot(fixture, forkId);
        const childRow = copied.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (childRow?.kind !== "subagent" || !childRow.childSessionId)
          throw new Error("分叉子派发行缺失");
        expect(childRow.childSessionId).not.toBe(dispatch.childSessionId);
        expect(childRow.workId).toBeUndefined();
        const removed = await host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "deleteTask",
          args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
        });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        const inheritedChild = await snapshot(fixture, childRow.childSessionId);
        expect(JSON.stringify(inheritedChild.rows.window)).toContain(
          "正在运行 2",
        );
        expect(inheritedChild.control).toMatchObject({
          phase: "completedSuccess",
          canStop: false,
          activeWorks: [],
        });
        expect(inheritedChild.pendingInteractions).toEqual([]);
        expect(inheritedChild.queue.items).toEqual([]);
        expect(inheritedChild.backgroundWorks).toEqual([]);
        const directory = await host.stream.rpc("listSessionSubagents", [
          {
            sessionId: forkId,
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            endedLimit: 1,
          },
        ]);
        expect(directory.status, JSON.stringify(directory.body)).toBe(200);
        const items = zcodeSessionSubagentsResultSchema.parse(
          directory.body.result,
        );
        expect(items.childSessionIds).toEqual([childRow.childSessionId]);
        expect(items.running).toEqual([]);
        expect(items.ended).toMatchObject({
          total: 1,
          items: [
            { childSessionId: childRow.childSessionId, status: "success" },
          ],
        });
        expect(
          (
            await sendToTask(
              host,
              childRow.childSessionId,
              "CANNOT_RUN_INHERITED_CHILD",
            )
          ).body.result.status,
        ).not.toBe("accepted");
        const stopped = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "stop",
              sessionId: childRow.childSessionId,
              clientId: host.clientId,
              commandId: randomUUID(),
              payload: {},
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(stopped.body.result.status).not.toBe("accepted");
        expect(model.requests).toHaveLength(3);
        expect(
          (await sendToTask(host, forkId, "NEW_FORK_TASK_INPUT")).body.result
            .status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(
          "正在运行 2",
        );
        model.finish(3);
        await waitPhase(fixture, forkId, "completedSuccess");
        expect(
          JSON.stringify(
            (await snapshot(fixture, childRow.childSessionId)).rows.window,
          ),
        ).toContain("正在运行 2");
        const afterB = await snapshot(fixture, forkId);
        const inheritedA = afterB.rows.window.find(
          (row) => row.kind === "assistantText" && row.text === "正在运行 3",
        );
        if (!inheritedA?.entityId) throw new Error("继承A不可定位");
        const again = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: forkId,
              clientId: host.clientId,
              commandId: randomUUID(),
              baseRevision: afterB.revision,
              baseLogEpoch: afterB.logEpoch,
              payload: {
                target: {
                  rowId: inheritedA.rowId,
                  entityId: inheritedA.entityId,
                },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        const nextAck = protocol.commandAckSchema.parse(again.body.result);
        expect(nextAck.status, JSON.stringify(nextAck)).toBe("accepted");
        if (nextAck.result?.type !== "forkAssistant")
          throw new Error("再次fork根缺失");
        const grand = await snapshot(fixture, nextAck.result.sessionId);
        const descendant = grand.rows.window.find(
          (row) => row.kind === "subagent",
        );
        if (descendant?.kind !== "subagent" || !descendant.childSessionId)
          throw new Error("再次fork子图缺失");
        expect(descendant.childSessionId).not.toBe(childRow.childSessionId);
        expect(
          JSON.stringify(
            (await snapshot(fixture, descendant.childSessionId)).rows.window,
          ),
        ).toContain("正在运行 2");
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
  },
);
