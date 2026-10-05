import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  clampSubagentMaxContinuations,
  type ImageAttachment,
  type ImageGenerationPreference,
  type InstanceSettings,
  type MessageMention,
  type RunCancelResponse,
  type RunCreateRequest,
  type RunCreateResponse,
  resolveContextWindow,
  type StreamEvent,
  type VideoGenerationPreference,
} from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage } from "@langchain/core/messages";
import type { ServerEnv } from "../config/env.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type {
  AgentTurnBoundary,
  AgentTurnBoundaryPhase,
} from "../features/agent-runs/types.js";
import type { BlobStore } from "../features/blob/types.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import { buildCanvasSummaryForContext } from "../features/canvas/tools/inspect-canvas.js";
import type { TurnBoundaryCapture } from "../features/checkpoints/checkpoint-service.js";
import type { FileLimits } from "../features/code-tools/file-types.js";
import type {
  CodeProjectContext,
  CodeProjectContextLimits,
} from "../features/code-tools/project-instructions-types.js";
import type { TrustedCodeInput } from "../features/code-ui/attachments/input-types.js";
import { codeInputContent } from "../features/code-ui/attachments/model-input.js";
import type { ExecutionScopeHandle } from "../features/execution/scope-service.js";
// execute 工具由 deepagents 内置提供（LocalShellBackend 作为 sandbox backend）
// 不需要自定义代码执行工具
import type {
  SubmitImageJobFn,
  SubmitVideoJobFn,
} from "../features/generation/tool-types.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import { resolveModelInputCapabilities } from "../features/model-providers/input-capabilities.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import { parseInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type {
  ProcessLimits,
  ProcessSandbox,
} from "../features/process-sandbox/types.js";
import { hooksFor, runHooks } from "../features/settings/hooks.js";
import { createScopedHookCommand } from "../features/settings/scoped-hook-command.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { formatUserRulesFragment } from "../features/settings/user-rules.js";
import type {
  TaskWorkContext,
  TaskWorkManager,
} from "../features/task-work/types.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../generation/types.js";
import { publicToolArguments } from "../kernel/tool-arguments.js";
import type {
  PreStepPayload,
  PromptCompositionContext,
  SystemPromptRegistry,
  ToolExecutionContext,
  ToolRegistry,
} from "../kernel/types.js";
import { instanceHeadersOption } from "../providers/instance-headers.js";
import { resolveInstanceChatModel } from "../providers/resolve.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createPipelineLogger } from "../ws/logger.js";
import { type CompactionPlan, resolveCompactionPlan } from "./auto-compact.js";
import { createAgentBackend } from "./backends/index.js";
import {
  type BackgroundTaskRegistry,
  createBackgroundTaskRegistry,
} from "./background-tasks.js";
import { streamCompactOperation } from "./compact-operation.js";
import type {
  AgentContextBranchCloneInput,
  AgentContextBranchService,
  AgentContextBranchTargetInput,
} from "./context-history.js";
import type { ToolGate, ToolGateHooks } from "./deep-agent.js";
import {
  createDefaultModelSpecifier,
  createKenFutWorkDeepAgent,
  type KenFutWorkAgent,
  type KenFutWorkAgentFactory,
} from "./deep-agent.js";
import {
  MODEL_USAGE_OWNER_METADATA,
  type ModelCallUsage,
} from "./model-call-usage.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { measureTools } from "./prompt-composition.js";
import type { AgentRunExtension } from "./run-extension.js";
import { withBoundWorkDir } from "./sandbox-dir.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";
import { formatTaskNotificationsXml } from "./task-notifications.js";
import {
  createToolDenialTracker,
  type ToolDenialRecord,
} from "./tool-denial.js";
import {
  type AgentTurnBoundaryFacts,
  captureAgentTurnBoundaryFacts,
} from "./turn-boundaries.js";
import type {
  InstanceSkillEntry,
  InstanceSkillsByInstanceLoader,
  InstanceSkillsLoader,
} from "./workspace-skills.js";
/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
/**
 * run → agent preset（DEC-2 会话级能力集），**模式能力分离的口径源头**：
 * - Code 通过可信 Task scope 选择编码能力，画布身份不参与执行；
 * - 未显式声明时按 canvasId 兜底：有画布归 design（画布页会话），无画布归 code。
 */
export function resolvePresetForRun(run: {
  canvasId?: string | undefined;
  preset?: "design" | "code" | undefined;
  scopeHandle?: ExecutionScopeHandle | undefined;
}): "design" | "code" {
  if (run.scopeHandle) return "code";
  return run.preset ?? (run.canvasId ? "design" : "code");
}

/**
 * 首轮消息的画布状态摘要（`<canvas_state>`）：**仅 design 注入**。
 *
 * Code 的持久 Task 与画布分离；画布摘要只供 Design 使用。仓储缺席或画布解析失败
 * 一律返回 null（非关键：design 下 agent 仍可手动 inspect_canvas）。
 */
export async function resolveCanvasStateForRun(
  run: {
    canvasId?: string | undefined;
    actor?: LocalActor | undefined;
    preset?: "design" | "code" | undefined;
  },
  deps: {
    canvasRepository?: CanvasRepository;
    localInstance?: LocalInstanceService;
  },
): Promise<string | null> {
  if (
    resolvePresetForRun(run) !== "design" ||
    !run.canvasId ||
    !run.actor ||
    !deps.canvasRepository
  ) {
    return null;
  }
  try {
    const canvasWorkspace = await deps.localInstance
      ?.resolve(run.actor)
      .catch(() => null);
    const canvasRow = canvasWorkspace
      ? await deps.canvasRepository
          .findById(canvasWorkspace.instanceId, run.canvasId)
          .catch(() => null)
      : null;
    const content = canvasRow?.content as { elements?: unknown[] } | undefined;
    if (content?.elements) {
      return buildCanvasSummaryForContext(
        content.elements as Array<Record<string, unknown>>,
      );
    }
    return null;
  } catch {
    // Non-critical — agent can still call inspect_canvas manually
    return null;
  }
}

export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  mentions: MessageMention[] = [],
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
  instanceSkillSource?: "database",
): { text: string } {
  const xmlBlocks: string[] = [];

  // Canvas state context (auto-injected, not user-provided)
  if (canvasSummary) {
    xmlBlocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }

  const inputImagesXml = buildInputImagesXml(attachments);
  if (inputImagesXml) xmlBlocks.push(inputImagesXml);

  const imageGenerationPreferenceXml = buildImageGenerationPreferenceXml(
    imageGenerationPreference,
  );
  if (imageGenerationPreferenceXml)
    xmlBlocks.push(imageGenerationPreferenceXml);

  const videoGenerationPreferenceXml = buildVideoGenerationPreferenceXml(
    videoGenerationPreference,
  );
  if (videoGenerationPreferenceXml)
    xmlBlocks.push(videoGenerationPreferenceXml);

  const mentionXmlBlocks = buildMentionXmlBlocks(mentions, instanceSkillSource);
  xmlBlocks.push(...mentionXmlBlocks);

  if (!xmlBlocks.length) return { text: prompt };
  return { text: `${prompt}\n\n${xmlBlocks.join("\n\n")}` };
}

function buildInputImagesXml(attachments: ImageAttachment[]): string | null {
  if (attachments.length === 0) return null;

  const imageXml = attachments
    .map((attachment, i) => {
      const nameAttr = attachment.name
        ? ` name="${escapeXmlAttribute(attachment.name)}"`
        : "";
      return `<image index="${i + 1}" asset_id="${escapeXmlAttribute(attachment.assetId)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}"${nameAttr} />`;
    })
    .join("\n  ");

  return `<input_images count="${attachments.length}">\n  ${imageXml}\n</input_images>`;
}

function buildImageGenerationPreferenceXml(
  imageGenerationPreference?: ImageGenerationPreference,
): string | null {
  if (
    imageGenerationPreference?.mode !== "manual" ||
    imageGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = imageGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_image_generation_preference mode="manual" count="${imageGenerationPreference.models.length}">\n  ${modelXml}\n</human_image_generation_preference>`;
}

function buildVideoGenerationPreferenceXml(
  videoGenerationPreference?: VideoGenerationPreference,
): string | null {
  if (
    videoGenerationPreference?.mode !== "manual" ||
    videoGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = videoGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_video_generation_preference mode="manual" count="${videoGenerationPreference.models.length}">\n  ${modelXml}\n</human_video_generation_preference>`;
}

function buildMentionXmlBlocks(
  mentions: MessageMention[],
  instanceSkillSource?: "database",
): string[] {
  const xmlBlocks: string[] = [];

  const mentionedModels = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "image-model" }> =>
      mention.mentionType === "image-model",
  );
  if (mentionedModels.length > 0) {
    const modelXml = mentionedModels
      .map(
        (mention, i) =>
          `<model index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" display_name="${escapeXmlAttribute(mention.label)}" />`,
      )
      .join("\n  ");

    xmlBlocks.push(
      `<human_image_model_mentions count="${mentionedModels.length}">\n  ${modelXml}\n</human_image_model_mentions>`,
    );
  }

  const mentionedBrandKitAssets = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "brand-kit-asset" }> =>
      mention.mentionType === "brand-kit-asset",
  );
  if (mentionedBrandKitAssets.length > 0) {
    const assetXml = mentionedBrandKitAssets
      .map((mention, i) => {
        const textContentAttr =
          mention.textContent != null
            ? ` text_content="${escapeXmlAttribute(mention.textContent)}"`
            : "";
        const fileUrlAttr =
          mention.fileUrl != null
            ? ` file_url="${escapeXmlAttribute(mention.fileUrl)}"`
            : "";
        return `<brand_kit_asset index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" type="${escapeXmlAttribute(mention.assetType)}" display_name="${escapeXmlAttribute(mention.label)}"${textContentAttr}${fileUrlAttr} />`;
      })
      .join("\n  ");

    xmlBlocks.push(
      `<human_brand_kit_mentions count="${mentionedBrandKitAssets.length}">\n  ${assetXml}\n</human_brand_kit_mentions>`,
    );
  }

  // Skill mentions — tell the agent to read and follow the mentioned skill
  const mentionedSkills = mentions.filter(
    (mention): mention is Extract<MessageMention, { mentionType: "skill" }> =>
      mention.mentionType === "skill",
  );
  if (mentionedSkills.length > 0) {
    const skillXml = mentionedSkills
      .map((mention, i) => {
        const readInstruction =
          instanceSkillSource === "database"
            ? `Call use_skill with name ${JSON.stringify(mention.slug)} for the installed skill instructions. Attached resources use use_skill resource_path; this DB installation is not a Native Read filesystem path.`
            : `Read \`/workspace-skills/${mention.slug}/SKILL.md\` for full instructions and follow them.`;
        return `<skill index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" name="${escapeXmlAttribute(mention.label)}" slug="${escapeXmlAttribute(mention.slug)}">\nThe user explicitly requested this skill. ${readInstruction}\n</skill>`;
      })
      .join("\n  ");
    xmlBlocks.push(
      `<human_skill_mentions count="${mentionedSkills.length}">\n  ${skillXml}\n</human_skill_mentions>`,
    );
  }

  return xmlBlocks;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a lookup map from assetId to base64 data URI.
 * Stored in configurable so tools can resolve assetId references.
 */
