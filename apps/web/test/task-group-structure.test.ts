import type { ZCodeTaskMeta } from "@zcode/shared";
import { expect, test } from "vitest";
import {
  decodeTopLevelOrderKey,
  groupMembersInOrder,
  parseTaskGroupStructure,
  rootTasksInOrder,
  taskGroupWorkspaceKey,
  toGroupedTaskViewStructure,
} from "../src/components/workbench/zcode/host/taskGroupStructure";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GROUP_ID = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function task(taskId: string, title: string, workspacePath = "/w"): ZCodeTaskMeta {
  return {
    taskId,
    title,
    workspacePath,
    workspaceIdentity: undefined,
  } as unknown as ZCodeTaskMeta;
}

const STRUCTURE = {
  revision: 7,
  groups: [
    {
      id: GROUP_ID,
      title: "本周",
      color: "blue" as const,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: OTHER_GROUP_ID,
      title: "空组",
      color: "gray" as const,
      createdAt: 3,
      updatedAt: 4,
    },
  ],
  members: [
    { groupId: GROUP_ID, workspaceKey: "/w", taskId: TASK_B, sortOrder: 1 },
    { groupId: GROUP_ID, workspaceKey: "/w", taskId: TASK_A, sortOrder: 0 },
  ],
  order: [
    { type: "group" as const, key: `group:${GROUP_ID}`, sortOrder: 0 },
    { type: "group" as const, key: `group:${OTHER_GROUP_ID}`, sortOrder: 1 },
    { type: "task" as const, key: `/w|${TASK_C}`, sortOrder: 2 },
  ],
};

test("编码/解码根层顺序键：group 与 task 两种都认得", () => {
  expect(decodeTopLevelOrderKey(`group:${GROUP_ID}`)).toEqual({
    type: "group",
    groupId: GROUP_ID,
  });
  expect(decodeTopLevelOrderKey(`/w|${TASK_C}`)).toEqual({
    type: "task",
    key: `/w|${TASK_C}`,
  });
});

test("workspaceKey 口径：identity 优先，缺省回落路径", () => {
  expect(taskGroupWorkspaceKey("/w")).toBe("/w");
  expect(taskGroupWorkspaceKey("/w", "identity-1")).toBe("identity-1");
  expect(taskGroupWorkspaceKey("/w", "")).toBe("/w");
});

test("组内成员按 sortOrder 升序，缺序排最后", () => {
  const tasks = [task(TASK_A, "A"), task(TASK_B, "B")];
  const structure = toGroupedTaskViewStructure(STRUCTURE, tasks);
  expect(groupMembersInOrder(structure, GROUP_ID).map((t) => t.taskId)).toEqual([
    TASK_A,
    TASK_B,
  ]);
});

test("成员指向的任务不在列表时跳过，不造占位行", () => {
  // 只提供 A，B 已不在可见列表
  const structure = toGroupedTaskViewStructure(STRUCTURE, [task(TASK_A, "A")]);
  expect(groupMembersInOrder(structure, GROUP_ID).map((t) => t.taskId)).toEqual([
    TASK_A,
  ]);
});

test("根层任务排除已入组成员，并按服务端根层顺序排列", () => {
  const tasks = [task(TASK_A, "A"), task(TASK_B, "B"), task(TASK_C, "C")];
  const structure = toGroupedTaskViewStructure(STRUCTURE, tasks);
  expect(rootTasksInOrder(structure, tasks).map((t) => t.taskId)).toEqual([
    TASK_C,
  ]);
});

test("任务列表里的空洞不会让适配崩溃", () => {
  const tasks = [
    undefined as unknown as ZCodeTaskMeta,
    task(TASK_A, "A"),
    null as unknown as ZCodeTaskMeta,
  ];
  expect(() => toGroupedTaskViewStructure(STRUCTURE, tasks)).not.toThrow();
  const structure = toGroupedTaskViewStructure(STRUCTURE, tasks);
  expect(groupMembersInOrder(structure, GROUP_ID).map((t) => t.taskId)).toEqual([
    TASK_A,
  ]);
  expect(() => rootTasksInOrder(structure, tasks)).not.toThrow();
});

test("结构校验：缺字段直接报错，不做兜底", () => {
  expect(() => parseTaskGroupStructure({ revision: 1 })).toThrow();
  expect(parseTaskGroupStructure(STRUCTURE).revision).toBe(7);
});
