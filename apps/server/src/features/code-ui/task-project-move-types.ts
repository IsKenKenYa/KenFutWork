import {
  type CodeTaskProjectMoveInput,
  codeTaskProjectMoveArgsSchema,
  codeTaskProjectMoveInputSchema,
} from "@kenfutwork/shared";
import { CodeUiHostRpcError } from "./host-rpc-handler.js";

export const taskProjectMoveInputSchema = codeTaskProjectMoveInputSchema;
export const taskProjectMoveArgsSchema = codeTaskProjectMoveArgsSchema;
export type TaskProjectMoveInput = CodeTaskProjectMoveInput;
export interface TaskProjectMoveEvent {
  instanceId: string;
  taskId: string;
  sourceProjectId: string;
  targetProjectId: string;
  scopeGeneration: number;
  workspacePath: string;
  sessionIds: readonly string[];
}

export function moveConflict(message: string) {
  return new CodeUiHostRpcError("project.task-move-conflict", message, 409);
}

export function moveNotFound() {
  return new CodeUiHostRpcError(
    "project.task-not-found",
    "任务或项目已删除，请重新打开项目。",
    404,
  );
}
