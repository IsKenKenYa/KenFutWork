import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  instanceSettingsSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeUiConversation } from "./conversation.js";
import { createFileDisplayPublicFixture } from "./file-display.test-fixture.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

async function fixture(multipleFiles = false, truncatePreview = false) {
  const actual = await createFileDisplayPublicFixture(
    multipleFiles,
    truncatePreview,
  );
  cleanups.push(actual.dispose);
  const instanceId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const actor = { instanceId: instanceId, accessClientId: null };
  const host = createCodeUiConversation({
    sessionId,
    workspacePath: actual.rootDirectory,
    config: {
      provider: "zcode",
      model: "fixture",
      thought: "",
      followupMode: "queue",
    },
  });
  host.startTurn({
    runId: actual.row.turnId,
    commandId: "source",
    text: "修改文件",
  });
  for (const event of actual.events) host.recordEvent(event);
  const state = host.exportState();
  const root: CodeUiSessionRecord = {
    id: sessionId,
    instance_id: instanceId,
    project_id: projectId,
    root_directory: actual.rootDirectory,
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 0,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: sessionId,
    root_session_id: sessionId,
    parent_session_id: null,
    parent_tool_call_id: null,
    state,
    revision: state.snapshots[0]!.revision,
    active_run_id: null,
    archived: false,
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  const openTask = vi.fn(async () => {
    throw new Error("详情读取不得授予执行作用域");
  });
  const service = new CodeUiService({
    repository: {
      recoverRuntimeInputs: async () => {},
      readHumanPreferences: async () => ({}),
      find: async (owner: string, id: string) =>
        owner === instanceId && id === sessionId ? structuredClone(root) : null,
      readToolCompletions: async (owner: string, id: string, runId: string) =>
        owner === instanceId && id === sessionId
          ? actual.events.filter(
              (event) =>
                event.type === "tool.completed" &&
                event.runId === runId &&
                ["Write", "Edit", "ApplyPatch"].includes(event.toolName),
            )
          : [],
    },
    localInstance: createCodeUiTestInstance(instanceId).localInstance,
    projects: {
      listProjects: async () => [
        {
          id: projectId,
          kind: "code",
          name: "Files",
          workDir: actual.rootDirectory,
          additionalDirectories: [],
        },
      ],
    },
    executionScopes: { openTask },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "fixture" }),
    },
    env: {},
    taskWork: { initialize: async () => [] },
  } as unknown as CodeUiServiceDeps);
  const snapshot = host.getSnapshot();
  const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
  if (!header?.entityId) throw new Error("真实投影缺少轮次身份");
  const params = {
    workspacePath: actual.rootDirectory,
    projectId,
    workspaceIdentity: JSON.stringify([projectId, actual.rootDirectory]),
    sessionId,
    target: { rowId: header.rowId, entityId: header.entityId },
    baseRevision: snapshot.revision,
    baseLogEpoch: snapshot.logEpoch,
  };
  return { service, actor, params, actual, openTask, snapshot, root, header };
}

it("原V4详情返回实际Edit提交与轮次摘要，cold读取不创建Run或执行作用域", async () => {
  const f = await fixture();
  const response = await f.service.transportRpc(
    f.actor,
    undefined,
    "conversationFileChangesV4",
    [f.params],
  );
  const result = protocol.v4ConversationFileChangesResultSchema.parse(
    response?.result,
  );
  expect(result).toMatchObject({
    files: 1,
    additions: 1,
    deletions: 1,
    state: "active",
    items: [{ path: f.actual.filePath, writeCount: 1, toolNames: ["Edit"] }],
  });
  expect(result.items[0]?.patches).toEqual([
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-first", "+second"],
    },
  ]);
  expect(f.header.fileChanges).toEqual({
    files: 1,
    additions: 1,
    deletions: 1,
    state: "active",
  });
  expect(f.openTask).not.toHaveBeenCalled();
});

it("ApplyPatch部分失败只统计两个真实提交，失败与未执行文件不计入轮次", async () => {
  const f = await fixture(true);
  const response = await f.service.transportRpc(
    f.actor,
    undefined,
    "conversationFileChangesV4",
    [f.params],
  );
  const result = protocol.v4ConversationFileChangesResultSchema.parse(
    response?.result,
  );
  expect(result).toMatchObject({ files: 2, additions: 2, deletions: 2 });
  expect(
    result.items.map((file) => ({
      path: file.path,
      writes: file.writeCount,
      tools: file.toolNames,
    })),
  ).toEqual([
    { path: f.actual.filePath, writes: 1, tools: ["ApplyPatch"] },
    {
      path: join(f.actual.rootDirectory, "other.ts"),
      writes: 1,
      tools: ["ApplyPatch"],
    },
  ]);
  expect(f.header.fileChanges).toEqual({
    files: 2,
    additions: 2,
    deletions: 2,
    state: "active",
  });
});

it("原工具卡截断预览时，V4详情从私有canonical提交读取两份完整hunk，保持真实总计数", async () => {
  const f = await fixture(false, true);
  expect(f.actual.row.output?.display).toMatchObject({
    kind: "file_diff",
    truncated: true,
    additions: 2,
    deletions: 2,
  });
  const response = await f.service.transportRpc(
    f.actor,
    undefined,
    "conversationFileChangesV4",
    [f.params],
  );
  const result = protocol.v4ConversationFileChangesResultSchema.parse(
    response?.result,
  );
  expect(result).toMatchObject({ files: 1, additions: 2, deletions: 2 });
  expect(result.items[0]?.patches.map((hunk) => hunk.oldStart)).toEqual([1, 5]);
  expect(f.openTask).not.toHaveBeenCalled();
});

it("详情拒绝旧revision、旧epoch和替换实体，不能借同路径跨Project读取", async () => {
  const f = await fixture();
  for (const patch of [
    { baseRevision: f.params.baseRevision - 1 },
    { baseLogEpoch: "previous-log" },
  ])
    await expect(
      f.service.transportRpc(f.actor, undefined, "conversationFileChangesV4", [
        { ...f.params, ...patch },
      ]),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  for (const patch of [
    { target: { ...f.params.target, entityId: "another-entity" } },
    { projectId: randomUUID() },
    { workspacePath: join(f.actual.rootDirectory, "other") },
    {
      workspaceIdentity: JSON.stringify([randomUUID(), f.actual.rootDirectory]),
    },
    { sessionId: randomUUID() },
  ])
    await expect(
      f.service.transportRpc(f.actor, undefined, "conversationFileChangesV4", [
        { ...f.params, ...patch },
      ]),
    ).rejects.toMatchObject({ code: "not_found" });
  expect(f.openTask).not.toHaveBeenCalled();
});

it("缺少真实恢复provider时原V4预览给可读拒绝，不伪造安全文件或授予执行作用域", async () => {
  const f = await fixture();
  await expect(
    f.service.transportRpc(
      f.actor,
      undefined,
      "conversationFileRewindPreviewV4",
      [f.params],
    ),
  ).rejects.toMatchObject({
    code: "command_conflict",
    message: "文件恢复能力尚未装配。",
  });
  expect(f.openTask).not.toHaveBeenCalled();
});
