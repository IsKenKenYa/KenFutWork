import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { BrandKitService } from "../brand-kit/brand-kit-service.js";
import { binaryMimeType } from "../code-tools/file-media.js";
import type { CodeUiConversationState } from "../code-ui/conversation.js";
import type {
  ConversationWorkContextProvider,
  WorkContextBinding,
} from "../code-ui/work-context.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import type {
  ProjectFileLocation,
  ProjectFileService,
} from "../project-files/types.js";
import { ProjectFileError } from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { CanvasService } from "./canvas-service.js";
import type { CanvasRepository } from "./repository.js";
import { selectedCanvasElement } from "./selection-context.js";

export interface CanvasDocumentAccess extends ConversationWorkContextProvider {
  authorize(
    context: ToolExecutionContext,
    canvasId?: string,
    operation?: "read" | "write",
  ): Promise<LocalActor>;
  resolveMediaReferences(
    context: ToolExecutionContext,
    requests: { reference: string; mediaType: "image" | "video" }[],
  ): Promise<string[]>;
}

type TaskRow = SqlRow & {
  project_id: string;
  active_run_id: string | null;
  scope_generation: number | string;
  branch_generation: number | string;
  execution_state: string;
  state: Pick<
    CodeUiConversationState,
    "inputs" | "runWorkContexts" | "snapshots" | "closedRuns"
  >;
};

