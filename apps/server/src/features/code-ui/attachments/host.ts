import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AuthenticatedUser } from "../../auth/types.js";
import type { ViewerService } from "../../bootstrap/ensure-user-foundation.js";
import type { BlobStore } from "../../blob/types.js";
import type { SettingsService } from "../../settings/settings-service.js";
import type { CodeUiRepository } from "../repository.js";
import { createCodeAttachmentsService } from "./service.js";
import { CodeAttachmentError, type CodeAttachmentRepository, type CodeAttachmentSession } from "./types.js";
import { codeAttachmentLimits } from "./budget.js";

export function createCodeAttachmentHost(deps: {
  repository: CodeUiRepository;
  attachments: CodeAttachmentRepository;
  blob: BlobStore;
  viewer: ViewerService;
  settings: SettingsService;
}) {
  async function owned(actor: AuthenticatedUser, sessionId: string) {
    const workspace = await deps.viewer.resolveWorkspace(actor);
    const entry = await deps.repository.find(workspace.id, sessionId);
    const root = entry?.root_session_id === entry?.id ? entry : entry ? await deps.repository.find(workspace.id, entry.root_session_id) : null;
    if (!entry || !root?.state || root.parent_session_id || entry.deleted_at || root.deleted_at || entry.project_id !== root.project_id) throw new CodeAttachmentError("fault.attachment.notAuthorized", "Code附件所属Task不存在或不可见。", 404);
    const snapshot = root.state.snapshots.find((value) => value.sessionId === sessionId);
    if (!snapshot) throw new CodeAttachmentError("fault.attachment.notAuthorized", "附件所属会话不在该Task中。", 404);
    return { entry, root, snapshot, workspaceId: workspace.id };
  }
  return createCodeAttachmentsService({
    blob: deps.blob, repository: deps.attachments,
    authorizeWorkspace: async (actor) => (await deps.viewer.resolveWorkspace(actor)).id,
    authorizeSession: async (actor, sessionId): Promise<CodeAttachmentSession> => {
      const value = await owned(actor, sessionId);
      return { workspaceId: value.workspaceId, projectId: value.root.project_id, taskId: value.root.id, sessionId,
        userId: actor.id, scopeGeneration: Number(value.root.scope_generation), branchGeneration: Number(value.root.branch_generation), revision: Number(value.root.revision),
        canUpload: !value.entry.parent_session_id && !value.root.archived && value.root.execution_state === "ready",
      };
    },
    authorizeRow: async (actor, request): Promise<protocol.AttachmentRef> => {
      const { snapshot } = await owned(actor, request.sessionId);
      const matches = snapshot.rows.window.flatMap((row) => {
        if (row.kind !== "userInput") return [];
        if (request.target && (row.rowId !== request.target.rowId || row.entityId !== request.target.entityId)) return [];
        return (row.attachments ?? []).flatMap((attachment, index) => attachment.ref === request.ref && (request.attachmentIndex === undefined || request.attachmentIndex === index) ? [attachment] : []);
      });
      if (matches.length !== 1) throw new CodeAttachmentError("fault.attachment.notAuthorized", "附件引用与消息位置不匹配，或需要明确消息位置。", 404);
      return matches[0]!;
    },
    limits: async (actor, workspaceId) => {
      const settings = await deps.settings.getWorkspaceSettings(actor, workspaceId);
      return codeAttachmentLimits(settings);
    },
  });
}