export function buildAttachmentDataMap(
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of downloaded) {
    map[d.assetId] = `data:${d.mimeType};base64,${d.base64}`;
  }
  return map;
}

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

type RuntimeRunRecord = RunCreateRequest & {
  acceptedCancellation?: Promise<void>;
  branchGeneration?: number;
  turnBoundaryWrites?: Partial<
    Record<
      AgentTurnBoundaryPhase,
      { boundary: AgentTurnBoundary; persisted: boolean }
    >
  >;
  inputIdentity?: { clientId: string; sourceCommandId: string };
  inputOrigin?: "userInput" | "backgroundResult" | "controlOperation";
  operation?: { kind: "compact" };
  codeInputs?: TrustedCodeInput[];
  projectToolInput?: (
    name: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  modelInvocation?: ModelInvocationSnapshot;
  approvalCeiling?: import("../features/permissions/approval-types.js").CodeApprovalMode;
  delegationDepth?: number;
  roleInstructions?: string;
  eventSink?: (event: StreamEvent) => Promise<void>;
  /** Code 的可信 Task 工作域；目录与角色授权由服务端解析，不能由请求伪造。 */
  scopeHandle?: ExecutionScopeHandle;
  actor: LocalActor;
  consumed: boolean;
  controller: AbortController;
  modelOverride?: string;
  runId: string;
  /** Design 的显式画布沙箱；Code 工作域完全由 scopeHandle 持有。 */
  sandboxScopeId?: string;
  status: RuntimeRunStatus;
  threadId?: string;
  /** 用量归属元数据（DEC-6），模型解析后填入；turn-stopping 结算时消费。 */
  usageMeta?: {
    provider: string;
    model: string;
    providerInstanceId?: string;
  };
};

type CreateAgentRuntimeOptions = {
  codeProjectContextLoader?: (
    scope: ExecutionScopeHandle,
    limits: CodeProjectContextLimits,
    signal?: AbortSignal,
  ) => Promise<CodeProjectContext>;
  resolveCodeApprovalMode?: (scope: ExecutionScopeHandle) => Promise<{
    mode: import("../features/permissions/approval-types.js").CodeApprovalMode;
    scopeGeneration: number;
    branchGeneration: number;
  }>;
  processSandbox?: ProcessSandbox;
  taskWork?: TaskWorkManager;
  resolveTaskWorkContext?: (
    actor: LocalActor,
    scopeHandle: ExecutionScopeHandle,
    runId: string,
  ) => Promise<TaskWorkContext>;
  runExtensions?: () => readonly AgentRunExtension[];
  agentPersistenceService?: Pick<AgentPersistenceService, "getPersistence">;
  contextBranchProvider?: AgentContextBranchService;
  agentFactory?: KenFutWorkAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  /** 画布数据访问（实例作用域）：run 启动时读画布摘要、解析 brandKitId。 */
  canvasRepository?: CanvasRepository;
  /** 画布写入（canvas 插件提供）：生成物落画布经此，运行时不再直连存储 SDK。 */
  canvasService?: CanvasService;
  /** 工作区技能加载（skills/canvas 聚合的数据访问提供）：运行时不再直连 SDK。 */
  instanceSkillsLoader?: InstanceSkillsLoader;
  /** Code技能按可信Task工作区读取，不通过Canvas或虚拟Store路径。 */
  instanceSkillsByInstanceLoader?: InstanceSkillsByInstanceLoader;
  /**
   * 画布 → 项目绑定的本机工作目录（`projects.work_dir`，判定见
   * features/projects/work-dir.ts）。命中时覆盖 `env.canvasWorkDirs`：
   * 用户在界面上绑定的目录优先于运维的环境变量映射。
   */
  projectWorkDirLoader?: (
    instanceId: string,
    canvasId: string,
  ) => Promise<string | null>;
  connectionManager?: ConnectionManager;
  /** 对象存储（blob 缝）：生成物落盘与 URL（M3.1 起不再直连 Supabase Storage）。 */
  blob: BlobStore;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  /** BYOK：实例 specifier（<instanceId>:<model>）经此解析为协议适配器模型。 */
  modelProviders?: ModelProviderService;
  /** 模型目录（run 起始期校验「实例:模型」是否存在；缺省跳过校验）。 */
  modelCatalog?:
    | Pick<ModelCatalogService, "validateSpecifier" | "listCatalog">
    | undefined;
  /** 实例设置（读「用户规则」拼进系统提示词；缺省不注入）。 */
  settingsService?: Pick<SettingsService, "getInstanceSettings"> | undefined;
  /** agent 链路用量累积器（turn-stopping 结算，DEC-6）。 */
  runUsage?: RunUsageAccumulator;
  /** 内核统一工具注册表：按 run 的 preset 过滤后桥接进模型工具列表（§4.5）。 */
  tools?: ToolRegistry;
  /** 内核系统提示段注册表：run 起始期组装系统提示（模式段/品牌/skills/规则与插件）。 */
  systemPromptRegistry?: SystemPromptRegistry;
  /** 事件缝（DEC-1）：turn 收尾时发射 turn-stopping，插件据此结算。 */
  emitTurnStopping?: (payload: { runId: string }) => Promise<void>;
  /**
   * 事件缝（DEC-1）：turn 开始时发射 pre-step（waterfall），插件可改写/拒绝模型输入。
   * 返回改写后的 input（无监听器时原样返回）。
   */
  emitPreStep?: (
    payload: PreStepPayload & {
      input: string;
      runId: string;
    },
  ) => Promise<{ input: unknown }>;
  /**
   * 执行模式工具门（agent-modes 缝经 agent-runs 插件注入）：按线程返回
   * solo/plan 的工具拦截判定；返回 undefined 表示全放行（agent 等模式）。
   */
  toolGateFor?: (threadId: string) => ToolGate | undefined;
  /**
   * 检查点钩子（checkpoints 缝，可选依赖）：轮次开始/结束时打影子 git 快照。
   * runtime 只负责在正确时机调用（beforeTurn 在流启动前、afterTurn 在收尾 finally，
   * 成功/失败/取消都走到）并兜住异常——hook 失败绝不影响 run 终态与收尾流程。
   */
  checkpointHooks?: {
    beforeTurn(ctx: {
      scope: ExecutionScopeHandle;
      actor: LocalActor;
      runId: string;
    }): Promise<TurnBoundaryCapture | void>;
    afterTurn(ctx: {
      scope: ExecutionScopeHandle;
      actor: LocalActor;
      runId: string;
    }): Promise<TurnBoundaryCapture | void>;
  };
  now?: () => string;
  runIdFactory?: () => string;
  localInstance: LocalInstanceService;
};

function copyRunInput(input: RunCreateRequest): RunCreateRequest {
  return {
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.canvasId ? { canvasId: input.canvasId } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.imageGenerationPreference
      ? { imageGenerationPreference: input.imageGenerationPreference }
      : {}),
    ...(input.videoGenerationPreference
      ? { videoGenerationPreference: input.videoGenerationPreference }
      : {}),
    ...(input.mentions ? { mentions: input.mentions } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
  };
}

function inputMessageIdFor(run: RuntimeRunRecord): string {
  return run.inputIdentity
    ? JSON.stringify([
        "code-input",
        run.scopeHandle?.describe().taskId ?? run.sessionId,
        run.inputOrigin ?? "userInput",
        run.inputIdentity.clientId,
        run.inputIdentity.sourceCommandId,
      ])
    : JSON.stringify(["run-input", run.runId, run.inputOrigin ?? "userInput"]);
}

const unstartedTurnFacts: AgentTurnBoundaryFacts = {
  context: { status: "unavailable", reason: "turn_not_started" },
  files: { status: "unavailable", reason: "turn_not_started" },
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

/**
 * run → 后台任务注册表（DEC-15）：cancelRun 据此连带取消全部后台子代理/长命令。
 * WeakMap：注册表随 run 对象生灭，run 结束后不额外持引用。
 */
const backgroundTaskRegistries = new WeakMap<object, BackgroundTaskRegistry>();

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const completions = new Map<
    string,
    { promise: Promise<void>; finish: () => void; settled: boolean }
  >();
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());

  const persistBoundary = async (
    run: RuntimeRunRecord,
    phase: AgentTurnBoundaryPhase,
    facts: AgentTurnBoundaryFacts,
  ) => {
    if (
      run.scopeHandle?.role !== "main" ||
      !run.threadId ||
      !options.agentRunMetadataService?.recordTurnBoundary
    )
      return;
    run.turnBoundaryWrites ??= {};
    const writes = run.turnBoundaryWrites;
    const scope = run.scopeHandle.describe();
    writes[phase] ??= {
      persisted: false,
      boundary: {
        instanceId: scope.instanceId,
        projectId: scope.projectId,
        taskId: scope.taskId,
        runId: run.runId,
        threadId: run.threadId,
        phase,
        scopeGeneration: scope.generation,
        branchGeneration: run.branchGeneration ?? null,
        inputIdentity: run.inputIdentity ? { ...run.inputIdentity } : null,
        inputOrigin: run.inputOrigin ?? "userInput",
        inputMessageId: run.operation ? null : inputMessageIdFor(run),
        ...(run.operation ? { operation: { ...run.operation } } : {}),
        ...structuredClone(facts),
      },
    };
    const write = writes[phase];
    if (write.persisted) return;
    try {
      await options.agentRunMetadataService.recordTurnBoundary(write.boundary);
      write.persisted = true;
    } catch {
      console.warn(
        `[turn-boundary] ${phase}持久边界保存失败，历史控制不可用。`,
      );
    }
  };

  const settleAcceptedCancellation = (
    run: RuntimeRunRecord,
  ): Promise<void> | undefined => {
    if (run.consumed) return;
    run.status = "canceled";
    run.acceptedCancellation ??= (async () => {
      await persistBoundary(run, "pre", unstartedTurnFacts);
      await persistBoundary(run, "post", unstartedTurnFacts);
      try {
        await updatePersistedRunStatus(
          options.agentRunMetadataService,
          run,
          "canceled",
          { completedAt: now() },
        );
      } catch {
        console.warn("[agent-runtime] 未启动Run的取消元数据保存失败。");
      }
      completions.get(run.runId)?.finish();
    })();
    return run.acceptedCancellation;
  };

  // DEC-1 pre-step：把改写权交给事件监听器（执行模式 plan 引导等），无监听器原样返回
  const applyPreStep = async (
    input: string,
    run: RuntimeRunRecord,
  ): Promise<string> => {
    if (!options.emitPreStep) {
      return input;
    }
    const scope = run.scopeHandle?.describe();
    const result = await options.emitPreStep({
      input,
      runId: run.runId,
      preset: resolvePresetForRun(run),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(scope ? { instanceId: scope.instanceId, taskId: scope.taskId } : {}),
    });
    return typeof result.input === "string" ? result.input : input;
  };

  /**
   * 最近一次装配回吐的工具清单（R4-1 分类占比要按 schema 分「系统工具 / MCP 工具」）。
   * 每次 run 装配一次 agent，装配期内赋值、随后立刻读取，故不存在跨 run 串用。
   */
  let lastToolInventory: readonly unknown[] = [];

  const resolvedAgentFactory: KenFutWorkAgentFactory =
    options.agentFactory ??
    ((agentOptions) =>
      createKenFutWorkDeepAgent({
        ...agentOptions,
        onToolInventory: (tools) => {
          lastToolInventory = tools;
        },
      }));

  const service = {
    canCloneContextBranches(): boolean {
      return options.contextBranchProvider !== undefined;
    },
    async cloneContextBranch(input: AgentContextBranchCloneInput) {
      if (!options.contextBranchProvider)
        throw new Error("当前Agent未装配上下文分支能力。");
      return options.contextBranchProvider.clone(input);
    },
    async discardContextBranch(input: AgentContextBranchTargetInput) {
      if (!options.contextBranchProvider)
        throw new Error("当前Agent未装配上下文分支能力。");
      await options.contextBranchProvider.discard(input);
    },
    releaseContextBranch(input: AgentContextBranchTargetInput): void {
      if (!options.contextBranchProvider)
        throw new Error("当前Agent未装配上下文分支能力。");
      options.contextBranchProvider.release(input);
    },
    cancelRun(runId: string): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }
      // 后台任务连带取消（DEC-15）：abort 回调联动各子代理/长命令的中止信号
      backgroundTaskRegistries.get(run)?.abortAll("用户取消了本轮 run");

      run.status = "canceled";
      void settleAcceptedCancellation(run);
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RunCreateRequest,
      runOptions?: {
        /** 已鉴权的原输入身份；retry须回指原client/sourceCommand，不能用新runId代替。 */
        inputIdentity?: { clientId: string; sourceCommandId: string };
        inputOrigin?: "userInput" | "backgroundResult" | "controlOperation";
        operation?: { kind: "compact" };
        /** 持久命令已铸造的运行身份；恢复/去重不得再次生成另一轮 run。 */
        runId?: string;
        actor?: LocalActor;
        model?: string;
        modelInvocation?: ModelInvocationSnapshot;
        codeInputs?: TrustedCodeInput[];
        scopeHandle?: ExecutionScopeHandle;
        /** 沙箱目录名用的 id（画布 UUID）；缺省回落到 canvasId。 */
        sandboxScopeId?: string;
        threadId?: string;
        eventSink?: (event: StreamEvent) => Promise<void>;
        delegationDepth?: number;
        roleInstructions?: string;
        approvalCeiling?: import("../features/permissions/approval-types.js").CodeApprovalMode;
      },
    ): RunCreateResponse {
      if (!runOptions?.actor) throw new Error("运行缺少可信的本地实例身份。");
      const actor: LocalActor = Object.freeze({
        instanceId: runOptions.actor.instanceId,
        accessClientId: runOptions.actor.accessClientId,
      });
      // 新工作由传输/命令准入把关；已受理队列、子代理和后台结果在维护期间继续收尾。
      if (
        runOptions.scopeHandle &&
        runOptions.scopeHandle.describe().instanceId !== actor.instanceId
      )
        throw new Error("运行身份与 Task 执行作用域不属于同一本地实例。");
      const runId = runOptions?.runId ?? runIdFactory();
      const runInput = copyRunInput(input);
      let finish!: () => void;
      const completion = {
        promise: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        finish: () => {
          completion.settled = true;
          finish();
        },
        settled: false,
      };
      completions.set(runId, completion);

      runs.set(runId, {
        ...runInput,
        ...(runOptions?.operation
          ? { operation: { ...runOptions.operation } }
          : {}),
        ...(runOptions?.inputIdentity
          ? { inputIdentity: { ...runOptions.inputIdentity } }
          : {}),
        ...(runOptions?.inputOrigin
          ? { inputOrigin: runOptions.inputOrigin }
          : {}),
        actor,
        consumed: false,
        controller: new AbortController(),
        ...(runOptions?.model ? { modelOverride: runOptions.model } : {}),
        ...(runOptions?.modelInvocation
          ? { modelInvocation: structuredClone(runOptions.modelInvocation) }
          : {}),
        ...(runOptions?.codeInputs
          ? { codeInputs: structuredClone(runOptions.codeInputs) }
          : {}),
        ...(runOptions?.scopeHandle
          ? { scopeHandle: runOptions.scopeHandle }
          : {}),
        ...(runOptions?.sandboxScopeId
          ? { sandboxScopeId: runOptions.sandboxScopeId }
          : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.eventSink ? { eventSink: runOptions.eventSink } : {}),
        ...(runOptions?.delegationDepth !== undefined
          ? { delegationDepth: runOptions.delegationDepth }
          : {}),
        ...(runOptions?.roleInstructions
          ? { roleInstructions: runOptions.roleInstructions }
          : {}),
        ...(runOptions?.approvalCeiling
          ? { approvalCeiling: runOptions.approvalCeiling }
          : {}),
        runId,
        status: "accepted",
      });

      return {
        conversationId: input.conversationId,
        runId,
        sessionId: input.sessionId,
        status: "accepted",
      };
    },

    hasRun(runId: string) {
      return runs.has(runId);
    },

    activeRunCount(): number {
      return [...runs.values()].filter(
        (run) => !completions.get(run.runId)?.settled,
      ).length;
    },

    hasActiveRunForTask(taskId: string): boolean {
      return [...runs.values()].some(
        (run) =>
          run.scopeHandle?.describe().taskId === taskId &&
          !completions.get(run.runId)?.settled,
      );
    },
    async cancelRunAndWait(runId: string): Promise<void> {
      const run = runs.get(runId);
      if (!run) return;
      run.controller.abort("用户停止本次执行");
      const completion = completions.get(runId);
      await settleAcceptedCancellation(run);
      await completion?.promise;
    },
    async cancelTaskRuns(taskId: string): Promise<void> {
      const waits: Promise<void>[] = [];
      for (const run of runs.values()) {
        if (run.scopeHandle?.describe().taskId !== taskId) continue;
        run.controller.abort("Task 执行资源正在关闭");
        const completion = completions.get(run.runId);
        const accepted = settleAcceptedCancellation(run);
        if (accepted) waits.push(accepted);
        if (completion) waits.push(completion.promise);
      }
      await Promise.all(waits);
    },

    /**
     * 该画布是否还有在途 run（accepted/running）：恢复路由的守卫用——run 还在
     * 写工作目录时不允许回滚，否则恢复会把正在产出的文件冲掉。
     * 画布命中两分支：run.canvasId（客户端发来的作用域）或 sandboxScopeId
     * （服务端解析出的沙箱画布，见 createRun 的 runOptions）。
     */
    hasActiveRunForCanvas(canvasId: string): boolean {
      for (const run of runs.values()) {
        if (run.status !== "accepted" && run.status !== "running") {
          continue;
        }
        if (run.canvasId === canvasId || run.sandboxScopeId === canvasId) {
          return true;
        }
      }
      return false;
    },

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.controller.signal.aborted) {
        await run.acceptedCancellation;
        run.status = "canceled";
        yield { type: "run.canceled", runId, timestamp: now() };
        return;
      }

      run.status = "running";

      const rlog = createPipelineLogger("runtime", { runId });

      try {
        await options.localInstance.resolve(run.actor);
        await updatePersistedRunStatus(
          options.agentRunMetadataService,
          run,
          "running",
        );
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        yield failedEvent;
        return;
      }

      let persistence: Awaited<
        ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
      > | null = null;
      try {
        persistence =
          run.threadId && options.agentPersistenceService
            ? await options.agentPersistenceService.getPersistence()
            : null;
        rlog.lap("persistence_init", {
          threadId: run.threadId ?? null,
          hasCheckpointer: !!persistence?.checkpointer,
          hasStore: !!persistence?.store,
        });
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          error,
        );
        yield failedEvent;
        return;
      }

      if (run.threadId && !persistence) {
        const failedEvent = toFailedEvent(
          runId,
          now,
          new Error(
            "KENFUTWORK_DATABASE_URL（或 DATABASE_URL）是持久化 agent 线程的必需项。",
          ),
        );
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          new Error(
            "KENFUTWORK_DATABASE_URL（或 DATABASE_URL）是持久化 agent 线程的必需项。",
          ),
        );
        yield failedEvent;
        return;
      }

      // Build submitImageJob / submitVideoJob closures for async jobs via PGMQ
      let submitImageJob: SubmitImageJobFn | undefined;
      let submitVideoJob: SubmitVideoJobFn | undefined;
      if (options.jobService) {
        const jobSvc = options.jobService;
        const actor = run.actor;
        const canvasId = run.canvasId;
        const sessionId = run.sessionId;
        const runId = run.runId;

        submitImageJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitImageJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          await options.localInstance.resolve(actor);
          const selected = parseInstanceSpecifier(input.model);
          if (!selected) throw new Error("请从本地供应商目录选择图像模型。");

          const job = await jobSvc.createJob(actor, {
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "image_generation",
            payload: {
              prompt: input.prompt,
              title: input.title,
              model: selected.model,
              provider_instance_id: selected.instanceId,
              aspect_ratio: input.aspectRatio,
              ...(input.quality ? { quality: input.quality } : {}),
              ...(input.inputImages ? { input_images: input.inputImages } : {}),
            },
          });

          jobLap("job_created", {
            jobId: job.id,
            sessionId,
            runId,
          });

          // Poll until terminal state
          // Worker image VT=120s, but Replicate calls can take 100s+ plus queue delay.
          const POLL_INTERVAL = 2000;
          const MAX_WAIT = 240_000; // 4 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              await jobSvc.cancelJob(actor, job.id).catch(() => {});
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobForWorker(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                object_path?: string;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.object_path && options.canvasService) {
                try {
                  const explicitPlacement =
                    input.placementX != null && input.placementY != null
                      ? {
                          x: input.placementX,
                          y: input.placementY,
                          width: input.placementWidth ?? 512,
                          height: input.placementHeight ?? 512,
                        }
                      : undefined;

                  const insertResult =
                    await options.canvasService.insertImageElement(actor, {
                      canvasId,
                      objectPath: result.object_path,
                      width: result.width ?? 1024,
                      height: result.height ?? 1024,
                      mimeType: result.mime_type ?? "image/png",
                      ...(input.title ? { title: input.title } : {}),
                      ...(explicitPlacement
                        ? { placement: explicitPlacement }
                        : {}),
                    });
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitImageJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                imageUrl: result.signed_url ?? "",
                width: result.width ?? 1024,
                height: result.height ?? 1024,
                mimeType: result.mime_type ?? "image/png",
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }

            // "failed" with attempts exhausted
            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitVideoJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          await options.localInstance.resolve(actor);
          const selected = parseInstanceSpecifier(input.model);
          if (!selected) throw new Error("请从本地供应商目录选择视频模型。");

          const job = await jobSvc.createJob(actor, {
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "video_generation",
            payload: {
              prompt: input.prompt,
              model: selected.model,
              provider_instance_id: selected.instanceId,
              ...(input.duration != null ? { duration: input.duration } : {}),
              ...(input.resolution ? { resolution: input.resolution } : {}),
              ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
              ...(input.inputImages ? { input_images: input.inputImages } : {}),
              ...(input.inputVideo ? { input_video: input.inputVideo } : {}),
              ...(input.enableAudio != null
                ? { enable_audio: input.enableAudio }
                : {}),
            },
          });

          jobLap("job_created", {
            jobId: job.id,
            sessionId,
            runId,
          });

          // Poll until terminal state — video generation is slower.
          // Google Vertex Veo can take 300-500s; 600s gives enough headroom
          // to avoid poll timeout while worker is still processing.
          const POLL_INTERVAL = 3000;
          const MAX_WAIT = 600_000; // 10 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              await jobSvc.cancelJob(actor, job.id).catch(() => {});
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobForWorker(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.signed_url && options.canvasService) {
                try {
                  const explicitPlacement =
                    input.placementX != null && input.placementY != null
                      ? {
                          x: input.placementX,
                          y: input.placementY,
                          width: input.placementWidth ?? 640,
                          height: input.placementHeight ?? 360,
                        }
                      : undefined;

                  const insertResult =
                    await options.canvasService.insertVideoElement(actor, {
                      canvasId,
                      signedUrl: result.signed_url,
                      width: result.width ?? 1280,
                      height: result.height ?? 720,
                      mimeType: result.mime_type ?? "video/mp4",
                      ...(result.duration_seconds != null
                        ? { durationSeconds: result.duration_seconds }
                        : {}),
                      ...(input.title ? { title: input.title } : {}),
                      ...(input.prompt ? { prompt: input.prompt } : {}),
                      ...(explicitPlacement
                        ? { placement: explicitPlacement }
                        : {}),
                    });
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitVideoJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                videoUrl: result.signed_url ?? "",
                width: result.width ?? 1280,
                height: result.height ?? 720,
                mimeType: result.mime_type ?? "video/mp4",
                ...(result.duration_seconds != null
                  ? { durationSeconds: result.duration_seconds }
                  : {}),
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
              };
            }

            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
          };
        };
      }

      // Code uses the trusted Task workspace; only Design stages a Store route.
      let instanceSkills: InstanceSkillEntry[] = [];
      if (
        run.scopeHandle
          ? options.instanceSkillsByInstanceLoader
          : run.canvasId && options.instanceSkillsLoader
      ) {
        try {
          instanceSkills = run.scopeHandle
            ? await options.instanceSkillsByInstanceLoader!(
                run.actor.instanceId,
              )
            : await options.instanceSkillsLoader!(
                run.actor.instanceId,
                run.canvasId!,
              );
          rlog.lap("workspace_skills_loaded", {
            count: instanceSkills.length,
          });
        } catch (err) {
          // Non-fatal: agent runs without workspace skills
          console.warn("[runtime] Failed to load workspace skills:", err);
        }
      }

      // Create backend — production uses StateBackend (no local shell).
      const backendCanvasId = run.scopeHandle
        ? undefined
        : (run.sandboxScopeId ?? run.canvasId);
      // Design 项目可绑定本机目录；Code 直接使用可信 Task 的 scopeHandle。
      // 读不到就照旧回沙箱目录——绑定是增强，不是 run 的前置条件。
      const boundWorkDir =
        backendCanvasId && options.projectWorkDirLoader
          ? await options
              .projectWorkDirLoader(run.actor.instanceId, backendCanvasId)
              .catch(() => null)
          : null;
      const scopedBackend = run.scopeHandle;
      const backendResult = scopedBackend
        ? {
            factory: () => scopedBackend.backend,
            sandboxDir: scopedBackend.describe().rootDirectory,
            ephemeral: false,
          }
        : createAgentBackend(
            withBoundWorkDir(options.env, backendCanvasId, boundWorkDir),
            backendCanvasId,
            { hasInstanceSkills: instanceSkills.length > 0 },
          );

      /**
       * 自动压缩的两个运行期值，声明在**装配块之外**：触发线在装配期算（要读模型目录与设置），
       * 事件检测在流式适配期用（同一个口径）——两个块是兄弟，必须看到同一份。
       */
      let autoCompactEnabled = true;
      let codeInputLimits: FileLimits = AGENT_GOVERNANCE_DEFAULTS;
      let modelCapabilities = { image: false, pdf: false };
      let autoCompact: CompactionPlan | undefined;
      let manualCompactPlan: CompactionPlan | undefined;
      /** 用户钩子（R5-2）：起点在装配前跑，终点在本轮收尾时跑；都是旁路。 */
      let hookCommands: { start: string[]; end: string[] } = {
        start: [],
        end: [],
      };
      let hookShell: InstanceSettings["terminalShell"] | undefined;
      let processLimits: ProcessLimits = {
        maxOutputBytes: AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
        previewMaxChars: AGENT_GOVERNANCE_DEFAULTS.processPreviewMaxChars,
        yieldMs: AGENT_GOVERNANCE_DEFAULTS.processYieldMs,
        killGraceMs: AGENT_GOVERNANCE_DEFAULTS.processKillGraceMs,
      };
      /** 后台任务并发上限（DEC-15/18）：治理设置读侧已钳回护栏。 */
      let governanceConcurrency: number =
        AGENT_GOVERNANCE_DEFAULTS.subagentMaxConcurrency;
      /** LLM 请求级重试（DEC-18）：治理设置读侧已钳回护栏。 */
      let governanceLlmRetry: { maxAttempts: number; infinite: boolean } = {
        maxAttempts: AGENT_GOVERNANCE_DEFAULTS.llmRequestMaxRetries,
        infinite: AGENT_GOVERNANCE_DEFAULTS.llmInfiniteRetry,
      };
      /** Code 长命令超时（DEC-18）。 */
      let governanceExecuteTimeoutMs: number =
        AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs;
      /** 后台任务续轮上限（DEC-15/18）：防挂死任务导致无限续轮。 */
      let governanceMaxContinuations: number =
        AGENT_GOVERNANCE_DEFAULTS.subagentMaxContinuations;
      /** 统一后台任务注册表（DEC-15）：设置读取后创建；取消/收尾经它连带清理。 */
      let backgroundTaskRegistry: BackgroundTaskRegistry | null = null;
      let taskWorkContext: TaskWorkContext | undefined;
      let leaveForeground: (() => Promise<void>) | undefined;
      let agent: KenFutWorkAgent | undefined;
      const captureBoundary = async (phase: AgentTurnBoundaryPhase) => {
        if (run.scopeHandle?.role !== "main") return;
        const scope = run.scopeHandle;
        const actor = taskWorkContext?.actor;
        const hook =
          phase === "pre"
            ? options.checkpointHooks?.beforeTurn
            : options.checkpointHooks?.afterTurn;
        const facts = await captureAgentTurnBoundaryFacts({
          contextHistory: agent?.contextHistory,
          threadId: run.threadId,
          captureFiles:
            hook && actor ? () => hook({ scope, actor, runId }) : undefined,
        });
        await persistBoundary(run, phase, facts);
      };

      try {
        /** 被拒工具调用的记账（含连续拒绝计数）；门存在时才有值。 */
        let denialTracker:
          | ReturnType<typeof createToolDenialTracker>
          | undefined;
        try {
          let resolvedModel: BaseLanguageModel | string | undefined =
            run.modelOverride
              ? run.modelOverride.includes(":")
                ? run.modelOverride
                : createDefaultModelSpecifier({ agentModel: run.modelOverride })
              : options.model;

          run.usageMeta = {
            provider: "builtin",
            model:
              typeof run.modelOverride === "string"
                ? run.modelOverride
                : String(options.model ?? "default"),
          };
          // BYOK：run 的 model 携带实例 specifier 时，按用户供应商实例实例化聊天模型
          if (typeof resolvedModel === "string" && options.modelProviders) {
            const instanceSpec = parseInstanceSpecifier(resolvedModel);
            if (instanceSpec) {
              /**
               * 起始期 fail loud（E）：带实例前缀的模型必须能在这个用户的目录里找到。
               * 不做这一步时，模型被改名/停用后要等上游回 4xx 才暴露，且界面只有通用文案。
               */
              if (options.modelCatalog) {
                const verdict = await options.modelCatalog
                  .validateSpecifier(run.actor, resolvedModel)
                  .catch(() => ({ ok: true as const }));
                if (!verdict.ok) {
                  throw new Error(verdict.message);
                }
              }
              const credentials =
                await options.modelProviders.resolveCredentials(
                  run.actor,
                  instanceSpec.instanceId,
                );
              // 模型级推理参数映射（extraBody）随模型行带入请求体
              const modelRow = credentials.models?.find(
                (m) => m.id === instanceSpec.model,
              );
              const modelInvocation = run.modelInvocation;
              if (
                modelInvocation &&
                (modelInvocation.providerId !== credentials.instanceId ||
                  modelInvocation.modelId !== instanceSpec.model ||
                  modelInvocation.configRevision !== credentials.configRevision)
              )
                throw new Error(
                  "本轮供应商或模型配置已改变，请重新确认模型选择后发送。",
                );
              modelCapabilities =
                modelInvocation?.inputCapabilities ??
                resolveModelInputCapabilities(modelRow ?? {});
              resolvedModel = resolveInstanceChatModel(
                credentials.protocol,
                instanceSpec.model,
                {
                  apiKey: credentials.apiKey,
                  ...((modelInvocation?.useResponsesApi ??
                    credentials.useResponsesApi) !== undefined
                    ? {
                        useResponsesApi:
                          modelInvocation?.useResponsesApi ??
                          credentials.useResponsesApi,
                      }
                    : {}),
                  ...(credentials.responsesApi !== undefined
                    ? { responsesApi: credentials.responsesApi }
                    : {}),
                  ...(credentials.baseUrl
                    ? { baseUrl: credentials.baseUrl }
                    : {}),
                  // 自定义头逐会话取值（§4.8）：亲和类头写死固定值会把所有会话钉到同一分片
                  ...instanceHeadersOption(credentials.headers, {
                    sessionId: run.sessionId,
                    threadId: run.threadId,
                  }),
                },
                // 编译结果已按RFC7386处理静态参数；不能再次合并使已删除字段复活。
                modelInvocation?.body ?? modelRow?.extraBody,
              );
              run.usageMeta = {
                provider: "instance",
                model: instanceSpec.model,
                providerInstanceId: instanceSpec.instanceId,
              };
            }
          }

          if (
            resolvedModel &&
            typeof resolvedModel !== "string" &&
            run.usageMeta
          ) {
            resolvedModel.metadata = {
              ...resolvedModel.metadata,
              [MODEL_USAGE_OWNER_METADATA]: {
                ...run.usageMeta,
                ...(run.modelInvocation
                  ? { configRevision: run.modelInvocation.configRevision }
                  : {}),
              },
            };
          }
          // Build persistImage closure over the blob seam. 上传发生在真正生成图片时。
          let persistImage:
            | ((url: string, mime: string, prompt: string) => Promise<string>)
            | undefined;
          const blob = options.blob;
          if (blob) {
            persistImage = async (sourceUrl, mimeType, prompt) => {
              const response = await fetch(sourceUrl);
              if (!response.ok)
                throw new Error(`Download failed: ${response.status}`);
              const buffer = Buffer.from(await response.arrayBuffer());
              const ext = mimeType === "image/webp" ? "webp" : "png";
              const slug = prompt
                .slice(0, 40)
                .replace(/[^a-zA-Z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
              const fileName = `gen-${slug}-${Date.now()}.${ext}`;

              const { instanceId } = await options.localInstance.resolve(
                run.actor,
              );
              const objectPath = `${instanceId}/${Date.now()}-${fileName}`;

              const assetBucket = blob.bucket("project-assets");
              await assetBucket.upload(objectPath, buffer, {
                contentType: mimeType,
                upsert: false,
              });

              // 公开性由存储侧回答（实测 project-assets 可能非公开）
              return assetBucket.resolveUrl(objectPath);
            };
          }

          // Resolve brand kit ID from canvas to project (single JOIN, workspace-scoped)
          let brandKitId: string | null = null;
          if (run.canvasId && options.canvasRepository) {
            const canvasWorkspace = await options.localInstance
              ?.resolve(run.actor)
              .catch(() => null);
            if (canvasWorkspace) {
              brandKitId = await options.canvasRepository
                .findProjectBrandKitId(canvasWorkspace.instanceId, run.canvasId)
                .catch(() => null);
            }
          }

          rlog.lap("brand_kit_resolved");

          // Pre-write workspace skill SKILL.md files AND associated files
          // (scripts/, references/, assets/) into the Store so the agent can
          // read_file them via the /workspace-skills/ route.
          const store = persistence?.store;
          if (
            !run.scopeHandle &&
            instanceSkills.length > 0 &&
            store &&
            run.canvasId
          ) {
            const storeNamespace = [
              "projects",
              run.canvasId,
              "workspace-skills",
            ];
            const now_ = new Date().toISOString();

            const writeOps: Promise<void>[] = [];
            for (const skill of instanceSkills) {
              // Write SKILL.md
              writeOps.push(
                store.put(storeNamespace, `/${skill.name}/SKILL.md`, {
                  content: skill.content.split("\n"),
                  created_at: now_,
                  modified_at: now_,
                }),
              );
              // Write associated files (scripts/, references/, assets/)
              for (const file of skill.files) {
                writeOps.push(
                  store.put(storeNamespace, `/${skill.name}/${file.path}`, {
                    content: file.content.split("\n"),
                    created_at: now_,
                    modified_at: now_,
                  }),
                );
              }
            }

            await Promise.all(writeOps);
            const totalFiles = instanceSkills.reduce(
              (sum, s) => sum + s.files.length,
              0,
            );
            rlog.lap("workspace_skills_stored", {
              count: instanceSkills.length,
              files: totalFiles,
            });
          }

          const preset = resolvePresetForRun(run);

          // 执行模式工具门：solo/plan 按线程策略拦截（undefined = 全放行）
          const toolGate =
            !run.scopeHandle && run.threadId && options.toolGateFor
              ? options.toolGateFor(run.threadId)
              : undefined;
          // 被拒调用的可见性与有界失败：门只做判定，记账与中止由运行时负责
          // （只有它拿得到 runId/时间戳/abort 控制器）
          denialTracker = toolGate ? createToolDenialTracker() : undefined;
          const toolGateHooks: ToolGateHooks | undefined = denialTracker
            ? {
                onAllowed: (toolName) => denialTracker?.recordAllowed(toolName),
                onDenied: (entry) => {
                  denialTracker?.recordDenied(entry);
                  // 达上限立即中止：模型「只发工具调用」的回合不产生任何适配器事件，
                  // 光靠事件循环里的检查会漏（实测替身连调 5 次仍停在 running）
                  if (denialTracker?.fatalReason()) {
                    run.controller.abort();
                  }
                },
              }
            : undefined;

          // 工具使用可信运行的稳定实例归属，客户端身份不会改变资源所有者。
          const { instanceId: toolInstanceId } =
            await options.localInstance.resolve(run.actor);

          /**
           * 用户规则（设置 → 规则与记忆）拼进系统提示词：这是那段 UI 的**真实消费方**
           * （此前只写 localStorage，服务端没人读）。读失败不阻断 run（规则是增强，不是前置）。
           */
          let userRulesFragment: string[] = [];
          let codeProjectContext: CodeProjectContext | undefined;
          if (toolInstanceId && options.settingsService) {
            const instanceSettings = await options.settingsService
              .getInstanceSettings(run.actor, toolInstanceId)
              .catch(() => null);
            if (instanceSettings) codeInputLimits = instanceSettings;
            userRulesFragment = formatUserRulesFragment({
              userRules: instanceSettings?.userRules,
              ruleEntries: instanceSettings?.ruleEntries,
            });
            if (run.scopeHandle && options.codeProjectContextLoader) {
              if (!instanceSettings)
                throw new Error("Code 项目规则加载缺少治理设置。");
              codeProjectContext = await options.codeProjectContextLoader(
                run.scopeHandle,
                {
                  maxTextBytes: instanceSettings.codeReadMaxBytes,
                  maxEntries: instanceSettings.codeSearchMaxResults,
                },
                run.controller.signal,
              );
            }
            // 同一个设置对象顺带读压缩开关（少一次库往返）
            autoCompactEnabled = instanceSettings?.autoCompactEnabled ?? true;
            // 钩子也从这个对象读（同一趟）：起点钩子在装配 agent 之前跑
            hookCommands = {
              start: hooksFor(instanceSettings?.hooks, "turn-start"),
              end: hooksFor(instanceSettings?.hooks, "turn-end"),
            };
            hookShell = instanceSettings?.terminalShell;
            if (instanceSettings)
              processLimits = {
                maxOutputBytes: instanceSettings.processMaxOutputBytes,
                previewMaxChars: instanceSettings.processPreviewMaxChars,
                yieldMs: instanceSettings.processYieldMs,
                killGraceMs: instanceSettings.processKillGraceMs,
              };
            // 后台任务并发上限（DEC-15/18）：治理设置读侧已钳回护栏
            governanceConcurrency =
              instanceSettings?.subagentMaxConcurrency ??
              AGENT_GOVERNANCE_DEFAULTS.subagentMaxConcurrency;
            governanceLlmRetry = {
              maxAttempts:
                instanceSettings?.llmRequestMaxRetries ??
                AGENT_GOVERNANCE_DEFAULTS.llmRequestMaxRetries,
              infinite:
                instanceSettings?.llmInfiniteRetry ??
                AGENT_GOVERNANCE_DEFAULTS.llmInfiniteRetry,
            };
            governanceExecuteTimeoutMs =
              instanceSettings?.executeTimeoutMs ??
              AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs;
            governanceMaxContinuations = clampSubagentMaxContinuations(
              instanceSettings?.subagentMaxContinuations ??
                AGENT_GOVERNANCE_DEFAULTS.subagentMaxContinuations,
            );
          }

          // 统一后台任务注册表（DEC-15）：每 run 一个（状态随 run 生命周期，
          // 纯内存——run 结束即无意义）；并发上限来自治理设置
          if (run.scopeHandle) {
            if (!options.taskWork || !options.resolveTaskWorkContext)
              throw new Error("Code Task 后台工作与前台执行协调器未装配。");
            taskWorkContext = await options.resolveTaskWorkContext(
              run.actor,
              run.scopeHandle,
              runId,
            );
            taskWorkContext = {
              ...taskWorkContext,
              signal: run.controller.signal,
            };
            run.branchGeneration = taskWorkContext.branchGeneration;
            if (run.scopeHandle.role === "main")
              leaveForeground =
                await options.taskWork.enterForeground(taskWorkContext);
            else hookCommands = { start: [], end: [] };
          } else {
            backgroundTaskRegistry = createBackgroundTaskRegistry({
              maxConcurrent: governanceConcurrency,
            });
            backgroundTaskRegistries.set(run, backgroundTaskRegistry);
          }

          if (hookCommands.start.length > 0 && backendResult.sandboxDir) {
            for (const hook of await runHooks({
              event: "turn-start",
              commands: hookCommands.start,
              cwd: backendResult.sandboxDir,
              timeoutMs: governanceExecuteTimeoutMs,
              previewMaxChars: processLimits.previewMaxChars,
              ...(run.scopeHandle
                ? {
                    runCommand: options.processSandbox
                      ? createScopedHookCommand({
                          sandbox: options.processSandbox,
                          scope: run.scopeHandle,
                          runId,
                          event: "turn-start",
                          limits: processLimits,
                          signal: run.controller.signal,
                        })
                      : async () => {
                          throw new Error("Code 钩子执行器不可用，拒绝裸跑。");
                        },
                  }
                : {}),
              ...(hookShell ? { shell: hookShell } : {}),
            })) {
              yield {
                type: "run.hook" as const,
                runId,
                ...hook,
                timestamp: now(),
              };
            }
          }

          /**
           * 上下文自动压缩的触发线（口径见 agent/auto-compact.ts）：
           * 「模型声明的窗口 / 最大输出」优先，没声明就用共享兜底表认模型族；
           * 两边都没有（认不出的 BYOK 模型）→ 中间件按框架回退值走，这里如实记来源。
           */
          if (autoCompactEnabled || run.operation?.kind === "compact") {
            const specifier =
              typeof run.modelOverride === "string"
                ? run.modelOverride
                : typeof options.model === "string"
                  ? options.model
                  : "";
            let declaredWindow: number | null = null;
            let declaredMaxOutput: number | null = null;
            if (specifier && options.modelCatalog) {
              const entries = await options.modelCatalog
                .listCatalog(run.actor)
                .catch(() => []);
              const entry = entries.find(
                (candidate) => candidate.id === specifier,
              );
              declaredWindow = entry?.model.contextWindow ?? null;
              declaredMaxOutput = entry?.model.maxOutputTokens ?? null;
            }
            const plan = resolveCompactionPlan({
              contextWindow: resolveContextWindow(declaredWindow, specifier),
              maxOutputTokens: declaredMaxOutput,
            });
            /**
             * 逃生口：窗口认不出的模型想自己定阈值、或要**真机验证压缩真的会发生**时，
             * 用 `KENFUTWORK_AUTO_COMPACT_TRIGGER_TOKENS` 直接指定（整数 token）。
             * 覆盖值只改阈值，保留条数与来源口径不变。
             */
            const override = Number(
              options.env.autoCompactTriggerTokens ?? Number.NaN,
            );
            autoCompact =
              Number.isFinite(override) && override > 0
                ? {
                    ...plan,
                    trigger: { type: "tokens", value: Math.floor(override) },
                  }
                : plan;
            manualCompactPlan = autoCompact;
            if (!autoCompactEnabled) autoCompact = undefined;
            console.log(
              `[agent] 自动压缩触发线 ${plan.trigger.value} tokens（来源 ${plan.source}，保留 ${plan.keep.value} 条）`,
            );
          }

          // BYOK：工作区实例模型清单——生成工具（generate_image/generate_video）
          // 的 schema 枚举与模型校验来源；无实例时空清单（工具如实报未配置）。
          let availableImageModels: AvailableModel[] = [];
          let availableVideoModels: AvailableVideoModel[] = [];
          if (options.modelCatalog) {
            try {
              const catalogActor = run.actor;
              const entries =
                await options.modelCatalog.listCatalog(catalogActor);
              const selection = parseInstanceSpecifier(
                run.modelOverride ?? run.model ?? "",
              );
              const selected =
                selection &&
                entries.find(
                  (entry) =>
                    entry.provider.instanceId === selection.instanceId &&
                    entry.id === selection.model,
                );
              if (selected)
                modelCapabilities = resolveModelInputCapabilities(
                  selected.model,
                  selected.hints,
                );
              const toListItem = (entry: (typeof entries)[number]) => ({
                id: `${entry.provider.instanceId}:${entry.id}`,
                displayName: entry.name,
                description: `${entry.name}（实例：${entry.provider.name}）`,
                provider: entry.provider.name,
              });
              availableImageModels = entries
                .filter(
                  (e) =>
                    e.capability === "image" || e.capability === "image-edit",
                )
                .map(toListItem);
              availableVideoModels = entries
                .filter((e) => e.capability === "video")
                .map((entry) => ({
                  id: `${entry.provider.instanceId}:${entry.id}`,
                  displayName: entry.name,
                  description: `${entry.name}（实例：${entry.provider.name}）`,
                  provider: entry.provider.name,
                  // 任务级能力未在实例模型行声明（缺省=未知），工具面用保守占位
                  capabilities: {
                    textToVideo: true,
                    imageToVideo: false,
                    videoToVideo: false,
                    audio: false,
                  },
                  limits: {
                    maxDuration: 15,
                    maxResolution: "1080p" as const,
                    maxInputImages: 4,
                  },
                }));
            } catch (catalogError) {
              console.warn(
                "[runtime] 实例模型清单拉取失败（生成工具将报告未配置）:",
                catalogError,
              );
            }
          }

          // §4.5 统一工具注册表：静态 list(preset) + 动态 per-run 解析（backend/
          // 沙箱/模型目录/job 闭包在此就绪），合并桥接进模型工具列表；execute 经
          // 注册表 guarded 路径派发（tool-pre-execute 拦截在注册表侧生效）
          const kernelToolRegistry = options.tools;
          let codeApproval: ToolExecutionContext["codeApproval"];
          if (run.scopeHandle) {
            const handle = run.scopeHandle;
            const resolver = options.resolveCodeApprovalMode;
            if (!resolver) throw new Error("Code Task 权限模式解析器未装配。");
            const resolve = () => resolver(handle);
            const current = await resolve();
            codeApproval = {
              ceiling: run.approvalCeiling ?? current.mode,
              resolve,
            };
          }
          const runToolContext: ToolExecutionContext = {
            sessionId: run.sessionId,
            modelSpecifier: run.modelOverride ?? run.model,
            delegationDepth: run.delegationDepth ?? 0,
            ...(codeApproval ? { codeApproval } : {}),
            runId,
            signal: run.controller.signal,
            ...(run.scopeHandle ? { scopeHandle: run.scopeHandle } : {}),
            ...(taskWorkContext ? { taskWorkContext } : {}),
            ...(run.canvasId ? { canvasId: run.canvasId } : {}),
            ...(run.threadId ? { threadId: run.threadId } : {}),
            actor: run.actor,
            instanceId: toolInstanceId,
          };
          const toolResolutionContext = {
            actor: run.actor,
            sessionId: run.sessionId,
            modelSpecifier: run.modelOverride ?? run.model,
            delegationDepth: run.delegationDepth ?? 0,
            preset,
            modelCapabilities,
            backendFactory: backendResult.factory,
            ...(run.scopeHandle ? { scopeHandle: run.scopeHandle } : {}),
            ...(taskWorkContext ? { taskWorkContext } : {}),
            ...(backendResult.sandboxDir
              ? { sandboxDir: backendResult.sandboxDir }
              : {}),
            ...(persistence?.store ? { store: persistence.store } : {}),
            ...(persistImage ? { persistImage } : {}),
            ...(submitImageJob ? { submitImageJob } : {}),
            ...(submitVideoJob ? { submitVideoJob } : {}),
            ...(availableImageModels.length ? { availableImageModels } : {}),
            ...(availableVideoModels.length ? { availableVideoModels } : {}),
          };
          const kernelToolDefinitions = kernelToolRegistry
            ? kernelToolRegistry
                .resolveRunTools(toolResolutionContext)
                .map((tool) => ({
                  ...tool,
                  execute: (
                    args: Record<string, unknown>,
                    execCtx: ToolExecutionContext,
                  ) =>
                    kernelToolRegistry.executeDefinition(tool, args, execCtx),
                }))
            : [];
          // 保存已经曝光工具的公开投影，卸载后的迟到deny事件也不能泄露原参数。
          const argumentProjectors = new Map(
            kernelToolDefinitions
              .filter((tool) => tool.projectArguments)
              .map((tool) => [
                tool.name,
                { projectArguments: tool.projectArguments },
              ]),
          );
          run.projectToolInput = (name, args) => {
            try {
              const current = kernelToolRegistry
                ?.resolveRunTools(toolResolutionContext)
                .find((tool) => tool.name === name);
              if (current?.projectArguments)
                argumentProjectors.set(name, {
                  projectArguments: current.projectArguments,
                });
            } catch {
              /* 已曝光的投影仍用于迟到公开事件；不改变真实执行结果。 */
            }
            return publicToolArguments(argumentProjectors.get(name), args);
          };

          const promptCompositionContext: PromptCompositionContext = {
            preset,
            ...(run.roleInstructions
              ? { roleInstructions: run.roleInstructions }
              : {}),
            ...(brandKitId ? { brandKitId } : {}),
            instanceId: toolInstanceId,
            instanceSkills: [
              ...instanceSkills,
              ...(codeProjectContext?.skills ?? []),
            ],
            ...(codeProjectContext
              ? {
                  projectInstructions: codeProjectContext.instructions,
                  projectContextIssues: codeProjectContext.issues,
                  projectContextTruncated: codeProjectContext.truncated,
                }
              : {}),
            ...(userRulesFragment.length > 0 ? { userRulesFragment } : {}),
          };
          const initialPolicy = await codeApproval?.resolve();
          if (run.scopeHandle) {
            promptCompositionContext.executionScope =
              run.scopeHandle.describe();
            promptCompositionContext.executionRole = run.scopeHandle.role;
            promptCompositionContext.approvalMode = initialPolicy?.mode;
            promptCompositionContext.approvalCeiling = codeApproval?.ceiling;
          }

          agent = resolvedAgentFactory({
            ...(options.runExtensions
              ? {
                  runExtensions: options
                    .runExtensions()
                    .filter((extension) => extension.preset === preset),
                }
              : {}),
            ...(kernelToolRegistry
              ? {
                  extensionContext: {
                    registry: kernelToolRegistry,
                    resolution: toolResolutionContext,
                    execution: runToolContext,
                    ...(options.systemPromptRegistry
                      ? {
                          prompt: {
                            registry: options.systemPromptRegistry,
                            composition: promptCompositionContext,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
            backendResult,
            preset,
            // 系统提示经内核段注册表组装（模式段/品牌/skills/规则与插件段）；
            // registry 缺席（部分装配/测试）时为空串——生产装配恒有段注册表
            systemPrompt: options.systemPromptRegistry
              ? await options.systemPromptRegistry.compose(
                  promptCompositionContext,
                )
              : "",
            ...(run.canvasId ? { canvasId: run.canvasId } : {}),
            ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
            ...(options.connectionManager
              ? { connectionManager: options.connectionManager }
              : {}),
            env: options.env,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(autoCompact ? { autoCompact } : {}),
            ...(manualCompactPlan ? { manualCompactPlan } : {}),
            // execute 工具由 LocalShellBackend 自动提供，无需手动传递
            ...(persistence ? { store: persistence.store } : {}),
            ...(kernelToolDefinitions.length > 0
              ? { kernelTools: kernelToolDefinitions }
              : {}),
            // 执行模式工具门（solo/plan 硬约束）：拦截内置与桥接工具的全部调用
            ...(toolGate ? { toolGate } : {}),
            ...(toolGateHooks ? { toolGateHooks } : {}),
            // 子代理派发缝（DEC-14/15/16）：注册表并发上限来自治理设置
            ...(backgroundTaskRegistry
              ? {
                  backgroundTasks: {
                    registry: backgroundTaskRegistry,
                  },
                }
              : {}),
            ...(taskWorkContext &&
            options.taskWork &&
            run.scopeHandle?.role === "main"
              ? {
                  taskWork: {
                    manager: options.taskWork,
                    context: taskWorkContext,
                  },
                }
              : {}),
            executeTimeoutMs: governanceExecuteTimeoutMs,
            llmRetry: governanceLlmRetry,
            runToolContext,
          });
          rlog.lap("agent_factory_done");
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        if (run.operation?.kind === "compact") {
          await captureBoundary("pre");
          try {
            if (!run.threadId || !agent.contextHistory || !manualCompactPlan)
              throw new Error("当前Harness未提供手动上下文压缩能力。");
            for await (const event of streamCompactOperation({
              history: agent.contextHistory,
              threadId: run.threadId,
              runId,
              sessionId: run.sessionId,
              conversationId: run.conversationId,
              plan: manualCompactPlan,
              signal: run.controller.signal,
              now,
              onUsage: (usage) => {
                return options.runUsage?.update(runId, usage.modelCallId, {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  ...(usage.cachedInputTokens === undefined
                    ? {}
                    : { cachedInputTokens: usage.cachedInputTokens }),
                  provider: run.usageMeta?.provider ?? "builtin",
                  model: run.usageMeta?.model ?? "unknown",
                  ...(run.usageMeta?.providerInstanceId
                    ? { providerInstanceId: run.usageMeta.providerInstanceId }
                    : {}),
                  instanceId: run.actor.instanceId,
                  accessClientId: run.actor.accessClientId,
                });
              },
            })) {
              if (event.type === "run.completed") {
                run.status = "completed";
                await syncPersistedRunFromEvent(
                  options.agentRunMetadataService,
                  run,
                  event,
                  now,
                );
              }
              yield event;
            }
          } catch (error) {
            const event: StreamEvent = run.controller.signal.aborted
              ? { type: "run.canceled", runId, timestamp: now() }
              : toFailedEvent(runId, now, error);
            run.status = event.type === "run.canceled" ? "canceled" : "failed";
            await syncPersistedRunFromEvent(
              options.agentRunMetadataService,
              run,
              event,
              now,
            );
            yield event;
          }
          return;
        }

        let stream: AsyncIterable<unknown>;
        try {
          // Auto-inject canvas state summary so the agent has immediate awareness
          // of what's on the canvas without needing to call inspect_canvas first.
          // 门控在 resolveCanvasStateForRun：design 才注入（Code 会话无画布）。
          const canvasSummary = await resolveCanvasStateForRun(run, {
            ...(options.canvasRepository
              ? { canvasRepository: options.canvasRepository }
              : {}),
            localInstance: options.localInstance,
          });

          // 附件在下载与提示词构建两处消费：收窄成局部 const（缺省空数组，分支内不再判空）
          const attachments = run.attachments ?? [];
          const hasAttachments = attachments.length > 0;
          const userMessageId = inputMessageIdFor(run);
          let userMessage: HumanMessage;
          let attachmentDataMap: Record<string, string> = {};

          if (run.codeInputs?.length) {
            if (!run.scopeHandle)
              throw new Error("Code附件输入缺少可信Task工作域。");
            let { text: enrichedPrompt } = buildUserMessage(
              run.prompt,
              [],
              run.imageGenerationPreference,
              run.mentions,
              run.videoGenerationPreference,
              canvasSummary,
              "database",
            );
            enrichedPrompt = await applyPreStep(enrichedPrompt, run);
            const content = await codeInputContent(
              run.codeInputs,
              codeInputLimits,
              modelCapabilities,
              run.controller.signal,
            );
            userMessage = new HumanMessage({
              id: userMessageId,
              content: [{ type: "text", text: enrichedPrompt }, ...content],
            });
          } else if (hasAttachments) {
            if (run.scopeHandle)
              throw new Error(
                "Code附件必须经所属Task的附件提交接口解析，不能传任意图片URL。",
              );
            // Download images and build parallel data structures:
            // 1. imageBlocks: base64 content parts for LLM vision
            // 2. downloaded: assetId → base64 mapping for tool resolution
            const downloaded: Array<{
              assetId: string;
              mimeType: string;
              base64: string;
            }> = [];
            const imageBlocks = await Promise.all(
              attachments.map(async (a) => {
                try {
                  let b64: string;
                  let mime: string;

                  // Handle data URIs directly (canvas-ref images) — no fetch needed
                  const dataUriMatch = a.url.match(
                    /^data:([^;]+);base64,(.+)$/,
                  );
                  const inlineMime = dataUriMatch?.[1];
                  const inlineBase64 = dataUriMatch?.[2];
                  if (inlineMime && inlineBase64) {
                    mime = inlineMime;
                    b64 = inlineBase64;
                  } else {
                    const res = await fetch(a.url);
                    const buf = Buffer.from(await res.arrayBuffer());
                    mime =
                      a.mimeType ||
                      res.headers.get("content-type") ||
                      "image/png";
                    b64 = buf.toString("base64");
                  }

                  downloaded.push({
                    assetId: a.assetId,
                    mimeType: mime,
                    base64: b64,
                  });
                  // Use standard LangChain image_url format — works with both
                  // Google Gemini and OpenAI adapters. The Anthropic-style
                  // { type: "image", source_type: "base64" } format is NOT
                  // recognized by @langchain/google-genai and gets serialized
                  // as raw text, blowing past the token limit.
                  return {
                    type: "image_url" as const,
                    image_url: `data:${mime};base64,${b64}`,
                  };
                } catch {
                  return {
                    type: "image_url" as const,
                    image_url: a.url,
                  };
                }
              }),
            );

            // Build XML text tags for LLM to reference by assetId
            let { text: enrichedPrompt } = buildUserMessage(
              run.prompt,
              attachments,
              run.imageGenerationPreference,
              run.mentions,
              run.videoGenerationPreference,
              canvasSummary,
              run.scopeHandle ? "database" : undefined,
            );
            enrichedPrompt = await applyPreStep(enrichedPrompt, run);

            // Build assetId → data URI map for tool-level resolution
            attachmentDataMap = buildAttachmentDataMap(downloaded);

            userMessage = new HumanMessage({
              id: userMessageId,
              content: [
                { type: "text" as const, text: enrichedPrompt },
                ...imageBlocks,
              ],
            });
          } else {
            let { text: enrichedPrompt } = buildUserMessage(
              run.prompt,
              [],
              run.imageGenerationPreference,
              run.mentions,
              run.videoGenerationPreference,
              canvasSummary,
              run.scopeHandle ? "database" : undefined,
            );
            enrichedPrompt = await applyPreStep(enrichedPrompt, run);
            userMessage = new HumanMessage({
              id: userMessageId,
              content: enrichedPrompt,
            });
          }

          // HumanMessage进入graph之前捕获真实context与有效文件版本，并绑定本run的pre。
          await captureBoundary("pre");

          // 首轮流在这里创建（含 prestep/hooks 前置）；后台任务续轮的流在
          // 下方消费循环里重建（DEC-15 轮末闸门）
          rlog.lap("stream_call_start");
          stream = agent.streamEvents(
            {
              messages: [userMessage],
            },
            {
              configurable: {
                ...(run.threadId ? { thread_id: run.threadId } : {}),
                ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                instance_id: run.actor.instanceId,
                access_client_id: run.actor.accessClientId,
                ...(Object.keys(attachmentDataMap).length > 0
                  ? { user_attachment_map: attachmentDataMap }
                  : {}),
              },
              signal: run.controller.signal,
              version: "v2",
            },
          );
          rlog.lap("stream_call_returned");
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        const usageActor = run.actor;
        // 终态事件哨兵：正常路径适配器必发 run.completed / run.canceled / run.failed；
        // 异常路径可能静默结束，收尾必须补失败事件。
        // DEC-15 轮末闸门循环：模型收尾时若后台任务未结算，吞掉这次
        // run.completed，以「后台任务通知」为新一轮输入重入同一 thread；
        // 全部结算后的那次 completed 才放行（通知必达，usage 归属不变）。
        // continuationRounds 有治理上限（DEC-18）：防挂死任务导致无限续轮。
        let continuationInput: string | null = null;
        let suppressCompletedForContinuation = false;
        let continuationRounds = 0;
        const maxContinuations = governanceMaxContinuations;
        while (true) {
          let sawTerminalEvent = false;
          try {
            for await (const event of adaptDeepAgentStream({
              canonicalToolEvents: agent.canonicalToolEvents === true,
              conversationId: run.conversationId,
              now,
              ...(options.runUsage && usageActor
                ? {
                    onUsage: (usage: ModelCallUsage) => {
                      const owner = usage.owner ?? run.usageMeta;
                      return options.runUsage?.update(runId, usage.modelCallId, {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        provider: owner?.provider ?? "builtin",
                        model: owner?.model ?? "unknown",
                        ...(usage.cachedInputTokens === undefined
                          ? {}
                          : { cachedInputTokens: usage.cachedInputTokens }),
                        ...(owner?.providerInstanceId
                          ? {
                              providerInstanceId:
                                owner.providerInstanceId,
                            }
                          : {}),
                        instanceId: usageActor.instanceId,
                        accessClientId: usageActor.accessClientId,
                      });
                    },
                  }
                : {}),
              runId,
              sessionId: run.sessionId,
              // 分类占比（R4-1）：工具 schema 在这里量（装配刚回吐），消息侧由适配器在
              // on_chat_model_start 里量；两边在适配器里合并成一条 composition 随 run.usage 下发。
              toolComposition: measureTools(lastToolInventory),
              // 压缩口径与装配同一份：适配器据此检测摘要消息并发 run.compacted
              ...(autoCompact ? { autoCompact } : {}),
              signal: run.controller.signal,
              ...(options.env.agentStreamIdleTimeoutMs
                ? { idleTimeoutMs: options.env.agentStreamIdleTimeoutMs }
                : {}),
              // 空闲超时即中止底层请求（释放上游连接），本轮按有界失败收尾
              abortRun: () => run.controller.abort(),
              stream,
            })) {
              // 被拒的工具调用先合成 tool.* 事件下发（否则界面上「谁被拦了、为什么」
              // 完全没有记录——门在中间件里直接回了 ToolMessage，不产生任何工具事件）
              for (const denied of denialTracker?.drain() ?? []) {
                for (const synthetic of denialEvents(denied, runId, now())) {
                  yield synthetic;
                }
              }
              // 有界失败：同一工具连续被拒达上限就中止本轮，不再让它空转
              const fatalDenial = denialTracker?.fatalReason() ?? null;
              if (fatalDenial) {
                run.controller.abort();
                run.status = "failed";
                await updatePersistedRunFailure(
                  options.agentRunMetadataService,
                  run,
                  now,
                  new Error(fatalDenial),
                ).catch((persistErr) =>
                  console.error(
                    "[agent-runtime] Failed to persist tool-denial abort:",
                    persistErr,
                  ),
                );
                yield {
                  error: { code: "run_failed", message: fatalDenial },
                  runId,
                  timestamp: now(),
                  type: "run.failed",
                };
                return;
              }
              // 轮末闸门（DEC-15）：后台任务未结算就不让 run 收尾——吞掉
              // completed、以通知重开一轮；状态/持久化都保持 running 口径。
              // 已结算未注入的通知在这里补发 task.notification 事件（前端可见）；
              // 续轮有治理上限（DEC-18），打到上限即放行终态（兜底 abortAll 兜住挂死任务）
              if (
                event.type === "run.completed" &&
                backgroundTaskRegistry &&
                (backgroundTaskRegistry.hasPending() ||
                  backgroundTaskRegistry.hasNotifications())
              ) {
                const notes = backgroundTaskRegistry.drainNotifications();
                for (const note of notes) {
                  yield {
                    type: "task.notification" as const,
                    runId,
                    ...note,
                    timestamp: now(),
                  };
                }
                const stillPending = backgroundTaskRegistry.hasPending();
                continuationRounds += 1;
                if (stillPending && continuationRounds <= maxContinuations) {
                  const waitHint =
                    "\n（仍有后台任务在跑：继续手头工作或用 task_output 查询；全部结算后再收尾。）";
                  continuationInput = `${formatTaskNotificationsXml(notes)}${waitHint}`;
                  suppressCompletedForContinuation = true;
                  break;
                }
                if (stillPending) {
                  // 续轮上限打满：终止残留任务（取消通知经 task.notification 到前端），
                  // 随后放行终态——绝不带着挂死任务无限续轮
                  backgroundTaskRegistry.abortAll("后台任务续轮达上限");
                  for (const note of backgroundTaskRegistry.drainNotifications()) {
                    yield {
                      type: "task.notification" as const,
                      runId,
                      ...note,
                      timestamp: now(),
                    };
                  }
                }
              }
              run.status = mapEventToStatus(event);
              if (isTerminalEvent(event)) {
                sawTerminalEvent = true;
              }
              // 工具连续拒绝引起的主动中止保留可读失败原因。
              if (
                event.type === "run.canceled" &&
                denialTracker?.fatalReason()
              ) {
                const message =
                  denialTracker.fatalReason() ?? "工具连续被拒，已中止本轮。";
                const failedEvent: StreamEvent = {
                  error: { code: "run_failed", message },
                  runId,
                  timestamp: now(),
                  type: "run.failed",
                };
                run.status = "failed";
                await updatePersistedRunFailure(
                  options.agentRunMetadataService,
                  run,
                  now,
                  new Error(message),
                ).catch((persistErr) =>
                  console.error(
                    "[agent-runtime] Failed to persist tool-denial abort:",
                    persistErr,
                  ),
                );
                yield failedEvent;
                return;
              }
              try {
                await syncPersistedRunFromEvent(
                  options.agentRunMetadataService,
                  run,
                  event,
                  now,
                );
              } catch (error) {
                const failedEvent = toFailedEvent(runId, now, error);
                run.status = "failed";
                yield failedEvent;
                return;
              }
              yield event;

              if (!isTerminalEvent(event) && options.eventDelayMs) {
                try {
                  await delay(options.eventDelayMs, undefined, {
                    signal: run.controller.signal,
                  });
                } catch {
                  run.status = "canceled";
                  yield {
                    runId,
                    timestamp: now(),
                    type: "run.canceled",
                  };
                  return;
                }
              }
            }
          } catch (streamError) {
            // Catch DB / checkpoint errors that bubble up from the LangGraph stream
            // (e.g. Supabase circuit-breaker, connection pool exhaustion).
            // Instead of crashing the process, yield a clean failure event.
            console.error(
              "[agent-runtime] Stream iteration failed:",
              streamError,
            );
            const failedEvent = toFailedEvent(runId, now, streamError);
            run.status = "failed";
            await updatePersistedRunFailure(
              options.agentRunMetadataService,
              run,
              now,
              streamError,
            ).catch((persistErr) =>
              console.error(
                "[agent-runtime] Failed to persist run failure:",
                persistErr,
              ),
            );
            yield failedEvent;
            return;
          }

          // 续轮保持同一Task/线程；静默结束的异常由下面的终态哨兵收尾。
          if (suppressCompletedForContinuation) {
            suppressCompletedForContinuation = false;
            // 续轮：附件映射随首轮消息已进 thread 历史，无需重带
            stream = agent.streamEvents(
              {
                messages: [
                  new HumanMessage({
                    id: JSON.stringify([
                      "background-continuation",
                      runId,
                      continuationRounds,
                    ]),
                    content: continuationInput ?? "",
                  }),
                ],
              },
              {
                configurable: {
                  ...(run.threadId ? { thread_id: run.threadId } : {}),
                  ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                  instance_id: run.actor.instanceId,
                  access_client_id: run.actor.accessClientId,
                },
                signal: run.controller.signal,
                version: "v2",
              },
            );
            continue;
          }
          if (!sawTerminalEvent && run.status === "running") {
            // 统一持久化失败终态，可读原因由 message 承载。
            const message = "运行被中止且未产生结束事件（无终态事件）。";
            const failedEvent: StreamEvent = {
              error: { code: "run_failed", message },
              runId,
              timestamp: now(),
              type: "run.failed",
            };
            run.status = "failed";
            await updatePersistedRunFailure(
              options.agentRunMetadataService,
              run,
              now,
              new Error(message),
            ).catch((persistErr) =>
              console.error(
                "[agent-runtime] Failed to persist silent-abort run failure:",
                persistErr,
              ),
            );
            yield failedEvent;
            return;
          }
          break;
        }
      } finally {
        // 后台/前台子代理兜底清理（DEC-15）：run 终态后不允许子代理再存活
        backgroundTaskRegistry?.abortAll("本轮 run 已结束");
        // DEC-1：turn 收尾（成功/失败/取消）发射 turn-stopping，用量等插件据此结算
        if (options.emitTurnStopping) {
          try {
            await options.emitTurnStopping({ runId });
          } catch (emitError) {
            console.warn(
              "[agent-runtime] turn-stopping listeners failed:",
              emitError,
            );
          }
        }
        // 仅临时沙箱随 run 清理（dev per-run 目录）；prod 的工作区按画布持久，
        // 清掉它等于删用户项目文件（文件系统统一后 /workspace 即此目录）
        /**
         * 用户钩子（R5-2）的**终点**：本轮收尾（成功/失败/取消都算）时在项目工作目录里跑。
         * 放在 finally 里是为了「取消/失败也跑得到」——用户配的是「每轮结束」而不是「成功结束」。
         * 事件在此之后才发（客户端按 runId 收，不依赖终态先后）。
         */
        if (hookCommands.end.length > 0 && backendResult.sandboxDir) {
          try {
            for (const hook of await runHooks({
              event: "turn-end",
              commands: hookCommands.end,
              cwd: backendResult.sandboxDir,
              timeoutMs: governanceExecuteTimeoutMs,
              previewMaxChars: processLimits.previewMaxChars,
              ...(run.scopeHandle
                ? {
                    runCommand: options.processSandbox
                      ? createScopedHookCommand({
                          sandbox: options.processSandbox,
                          scope: run.scopeHandle,
                          runId,
                          event: "turn-end",
                          limits: processLimits,
                        })
                      : async () => {
                          throw new Error("Code 钩子执行器不可用，拒绝裸跑。");
                        },
                  }
                : {}),
              ...(hookShell ? { shell: hookShell } : {}),
            })) {
              yield {
                type: "run.hook" as const,
                runId,
                ...hook,
                timestamp: now(),
              };
            }
          } catch (hookError) {
            // 钩子是旁路：这里再兜一层，绝不让它把收尾流程带崩
            console.warn("[agent-runtime] turn-end hooks failed:", hookError);
          }
        }
        // 用户turn-end hooks结束后、释放前台资源前保存post；失败/取消仍走finally。
        await captureBoundary("post");
        if (backendResult.sandboxDir && backendResult.ephemeral) {
          rm(backendResult.sandboxDir, { recursive: true, force: true }).catch(
            (err) => console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
        await leaveForeground?.();
      }
    },
  };
  const execute = service.streamRun.bind(service);
  service.streamRun = async function* (
    runId: string,
  ): AsyncGenerator<StreamEvent> {
    const run = runs.get(runId);
    if (run?.consumed) return;
    // 在第一个await之前原子认领消费者；no-op重订阅不得完成活动Run或写其边界。
    if (run) run.consumed = true;
    let terminal: StreamEvent | undefined;
    try {
      for await (const event of execute(runId)) {
        if (isTerminalEvent(event)) {
          // 模型结束仍有真实turn-end/post捕获/前台释放；公共完成不能早于它们。
          terminal = event;
          continue;
        }
        const run = runs.get(runId);
        const visible =
          event.type === "tool.started" && event.input
            ? {
                ...event,
                input:
                  run?.projectToolInput?.(event.toolName, event.input) ??
                  event.input,
              }
            : event;
        await run?.eventSink?.(visible);
        yield visible;
      }
      if (terminal) {
        await run?.eventSink?.(terminal);
        yield terminal;
      }
    } catch (error) {
      // 在关闭上游iterator之前中止工具signal，禁止丢失持久投影后继续写文件。
      run?.controller.abort("持久事件投影失败");
      throw error;
    } finally {
      if (run) {
        // 启动前失败/取消也保留partial事实；不在finally把当前目录伪装为pre。
        await persistBoundary(run, "pre", unstartedTurnFacts);
        await persistBoundary(run, "post", unstartedTurnFacts);
      }
      completions.get(runId)?.finish();
    }
  };
  return service;
}

/**
 * 把一次被拒的工具调用合成成 `tool.started` + `tool.completed` 事件。
 *
 * 形状与真实工具事件一致（客户端 `applyToolEvent` 直接可用），差别只在结果：
 * `output.denied === true` 且 summary 是拒绝原因——界面因此能显示「被拦」而不只是
 * 模型的转述。
 */
function denialEvents(
  denied: ToolDenialRecord,
  runId: string,
  timestamp: string,
): StreamEvent[] {
  return [
    {
      ...(denied.input ? { input: denied.input } : {}),
      runId,
      timestamp,
      toolCallId: denied.toolCallId,
      toolName: denied.toolName,
      type: "tool.started",
    },
    {
      output: {
        denied: true,
        reason: denied.reason,
        count: denied.count,
      },
      outputSummary: `工具被拒绝（第 ${denied.count} 次）：${denied.reason}`,
      runId,
      timestamp,
      toolCallId: denied.toolCallId,
      toolName: denied.toolName,
      type: "tool.completed",
    },
  ] as StreamEvent[];
}

function isTerminalEvent(event: StreamEvent) {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
}

function mapEventToStatus(event: StreamEvent): RuntimeRunStatus {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return "running";
  }
}

function toFailedEvent(
  runId: string,
  now: () => string,
  error: unknown,
): StreamEvent {
  // Log full error detail server-side
  console.error(`[runtime] Agent run failed for run ${runId}:`, error);

  return {
    error: {
      code: "run_failed",
      message: sanitizeErrorForClient(error),
    },
    runId,
    timestamp: now(),
    type: "run.failed",
  };
}

async function updatePersistedRunStatus(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  status: "running" | "completed" | "canceled",
  options?: {
    completedAt?: string;
  },
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
    runId: run.runId,
    status,
  });
}

async function updatePersistedRunFailure(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  now: () => string,
  error: unknown,
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    completedAt: now(),
    errorCode: "run_failed",
    errorMessage:
      error instanceof Error ? error.message : "Deep agent runtime failed.",
    runId: run.runId,
    status: "failed",
  });
}

async function syncPersistedRunFromEvent(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  event: StreamEvent,
  now: () => string,
) {
  if (event.type === "run.completed") {
    await updatePersistedRunStatus(agentRunMetadataService, run, "completed", {
      completedAt: now(),
    });
    return;
  }

  if (event.type === "run.failed") {
    await updatePersistedRunFailure(
      agentRunMetadataService,
      run,
      now,
      new Error(event.error.message),
    );
    return;
  }

  /**
   * 用户取消也要落终态。此前漏了这一支（只认 completed/failed），实测后果：点「停止本轮」
   * 后流确实停了（`stream_done`），但行永远停在 `running`——只能等下次进程启动的孤儿对账
   * 收敛成 `failed`，那一轮明明是用户主动取消却被记成失败。
   */
  if (event.type === "run.canceled") {
    await updatePersistedRunStatus(agentRunMetadataService, run, "canceled", {
      completedAt: now(),
    });
  }
}
