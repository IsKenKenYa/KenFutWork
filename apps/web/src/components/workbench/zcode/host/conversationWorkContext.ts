import type { ConversationWorkContext } from "@zcode/shared/zcode-protocol-v4";
import { readImageModelPreference } from "./media/useImageModelPreference.js";
import { readVideoModelPreference } from "./media/useVideoModelPreference.js";

type CanvasContext = Pick<
  ConversationWorkContext,
  "canvasId" | "selectedCanvasElements" | "brandKitId"
> & { title: string };
const contexts = new Map<string, CanvasContext>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => {
  revision++;
  for (const listener of listeners) listener();
};

export function setCanvasConversationContext(
  projectId: string,
  context: CanvasContext,
) {
  contexts.set(projectId, structuredClone(context));
  publish();
}
export function clearCanvasConversationContext(
  projectId: string,
  canvasId?: string,
) {
  if (canvasId && contexts.get(projectId)?.canvasId !== canvasId) return;
  contexts.delete(projectId);
  publish();
}
export function withoutCanvasContext(
  context: ConversationWorkContext,
): ConversationWorkContext {
  const {
    canvasId: _canvas,
    selectedCanvasElements: _selection,
    ...next
  } = structuredClone(context);
  return next;
}
export function getCanvasConversationContext(projectId: string) {
  const context = contexts.get(projectId);
  return context ?? null;
}
export function conversationWorkContext(
  projectId: string | null,
  preset: "code" | "design",
): ConversationWorkContext {
  const context =
    preset === "design" && projectId
      ? getCanvasConversationContext(projectId)
      : null;
  return structuredClone({
    preset,
    ...(preset === "design"
      ? {
          imageGenerationPreference: readImageModelPreference(),
          videoGenerationPreference: readVideoModelPreference(),
        }
      : {}),
    ...(context
      ? {
          canvasId: context.canvasId,
          selectedCanvasElements: context.selectedCanvasElements,
          ...(context.brandKitId ? { brandKitId: context.brandKitId } : {}),
        }
      : {}),
  });
}
export const subscribeCanvasConversationContext = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const canvasConversationContextRevision = () => revision;

export const OPEN_DOCUMENT_EVENT = "kenfutwork:open-document";
export interface OpenCanvasDocumentRequest {
  projectId: string;
  documentId?: string;
  title: string;
}
const pendingDocuments = new Map<string, OpenCanvasDocumentRequest>();
export function takeCanvasDocumentOpen(projectId: string) {
  const pending = pendingDocuments.get(projectId);
  pendingDocuments.delete(projectId);
  return pending;
}
export function requestCanvasDocumentOpen(detail: OpenCanvasDocumentRequest) {
  pendingDocuments.set(detail.projectId, structuredClone(detail));
  window.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_EVENT, { detail }));
}
