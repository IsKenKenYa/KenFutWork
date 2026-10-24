import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeExecutionScope,
  type CodeTaskProjectMoveInput,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
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

const userText = "继承历史跨项目移动的父Task输入";
const body = `完整正文开头\n${"继承历史中间正文。".repeat(100)}\n完整正文结尾`;
const assistantText = `正在运行 1${body}`;
type Model = Awaited<ReturnType<typeof heldModel>>;

async function scope(fixture: Fixture, taskId: string) {
  const response = await fixture.client.request(
    `/api/code-ui/tasks/${taskId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

function expectHistory(current: protocol.ConversationSnapshot) {
  const user = current.rows.window.find(
    (row) => row.kind === "userInput" && row.text === userText,
  );
  const assistant = current.rows.window.find(
    (row) =>
      row.kind === "assistantText" &&
      row.state === "complete" &&
      row.text === assistantText,
  );
  if (user?.kind !== "userInput" || assistant?.kind !== "assistantText")
    throw new Error("公开继承快照缺少完整输入或回复正文。");
  expect(user.text).toBe(userText);
  expect(user.actions).toMatchObject({ canEdit: true });
  expect(assistant.text).toBe(assistantText);
  expect(assistant.actions).toMatchObject({ canFork: true });
  if (!assistant.entityId) throw new Error("公开回复缺少原分叉边界身份。");
  return assistant;
}

async function prepareParent(fixture: Fixture, host: Host, model: Model) {
  const additional = join(fixture.directory, "继承移动保留的只读目录");
  await mkdir(additional);
  const canonicalAdditional = await realpath(additional);
  const changed = await fixture.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    {
      additionalDirectories: [
        { path: canonicalAdditional, access: "read-only" },
      ],
      sandboxMode: "workspace-write",
    },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const sent = await sendToTask(host, host.sessionId, userText);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await model.firstRequest;
  model.writeText(0, body);
  model.finish(0);
  const completed = await waitPhase(
    fixture,
    host.sessionId,
    "completedSuccess",
  );
  expectHistory(completed);
  const parentScope = await scope(fixture, host.sessionId);
  expect(parentScope.additionalDirectories).toEqual([
    { path: canonicalAdditional, access: "read-only" },
  ]);
  return { completed, scope: parentScope };
}

async function forkAssistant(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
  currentScope: CodeExecutionScope,
) {
  const assistant = expectHistory(current);
  if (!current.taskControl) throw new Error("原分叉缺少公开Task观察值。");
  expect(current.taskControl.projectId).toBe(currentScope.projectId);
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: currentScope.rootDirectory,
      workspaceIdentity: JSON.stringify([
        currentScope.projectId,
        currentScope.rootDirectory,
      ]),
      projectId: currentScope.projectId,
      envelope: {
        type: "forkAssistant",
        sessionId: taskId,
        commandId: randomUUID(),
        clientId: host.clientId,
        taskControl: structuredClone(current.taskControl),
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
        payload: {
          target: { rowId: assistant.rowId, entityId: assistant.entityId },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status, JSON.stringify(ack)).toBe("accepted");
  if (ack.result?.type !== "forkAssistant")
    throw new Error("原分叉回执缺少持久Task身份。");
  expect(ack.result.sessionId).not.toBe(taskId);
  return ack.result.sessionId;
}

async function createTarget(fixture: Fixture) {
  const root = join(fixture.directory, "继承历史移动目标目录");
  await mkdir(root);
  const response = await fixture.client.request("/api/projects", {
    name: "继承历史移动项目 B",
    kind: "code",
    work_dir: root,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectCreateResponseSchema.parse(response.body).project;
}

async function moveTask(
  host: Host,
  taskId: string,
  current: protocol.ConversationSnapshot,
  currentScope: CodeExecutionScope,
  projectId: string,
) {
  if (!current.taskControl) throw new Error("移动继承Task缺少公开观察值。");
  expect(current.taskControl.projectId).toBe(currentScope.projectId);
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId,
      workspacePath: currentScope.rootDirectory,
      workspaceIdentity: JSON.stringify([
        currentScope.projectId,
        currentScope.rootDirectory,
      ]),
    },
    sourceProjectId: currentScope.projectId,
    projectId,
    observedRevision: current.revision,
    hostId: "local",
    addMissingRoot: true,
  };
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ result: null });
}

function expectNoRun(current: protocol.ConversationSnapshot) {
  expect(current.control.canStop).toBe(false);
  expect(current.control.activeWorks).toEqual([]);
  expect(current.queue.items).toEqual([]);
  expect(current.pendingInteractions).toEqual([]);
  expect(current.pendingCommands).toEqual([]);
  expect(current.usage.cumulative).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
  });
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "继承Task跨项目往返移动的真实HTTP、RPC与模型历史 integration",
  () => {
    it("原fork继承Task按当前观察值A到B再回A，正文和动作保持且B可再次分叉，无新Run", async () => {
      const model = await heldModel({
        usage: { promptTokens: 13, completionTokens: 5 },
      });
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      const failures: unknown[] = [];
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const parent = await prepareParent(fixture, host, model);
        const childId = await forkAssistant(
          host,
          host.sessionId,
          parent.completed,
          parent.scope,
        );
        const inherited = await snapshot(fixture, childId);
        const inheritedScope = await scope(fixture, childId);
        expectHistory(inherited);
        expectNoRun(inherited);
        expect(inheritedScope).toMatchObject({
          instanceId: parent.scope.instanceId,
          projectId: parent.scope.projectId,
          taskId: childId,
          rootDirectory: parent.scope.rootDirectory,
          additionalDirectories: parent.scope.additionalDirectories,
          sandboxMode: parent.scope.sandboxMode,
        });
        expect(await snapshot(fixture, host.sessionId)).toEqual(
          parent.completed,
        );
        expect(await scope(fixture, host.sessionId)).toEqual(parent.scope);
        const target = await createTarget(fixture);
        const modelRequestCountBefore = model.requests.length;
        expect(modelRequestCountBefore).toBe(1);
        let current = inherited;
        let currentScope = inheritedScope;
        let descendant:
          | {
              taskId: string;
              scope: CodeExecutionScope;
              snapshot: protocol.ConversationSnapshot;
            }
          | undefined;
        for (const projectId of [target.id, parent.scope.projectId]) {
          const previous = current;
          const previousControl = previous.taskControl;
          if (!previousControl) throw new Error("移动前缺少公开Task观察值。");
          const previousScope = currentScope;
          await moveTask(host, childId, previous, previousScope, projectId);
          current = await snapshot(fixture, childId);
          currentScope = await scope(fixture, childId);
          expect(currentScope).toEqual({
            ...previousScope,
            projectId,
            generation: previousScope.generation + 1,
          });
          expect(currentScope.rootDirectory).toBe(inheritedScope.rootDirectory);
          expect(current.rows.window).toEqual(inherited.rows.window);
          expectHistory(current);
          expectNoRun(current);
          expect(current.taskControl).toEqual({
            ...previousControl,
            projectId,
            branchGeneration: previousControl.branchGeneration + 1,
          });
          expect(current.revision).toBeGreaterThan(previous.revision);
          expect(await snapshot(fixture, host.sessionId)).toEqual(
            parent.completed,
          );
          expect(await scope(fixture, host.sessionId)).toEqual(parent.scope);
          expect(model.requests).toHaveLength(modelRequestCountBefore);
          if (projectId === target.id) {
            const taskId = await forkAssistant(
              host,
              childId,
              current,
              currentScope,
            );
            const child = await snapshot(fixture, taskId);
            const childScope = await scope(fixture, taskId);
            expectHistory(child);
            expectNoRun(child);
            expect(childScope).toMatchObject({
              taskId,
              instanceId: currentScope.instanceId,
              projectId: target.id,
              rootDirectory: currentScope.rootDirectory,
              additionalDirectories: currentScope.additionalDirectories,
              sandboxMode: currentScope.sandboxMode,
            });
            descendant = { taskId, scope: childScope, snapshot: child };
            current = await snapshot(fixture, childId);
            currentScope = await scope(fixture, childId);
            expect(current.rows.window).toEqual(inherited.rows.window);
            expect(model.requests).toHaveLength(modelRequestCountBefore);
          }
        }
        expect(currentScope.projectId).toBe(parent.scope.projectId);
        expect(currentScope.generation).toBe(inheritedScope.generation + 2);
        expect(current.rows.window).toEqual(inherited.rows.window);
        if (!descendant) throw new Error("项目B未通过原继承边界再次分叉。");
        expect(await scope(fixture, descendant.taskId)).toEqual(
          descendant.scope,
        );
        expect(await snapshot(fixture, descendant.taskId)).toEqual(
          descendant.snapshot,
        );
        expect(await scope(fixture, host.sessionId)).toEqual(parent.scope);
        expect(await snapshot(fixture, host.sessionId)).toEqual(
          parent.completed,
        );
        expect(model.requests).toHaveLength(modelRequestCountBefore);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => fixture?.close(),
          () => model.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "继承历史移动验证或资源关闭失败", {
          cause: failures[0],
        });
    }, 90_000); // 原发送与分叉、真实模型HTTP、项目往返及独占HTTP/SSE/PG关闭期限。
  },
);
