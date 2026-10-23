import { codeTaskGroupSchema } from "@kenfutwork/shared";
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
