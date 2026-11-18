import {
  type CodeTaskGroupStructure,
  codeTaskGroupSchema,
} from "@kenfutwork/shared";
import type { SqlRow } from "../persistence/types.js";

export type TaskGroupRow = SqlRow & {
  id: string;
  title: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export function projectTaskGroup(row: TaskGroupRow) {
  return codeTaskGroupSchema.parse({
    id: row.id,
    title: row.title,
    color: row.color,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  });
}

type RootNode = CodeTaskGroupStructure["order"][number];

/** 读取和整理共用完整投影键，保留相同位置的根节点次序。 */
export function compareTaskGroupRootNodes(a: RootNode, b: RootNode) {
  return (
    a.sortOrder - b.sortOrder ||
    a.type.localeCompare(b.type) ||
    a.key.localeCompare(b.key)
  );
}
