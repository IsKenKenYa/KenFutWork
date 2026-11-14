import type { PaneSplitSide } from "@zui/v4/paneLayoutTree.js";
import {
  canonicalLocalWorkspaceIdentity,
  parseLocalWorkspaceIdentity,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { conversationTaskControlSchema } from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

export const WORKBENCH_SESSION_DRAG_MIME = "application/x-zcode-session";

export interface WorkbenchSessionDragPayload {
  readonly kind: "zcode/session";
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
  readonly sessionId: string;
  readonly sourceProjectId?: string;
  readonly observedRevision?: number;
}

export interface WorkbenchProjectTaskDragPayload extends WorkbenchSessionDragPayload {
  readonly workspaceIdentity: string;
  readonly sourceProjectId: string;
  readonly observedRevision: number;
}

const taskIdSchema = z.uuid();
const sessionDragPayloadSchema = z
  .object({
    kind: z.literal("zcode/session"),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
    remoteSessionId: z.string().min(1).optional(),
    sessionId: z.string().min(1),
    sourceProjectId: z.uuid().optional(),
    observedRevision: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.sourceProjectId === undefined && payload.observedRevision === undefined) return;
    const identity = parseLocalWorkspaceIdentity(payload.workspaceIdentity, payload.workspacePath);
    if (
      payload.sourceProjectId === undefined ||
      payload.observedRevision === undefined ||
      payload.remoteSessionId !== undefined ||
      identity?.projectId !== payload.sourceProjectId ||
      payload.workspaceIdentity !== canonicalLocalWorkspaceIdentity(payload.sourceProjectId, payload.workspacePath) ||
      !taskIdSchema.safeParse(payload.sessionId).success
    ) context.addIssue({ code: "custom", message: "Task项目拖动缺少一致的来源观察。" });
  })
  .transform((payload): WorkbenchSessionDragPayload => ({
    kind: payload.kind,
    workspacePath: payload.workspacePath,
    sessionId: payload.sessionId,
    ...(payload.workspaceIdentity !== undefined ? { workspaceIdentity: payload.workspaceIdentity } : {}),
    ...(payload.remoteSessionId !== undefined ? { remoteSessionId: payload.remoteSessionId } : {}),
    ...(payload.sourceProjectId !== undefined ? { sourceProjectId: payload.sourceProjectId } : {}),
    ...(payload.observedRevision !== undefined ? { observedRevision: payload.observedRevision } : {}),
  }));

let activeWorkbenchSessionDragPayload: WorkbenchSessionDragPayload | null = null;

interface DataTransferLike {
  readonly types?: Iterable<string> | ArrayLike<string>;
  getData(type: string): string;
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function serializeWorkbenchSessionDragPayload(payload: WorkbenchSessionDragPayload): string {
  return JSON.stringify(payload);
}

export function createWorkbenchSessionDragPayload(
  task: Pick<
    ZCodeTaskMeta,
    "taskId" | "workspacePath" | "workspaceIdentity" | "taskControl" | "conversationRevision"
  >,
  remoteSessionId?: string,
): WorkbenchSessionDragPayload {
  const payload: WorkbenchSessionDragPayload = {
    kind: "zcode/session",
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  };
  const control = conversationTaskControlSchema.safeParse(task.taskControl);
  if (!control.success) return payload;
  const observed = sessionDragPayloadSchema.safeParse({
    ...payload,
    sourceProjectId: control.data.projectId,
    observedRevision: task.conversationRevision,
  });
  return observed.success ? observed.data : payload;
}

export function setActiveWorkbenchSessionDragPayload(payload: WorkbenchSessionDragPayload): void {
  activeWorkbenchSessionDragPayload = { ...payload };
}

export function clearActiveWorkbenchSessionDragPayload(): void {
  activeWorkbenchSessionDragPayload = null;
}

function dataTransferHasType(dataTransfer: DataTransferLike): boolean {
  return Array.from(dataTransfer.types ?? []).includes(WORKBENCH_SESSION_DRAG_MIME);
}

export function parseWorkbenchSessionDragPayload(
  dataTransfer: DataTransferLike,
): WorkbenchSessionDragPayload | null {
  if (!dataTransferHasType(dataTransfer)) {
    return null;
  }
  try {
    const raw = dataTransfer.getData(WORKBENCH_SESSION_DRAG_MIME);
    const parsed = sessionDragPayloadSchema.safeParse(
      raw ? JSON.parse(raw) : activeWorkbenchSessionDragPayload,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseWorkbenchProjectTaskDragPayload(
  dataTransfer: DataTransferLike,
): WorkbenchProjectTaskDragPayload | null {
  const payload = parseWorkbenchSessionDragPayload(dataTransfer);
  if (!payload || payload.workspaceIdentity === undefined || payload.sourceProjectId === undefined || payload.observedRevision === undefined)
    return null;
  return {
    ...payload,
    workspaceIdentity: payload.workspaceIdentity,
    sourceProjectId: payload.sourceProjectId,
    observedRevision: payload.observedRevision,
  };
}

export function resolveWorkbenchDropSide(
  rect: RectLike,
  clientX: number,
  clientY: number,
): PaneSplitSide | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }

  const distances: Array<readonly [PaneSplitSide, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["up", y],
    ["down", 1 - y],
  ];
  const [side, distance] = distances.reduce((best, candidate) =>
    candidate[1] < best[1] ? candidate : best,
  );

  return distance <= 0.32 ? side : null;
}
