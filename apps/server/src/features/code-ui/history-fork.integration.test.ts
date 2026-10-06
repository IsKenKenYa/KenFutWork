import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;

async function snapshot(fixture: Fixture, taskId: string) {
  const response = await fixture.client.request(
    `/api/code-ui/sessions/${taskId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function waitPhase(fixture: Fixture, taskId: string, phase: string) {
  let result: protocol.ConversationSnapshot | undefined;
  await vi.waitFor(
    async () => {
      result = await snapshot(fixture, taskId);
      expect(
        result.control.phase,
        JSON.stringify(result.control.lastError),
      ).toBe(phase);
    },
    { timeout: 30_000 },
  ); // 仅真实模型/持久投影同步期限，非产品治理值。
  if (!result) throw new Error("未读取实际Task快照");
  return result;
}

function sendToTask(host: Host, taskId: string, text: string) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        type: "sendText",
        sessionId: taskId,
        commandId: randomUUID(),
        clientId: host.clientId,
        payload: { text },
        issuedAt: Date.now(),
      },
    },
  ]);
}

describe.skipIf(!enabled)("原历史分叉真实宿主 integration", () => {
  it.each([false, true])(
    "父B运行时从完成A创建独立Task，保留真实Read与目录（COMMIT回包丢失：%s）",
    async (commitLoss) => {
      let proxy:
        | Awaited<ReturnType<typeof createCommitResponseLossProxy>>
        | undefined;
      const fixture = await createCodeUiHttpFixture({
        ...(commitLoss
          ? {
              databaseTransport: async (direct: string) => {
                proxy = await createCommitResponseLossProxy(direct);
                return proxy;
              },
            }
          : {}),
      });
      const model = await heldModel({
        usage: { promptTokens: 10, completionTokens: 3 },
        initialTool: {
          id: "fork-a-read",
          name: "Read",
          arguments: { file_path: "fork-a.txt" },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const marker = join(host.workspacePath, "fork-a.txt");
        await writeFile(marker, "FORK_A_REAL_READ_SENTINEL");
        await host.command("sendText", { text: "FORK_A_ORIGINAL_USER" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
          "FORK_A_REAL_READ_SENTINEL",
        );
        model.finish(1);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        const completed = await snapshot(fixture, host.sessionId);
        expect(completed.usage.cumulative).toMatchObject({
          inputTokens: 20,
          outputTokens: 6,
        });
        const assistant = completed.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (assistant?.kind !== "assistantText")
          throw new Error("完成A缺少原assistant行");
        let originalScope = codeTaskScopeResponseSchema.parse(
          (
            await fixture.client.request(
              `/api/code-ui/tasks/${host.sessionId}/scope`,
            )
          ).body,
        ).scope;
        const nextProjectDirectory = join(
          fixture.directory,
          "project-default-b",
        );
        const referenceDirectory = join(fixture.directory, "fork-reference");
        await mkdir(nextProjectDirectory);
        await mkdir(referenceDirectory);
        const changedProject = await fixture.client.request(
          `/api/projects/${host.projectId}`,
          { work_dir: nextProjectDirectory },
          "PATCH",
        );
        expect(changedProject.status, JSON.stringify(changedProject.body)).toBe(
          204,
        );
        const scoped = await fixture.client.request(
          `/api/code-ui/tasks/${host.sessionId}/scope`,
          {
            sandboxMode: "read-only",
            additionalDirectories: [
              { path: referenceDirectory, access: "read-only" },
            ],
          },
          "PATCH",
        );
        expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
        originalScope = codeTaskScopeResponseSchema.parse(scoped.body).scope;
        expect(originalScope.rootDirectory).toBe(host.workspacePath);
        const sourceTaskId = host.sessionId;
        await host.command("sendText", {
          text: "FORK_B_PARENT_FUTURE_MUST_NOT_LEAK",
          mode: "yolo",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        let running = await waitPhase(fixture, host.sessionId, "running");
        await vi.waitFor(
          async () => {
            running = await snapshot(fixture, sourceTaskId);
            expect(
              running.rows.window.filter((row) => row.kind === "assistantText"),
            ).toContainEqual(expect.objectContaining({ text: "正在运行 3" }));
          },
          { timeout: 30_000 },
        );
        const foreground = running.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        expect(foreground).toEqual(expect.any(String));
        const id = randomUUID();
        proxy?.arm(id);
        const payload = {
          target: { rowId: assistant.rowId, entityId: assistant.entityId },
        };
        const guard = {
          baseRevision: running.revision,
          baseLogEpoch: running.logEpoch,
        };
        const forked = await host.command("forkAssistant", payload, id, guard);
        expect(forked.status, JSON.stringify(forked.body)).toBe(200);
        if (proxy) {
          expect(proxy.evidence()).toMatchObject({
            injected: {
              commitConfirmed: true,
              replySuppressed: true,
              commandId: id,
            },
          });
          expect(proxy.evidence().observerError).toBeUndefined();
        }
        const ack = protocol.commandAckSchema.parse(forked.body.result);
        expect(ack.status, JSON.stringify(ack)).toBe("accepted");
        if (ack.result?.type !== "forkAssistant")
          throw new Error("原fork ACK缺少新Task身份");
        const childId = ack.result.sessionId;
        expect(childId).not.toBe(host.sessionId);
        const child = await snapshot(fixture, childId);
        expect(child.control.canStop).toBe(false);
        expect(child.control.activeWorks).toEqual([]);
        expect(child.queue.items).toEqual([]);
        expect(child.pendingInteractions).toEqual([]);
        expect(child.usage.cumulative).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
        });
        expect(child.config).toMatchObject({
          mode: "build",
          planEnabled: false,
        });
        expect(JSON.stringify(child.rows.window)).toContain(
          "FORK_A_ORIGINAL_USER",
        );
        expect(JSON.stringify(child.rows.window)).not.toContain(
          "FORK_B_PARENT_FUTURE_MUST_NOT_LEAK",
        );
        const childScope = codeTaskScopeResponseSchema.parse(
          (await fixture.client.request(`/api/code-ui/tasks/${childId}/scope`))
            .body,
        ).scope;
        expect(childScope).toMatchObject({
          taskId: childId,
          instanceId: originalScope.instanceId,
          projectId: originalScope.projectId,
          rootDirectory: originalScope.rootDirectory,
          additionalDirectories: originalScope.additionalDirectories,
          sandboxMode: originalScope.sandboxMode,
        });
        const stillRunning = await snapshot(fixture, host.sessionId);
        expect(stillRunning.control.phase).toBe("running");
        expect(stillRunning.control.activeWorks).toContainEqual(
          expect.objectContaining({ foregroundExecutionId: foreground }),
        );
        expect(model.requests[2]?.closed).toBe(false);
        expect(await readFile(marker, "utf8")).toBe(
          "FORK_A_REAL_READ_SENTINEL",
        );
        const replay = await host.command("forkAssistant", payload, id, guard);
        expect(replay.body.result).toMatchObject({
          status: "duplicate",
          result: { type: "forkAssistant", sessionId: childId },
        });
        expect(
          (await sendToTask(host, childId, "FORK_CHILD_NEW_INPUT")).body.result
            .status,
        ).toBe("accepted");
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        const childMessages = JSON.stringify(model.requests[3]?.body.messages);
        expect(childMessages).toContain("FORK_A_ORIGINAL_USER");
        expect(childMessages).toContain("FORK_A_REAL_READ_SENTINEL");
        expect(childMessages).toContain("FORK_CHILD_NEW_INPUT");
        expect(childMessages).not.toContain(
          "FORK_B_PARENT_FUTURE_MUST_NOT_LEAK",
        );
        model.finish(3);
        const finishedChild = await waitPhase(
          fixture,
          childId,
          "completedSuccess",
        );
        expect(finishedChild.usage.cumulative).toMatchObject({
          inputTokens: 10,
          outputTokens: 3,
        });
        model.finish(2);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        expect(await readFile(marker, "utf8")).toBe(
          "FORK_A_REAL_READ_SENTINEL",
        );
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    },
    90_000,
  );
});