/** 项目文档权限独立于文件目录权限；唯一执行身份仍由统一Task/Run持有。 */
export function createCanvasDocumentAccess(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
  projects: Pick<ProjectService, "getProject">;
  canvas: Pick<CanvasService, "getCanvas">;
  canvases: Pick<CanvasRepository, "findById">;
  projectFiles: Pick<ProjectFileService, "inspect" | "read">;
  brandKit: Pick<BrandKitService, "readAsset">;
  settings: Pick<SettingsService, "getInstanceSettings">;
}): CanvasDocumentAccess {
  const checkDocument = async (
    actor: LocalActor,
    projectId: string,
    canvasId?: string,
    preset: "code" | "design" = "design",
  ) => {
    await deps.localInstance.resolve(actor);
    const project = await deps.projects.getProject(actor, projectId);
    if (
      !project.enabled_modes.includes(preset) ||
      (canvasId && !project.enabled_modes.includes("design"))
    )
      throw new Error("请先为项目启用相应工作方式。");
    if (!canvasId) return null;
    const canvas = await deps.canvases.findById(actor.instanceId, canvasId);
    if (!canvas || canvas.project_id !== projectId)
      throw new Error("画布已删除或不属于当前项目，请重新选择。 ");
    return canvas;
  };
  const revalidate = async (input: WorkContextBinding) => {
    const context = protocol.conversationWorkContextSchema.parse(input.context);
    const row = await deps.persistence
      .forInstance(input.actor.instanceId)
      .queryOne<TaskRow>(
        `select s.project_id,s.active_run_id,s.scope_generation,s.branch_generation,s.execution_state,s.state
       from public.code_ui_sessions s join public.projects p on p.id=s.project_id and p.instance_id=s.instance_id
       where s.instance_id=:instance and s.id=$1 and s.parent_session_id is null
         and s.deleted_at is null and s.archived=false and p.archived_at is null`,
        [input.taskId],
      );
    const frozen =
      row?.state?.runWorkContexts?.find(([id]) => id === input.runId)?.[1] ??
      row?.state?.inputs?.find((entry) => entry.runId === input.runId)?.intent
        ?.workContext;
    let active = row?.active_run_id === input.runId;
    if (!active && row && input.sessionId) {
      const child = await deps.persistence
        .forInstance(input.actor.instanceId)
        .queryOne<{ id: string }>(
          `select s.id from public.code_ui_sessions s where s.instance_id=:instance
         and s.root_session_id=$1 and (s.id=$2 or s.chat_session_id=$2)
         and s.parent_session_id is not null and s.deleted_at is null and s.archived=false`,
          [input.taskId, input.sessionId],
        );
      const snapshot = row.state?.snapshots?.find(
        (entry) => entry.sessionId === child?.id,
      );
      active = Boolean(
        snapshot?.control.activeWorks.some(
          (work) => work.foregroundExecutionId === input.runId,
        ),
      );
    }
    if (
      !row ||
      row.project_id !== input.projectId ||
      !active ||
      row.state?.closedRuns?.includes(input.runId) ||
      row.execution_state !== "ready" ||
      Number(row.scope_generation) !== input.scopeGeneration ||
      Number(row.branch_generation) !== input.branchGeneration ||
      !frozen ||
      !isDeepStrictEqual(frozen, context)
    )
      throw new Error("画布任务或运行授权已改变，请重新提交。 ");
    await checkDocument(
      input.actor,
      input.projectId,
      context.canvasId,
      context.preset,
    );
    if (context.brandKitId) {
      const kit = await deps.persistence
        .forInstance(input.actor.instanceId)
        .queryOne(
          `select id from public.brand_kits where instance_id=:instance and id=$1`,
          [context.brandKitId],
        );
      if (!kit) throw new Error("品牌素材已删除或不可用，请重新选择。 ");
    }
  };
  const access: CanvasDocumentAccess = {
    async prepare(input) {
      const context = protocol.conversationWorkContextSchema.parse(
        input.context,
      );
      const canvas = await checkDocument(
        input.actor,
        input.projectId,
        context.canvasId,
        context.preset,
      );
      if (context.brandKitId) {
        const kit = await deps.persistence
          .forInstance(input.actor.instanceId)
          .queryOne(
            `select id from public.brand_kits where instance_id=:instance and id=$1`,
            [context.brandKitId],
          );
        if (!kit) throw new Error("品牌素材已删除或不可用，请重新选择。 ");
      }
      if (context.selectedCanvasElements?.length) {
        const content = canvas
          ? (await deps.canvas.getCanvas(input.actor, canvas.id)).content
          : null;
        const selected = context.selectedCanvasElements.map((element) => {
          const current = content?.elements.find(
            (candidate) => candidate.id === element.id && !candidate.isDeleted,
          );
          if (!current) throw new Error("画布选区已改变，请重新选择。 ");
          return selectedCanvasElement(current, content?.files ?? {});
        });
        return { ...context, selectedCanvasElements: selected };
      }
      return structuredClone(context);
    },
    revalidate,
    async authorize(context, canvasId, operation = "read") {
      const { actor, scopeHandle: handle, runId, workContext } = context;
      if (
        !actor ||
        !handle ||
        !runId ||
        !workContext ||
        actor.instanceId !== context.instanceId
      )
        throw new Error("画布工具必须绑定可信Task和Run。 ");
      context.signal?.throwIfAborted();
      const scope = handle.describe();
      if (
        scope.instanceId !== actor.instanceId ||
        context.canvasId !== workContext.canvasId
      )
        throw new Error("画布与运行冻结上下文不一致。 ");
      if (
        operation === "write" &&
        (handle.role === "explore" ||
          handle.role === "review" ||
          scope.sandboxMode === "read-only" ||
          context.approvedExecutionMode === "plan")
      )
        throw new Error("当前任务只读，不能修改画布。 ");
      if (
        operation === "write" &&
        (await context.codeApproval?.resolve())?.mode === "plan"
      )
        throw new Error("当前任务只读，不能修改画布。 ");
      await revalidate({
        actor,
        projectId: scope.projectId,
        taskId: scope.taskId,
        runId,
        scopeGeneration: scope.generation,
        branchGeneration: handle.branchGeneration,
        context: workContext,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      });
      if (canvasId && canvasId !== workContext.canvasId)
        await checkDocument(actor, scope.projectId, canvasId);
      context.signal?.throwIfAborted();
      return actor;
    },
    async resolveMediaReferences(context, requests) {
      if (!requests.length) return [];
      const actor = await access.authorize(context);
      const projectId = context.scopeHandle!.describe().projectId;
      const settings = await deps.settings.getInstanceSettings(
        actor,
        actor.instanceId,
      );
      if (requests.length > settings.codeAttachmentMaxPerInput)
        throw new Error("参考素材数量超过限制，请减少素材或调整设置。 ");
      let remaining = settings.codeAttachmentStagedMaxBytes;
      const resolved: string[] = [];
      for (const { reference, mediaType } of requests) {
        const maximum = Math.min(settings.codeAttachmentMaxBytes, remaining);
        const attached = context.userAttachmentMap?.[reference];
        const value = attached ?? reference;
        const remote = remoteReference(value);
        if (remote) {
          resolved.push(remote);
          continue;
        }
        let bytes: Uint8Array;
        let mimeType: string;
        if (value.startsWith("data:")) {
          ({ bytes, mimeType } = readMediaDataUri(value, mediaType, maximum));
        } else {
          const id = z.uuid().safeParse(reference);
          if (!id.success)
            throw new Error("参考素材无法识别，请使用素材标识或图片地址。 ");
          let location: ProjectFileLocation | undefined;
          try {
            location = await deps.projectFiles.inspect(actor, id.data);
          } catch (error) {
            if (
              !(error instanceof ProjectFileError) ||
              error.code !== "not_found"
            )
              throw error;
          }
          if (location) {
            if (location.projectId !== projectId)
              throw new Error(
                "参考素材不属于当前项目，请明确授权后重新选择。 ",
              );
            const selected = context.workContext?.selectedCanvasElements?.find(
              (element) =>
                (element.customData as Record<string, unknown> | undefined)
                  ?.assetId === id.data,
            );
            const version = (
              selected?.customData as Record<string, unknown> | undefined
            )?.assetVersion;
            if (typeof version === "string" && version !== location.version)
              throw new Error("选区素材已变化，请重新选择并发送。 ");
            bytes = await deps.projectFiles.read(actor, id.data, {
              maxBytes: maximum,
            });
            const after = await deps.projectFiles.inspect(actor, id.data);
            if (
              createHash("sha256").update(bytes).digest("hex") !==
                location.version ||
              after.projectId !== projectId ||
              after.version !== location.version ||
              after.relativePath !== location.relativePath
            )
              throw new Error("参考素材在读取期间变化，请重新选择。 ");
            mimeType = referenceMimeType(Buffer.from(bytes), mediaType);
          } else {
            const brandKitId = context.workContext?.brandKitId;
            if (!brandKitId)
              throw new Error("参考素材已删除或不可用，请重新选择。 ");
            const asset = await deps.brandKit.readAsset(
              actor,
              brandKitId,
              id.data,
              maximum,
            );
            bytes = asset.bytes;
            mimeType = asset.mimeType;
          }
        }
        if (!mimeType.startsWith(`${mediaType}/`))
          throw new Error("参考素材格式不匹配，请重新选择图片或视频。 ");
        if (bytes.byteLength > maximum)
          throw new Error("参考素材超过读取限制，请减少素材或调整设置。 ");
        remaining -= bytes.byteLength;
        resolved.push(
          `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        );
      }
      await access.authorize(context);
      return resolved;
    },
  };
  return access;
}

function remoteReference(value: string): string | null {
  if (!/^https?:\/\//u.test(value)) return null;
  const url = new URL(value);
  if (
    ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost")
  )
    throw new Error("本机素材地址不能用作参考，请使用素材标识。 ");
  return value;
}

function readMediaDataUri(
  value: string,
  mediaType: "image" | "video",
  maximum: number,
) {
  const match =
    /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match || !match[1]?.startsWith(`${mediaType}/`))
    throw new Error("参考素材格式无法识别，请重新上传。 ");
  const encoded = match[2] ?? "";
  if (encoded.length > Math.ceil(maximum / 3) * 4)
    throw new Error("参考素材超过读取限制，请减少素材或调整设置。 ");
  const bytes = Buffer.from(encoded, "base64");
  const mimeType = referenceMimeType(bytes, mediaType);
  if (mimeType !== match[1])
    throw new Error("参考素材格式与内容不一致，请重新上传。 ");
  return { bytes, mimeType };
}

function referenceMimeType(bytes: Buffer, mediaType: "image" | "video") {
  if (mediaType === "image") return binaryMimeType(bytes);
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp")
    return bytes.subarray(8, 12).toString("ascii") === "qt  "
      ? "video/quicktime"
      : "video/mp4";
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, 128).includes(Buffer.from("webm"))
  )
    return "video/webm";
  throw new Error("参考视频格式无法识别，请重新上传MP4或WebM。 ");
}
