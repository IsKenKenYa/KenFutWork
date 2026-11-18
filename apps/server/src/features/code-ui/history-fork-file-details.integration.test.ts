import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  instanceSettingsResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  type Fixture,
  type Host,
  sendToTask,
  snapshot,
  waitPhase,
} from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

function requireHeader(current: protocol.ConversationSnapshot) {
  const header = current.rows.window.find((row) => row.kind === "turnHeader");
  if (header?.kind !== "turnHeader" || !header.entityId)
    throw new Error("真实文件轮次缺少可定位的原 header");
  return { ...header, entityId: header.entityId };
}

function fileDetails(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
) {
  const header = requireHeader(current);
  return host.stream.rpc("conversationFileChangesV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      sessionId: taskId,
      target: { rowId: header.rowId, entityId: header.entityId },
      baseRevision: current.revision,
      baseLogEpoch: current.logEpoch,
    },
  ]);
}

async function deleteParentHistory(
  fixture: Fixture,
  host: Host,
  taskId = host.sessionId,
) {
  const binding = await fixture.app.kernel
    .get("threads")
    .resolveOwnedSessionThread(fixture.actor, taskId);
  const deleted = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "deleteTask",
    args: [{ taskId, workspacePath: host.workspacePath }],
  });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  const native = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!native) throw new Error("真实 native 历史持久化未装配");
  // 仅删除该独占 fixture 的父 native thread，证明 child 不借用父历史。
  await native.checkpointer.deleteThread(binding.threadId);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "分叉文件只读详情独立归属 integration",
  () => {
    it("父 Write、公开删除及 native 清理后，child 仍读取完整补丁且没有恢复权限、不改当前文件", async () => {
      const limit = AGENT_GOVERNANCE_LIMITS.codePatchMaxBytes.min;
      const prefix = "PARENT_FULL_PATCH_SENTINEL:";
      // 文件字节可提交，而 JSON hunk 的结构开销超出展示预算，锁定完整 journal 消费。
      const content = `${prefix}${"x".repeat(limit - prefix.length - 48)}\n`;
      const fixture = await createCodeUiHttpFixture({
        governanceEnv: { codePatchMaxBytes: limit },
      });
      const model = await heldModel({
        initialTool: {
          id: "fork-parent-write",
          name: "Write",
          arguments: {
            file_path: "fork-parent-write.txt",
            content,
            create_only: true,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "edit", planEnabled: false },
        });
        const path = join(host.workspacePath, "fork-parent-write.txt");
        await host.command("sendText", { text: "创建文件并报告真实提交" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(await readFile(path, "utf8")).toBe(content);
        model.finish(1);
        const parent = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const write = parent.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Write",
        );
        expect(write).toMatchObject({
          status: "success",
          output: {
            display: {
              kind: "file_diff",
              truncated: true,
              structuredPatch: [],
            },
          },
        });
        const enlarged = await fixture.client.request(
          "/api/instance/settings",
          { codePatchMaxBytes: AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes },
          "PATCH",
        );
        expect(enlarged.status, JSON.stringify(enlarged.body)).toBe(200);
        expect(
          instanceSettingsResponseSchema.parse(enlarged.body).settings
            .codePatchMaxBytes,
        ).toBe(AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes);
        const parentDetails = await fileDetails(host, host.sessionId, parent);
        expect(parentDetails.status, JSON.stringify(parentDetails.body)).toBe(
          200,
        );
        const original = protocol.v4ConversationFileChangesResultSchema.parse(
          parentDetails.body.result,
        );
        expect(original).toMatchObject({
          files: 1,
          additions: 1,
          deletions: 0,
          items: [{ path, writeCount: 1, toolNames: ["Write"] }],
        });
        expect(original.items.flatMap((item) => item.patches)).toEqual([
          expect.objectContaining({ lines: [`+${content.trimEnd()}`] }),
        ]);

        const assistant = parent.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId)
          throw new Error("真实父 Write 轮次缺少可分叉的完整回复");
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
          throw new Error("原分叉 ACK 缺少独立 child Task 身份");
        const childId = ack.result.sessionId;
        await deleteParentHistory(fixture, host);
        const currentDisk = "CURRENT_DISK_MUST_SURVIVE_READ_ONLY_DETAILS\n";
        await writeFile(path, currentDisk);
        const child = await snapshot(fixture, childId);
        expect(requireHeader(child).actions?.canRewindFiles).toBeUndefined();
        expect(child.control.activeWorks).toEqual([]);
        const childDetails = await fileDetails(host, childId, child);
        expect(childDetails.status, JSON.stringify(childDetails.body)).toBe(
          200,
        );
        const inherited = protocol.v4ConversationFileChangesResultSchema.parse(
          childDetails.body.result,
        );
        expect(inherited).toEqual(original);
        expect(await readFile(path, "utf8")).toBe(currentDisk);
        const after = await snapshot(fixture, childId);
        expect(requireHeader(after).actions?.canRewindFiles).toBeUndefined();
        expect(after.control.activeWorks).toEqual([]);
        expect(model.requests).toHaveLength(2);
        const narrowed = await fixture.client.request(
          "/api/instance/settings",
          { codePatchMaxBytes: limit },
          "PATCH",
        );
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        // 设置变小后仍能读取正常快照，完整详情明确拒绝，不截断成假成功。
        const underBudget = await snapshot(fixture, childId);
        const refused = await fileDetails(host, childId, underBudget);
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.error.message).toContain("当前读取预算");
        expect(await readFile(path, "utf8")).toBe(currentDisk);
        const restored = await fixture.client.request(
          "/api/instance/settings",
          { codePatchMaxBytes: AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes },
          "PATCH",
        );
        expect(restored.status).toBe(200);
        const restoredChild = await snapshot(fixture, childId);
        const childAssistant = restoredChild.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!childAssistant?.entityId) throw new Error("继承回复不可定位");
        const descendant = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "forkAssistant",
              sessionId: childId,
              commandId: randomUUID(),
              clientId: host.clientId,
              baseRevision: restoredChild.revision,
              baseLogEpoch: restoredChild.logEpoch,
              payload: {
                target: {
                  rowId: childAssistant.rowId,
                  entityId: childAssistant.entityId,
                },
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(descendant.status, JSON.stringify(descendant.body)).toBe(200);
        const nextAck = protocol.commandAckSchema.parse(descendant.body.result);
        expect(nextAck.status, JSON.stringify(nextAck)).toBe("accepted");
        if (nextAck.result?.type !== "forkAssistant")
          throw new Error("孙Task身份缺失");
        await deleteParentHistory(fixture, host, childId);
        const grandchild = await snapshot(fixture, nextAck.result.sessionId);
        expect(
          requireHeader(grandchild).actions?.canRewindFiles,
        ).toBeUndefined();
        const finalDetails = await fileDetails(
          host,
          nextAck.result.sessionId,
          grandchild,
        );
        expect(finalDetails.status, JSON.stringify(finalDetails.body)).toBe(
          200,
        );
        expect(
          protocol.v4ConversationFileChangesResultSchema.parse(
            finalDetails.body.result,
          ),
        ).toEqual(original);
        expect(await readFile(path, "utf8")).toBe(currentDisk);
        expect(model.requests).toHaveLength(2);
        // 孙Task真实新增B并编辑B，A的完整只读事实随保留prefix再绑定，不借已删除祖先。
        const taskId = nextAck.result.sessionId;
        expect(
          (await sendToTask(host, taskId, "FILE_DETAILS_OLD_B")).body.result
            .status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        model.finish(2);
        const withB = await waitPhase(fixture, taskId, "completedSuccess");
        const latestInput = [...withB.rows.window]
          .reverse()
          .find((row) => row.kind === "userInput");
        if (!latestInput?.entityId) throw new Error("孙Task真实B缺少用户输入");
        const edit = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "editUserQuery",
              sessionId: taskId,
              commandId: randomUUID(),
              clientId: host.clientId,
              baseRevision: withB.revision,
              baseLogEpoch: withB.logEpoch,
              payload: {
                target: {
                  rowId: latestInput.rowId,
                  entityId: latestInput.entityId,
                },
                newText: "FILE_DETAILS_NEW_B",
                workspaceMode: "preserve",
              },
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(edit.status, JSON.stringify(edit.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(edit.body.result).status,
          JSON.stringify(edit.body),
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[3]?.body.messages)).toContain(
          "FILE_DETAILS_NEW_B",
        );
        expect(JSON.stringify(model.requests[3]?.body.messages)).not.toContain(
          "FILE_DETAILS_OLD_B",
        );
        model.finish(3);
        const afterEdit = await waitPhase(fixture, taskId, "completedSuccess");
        const retainedDetails = await fileDetails(host, taskId, afterEdit);
        expect(
          retainedDetails.status,
          JSON.stringify(retainedDetails.body),
        ).toBe(200);
        expect(
          protocol.v4ConversationFileChangesResultSchema.parse(
            retainedDetails.body.result,
          ),
        ).toEqual(original);
        expect(
          requireHeader(afterEdit).actions?.canRewindFiles,
        ).toBeUndefined();
        expect(await readFile(path, "utf8")).toBe(currentDisk);
        expect(model.requests).toHaveLength(4);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
  },
);
