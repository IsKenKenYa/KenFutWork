import { createHash } from "node:crypto";
import type {
  CodeTaskGroupMove,
  CodeTaskGroupNode,
  CodeTaskGroupTaskRef,
} from "@kenfutwork/shared";
import { taskGroupTaskReferences } from "./references.js";

export type TaskGroupMoveNode = { type: "group" | "task"; id: string };
export type TaskGroupMoveIntent = {
  node: TaskGroupMoveNode;
  sourceGroupId: string | null;
  groupId: string | null;
  expectedRevision: number;
  anchor: { node: TaskGroupMoveNode; side: "before" | "after" } | null;
  references: ReadonlyMap<string, CodeTaskGroupTaskRef>;
  fingerprint: string;
};

function normalizeNode(node: CodeTaskGroupNode): CodeTaskGroupNode {
  if (node.type === "group")
    return { type: "group", groupId: node.groupId.toLowerCase() };
  return {
    type: "task",
    task: {
      hostId: node.task.hostId,
      taskId: node.task.taskId.toLowerCase(),
      workspacePath: node.task.workspacePath,
      workspaceIdentity: node.task.workspaceIdentity,
    },
  };
}

function nodeIdentity(node: CodeTaskGroupNode): TaskGroupMoveNode {
  return node.type === "group"
    ? { type: "group", id: node.groupId }
    : { type: "task", id: node.task.taskId };
}

export function taskGroupMoveIntent(
  input: CodeTaskGroupMove,
): TaskGroupMoveIntent {
  const node = normalizeNode(input.node);
  const anchor = input.anchor
    ? { node: normalizeNode(input.anchor.node), side: input.anchor.side }
    : null;
  const sourceGroupId = input.sourceGroupId?.toLowerCase() ?? null;
  const groupId = input.groupId?.toLowerCase() ?? null;
  const references: CodeTaskGroupTaskRef[] = [];
  if (node.type === "task") references.push(node.task);
  if (anchor?.node.type === "task") references.push(anchor.node.task);
  return {
    node: nodeIdentity(node),
    sourceGroupId,
    groupId,
    expectedRevision: input.expectedRevision,
    anchor: anchor
      ? { node: nodeIdentity(anchor.node), side: anchor.side }
      : null,
    references: taskGroupTaskReferences(references),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          node,
          sourceGroupId,
          groupId,
          expectedRevision: input.expectedRevision,
          anchor,
        }),
      )
      .digest("hex"),
  };
}
