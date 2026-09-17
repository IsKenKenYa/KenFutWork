// @credits-system — Agent tool runtime with credit checks before image/video generation
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  type BillingErrorCode,
  type ImageAttachment,
  type ImageGenerationPreference,
  type ImageQualityLevel,
  type MessageMention,
  type RunCancelResponse,
  type RunCreateRequest,
  type RunCreateResponse,
  resolveContextWindow,
  type StreamEvent,
  type VideoGenerationPreference,
  type VideoResolution,
  type WorkspaceSettings,
} from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { HumanMessage } from "@langchain/core/messages";
import type { ServerEnv } from "../config/env.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { AuthenticatedUser } from "../features/auth/types.js";
import type { BlobStore } from "../features/blob/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { BrandKitService } from "../features/brand-kit/brand-kit-service.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  type TierGuard,
  TierGuardError,
} from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import { parseInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import { hooksFor, runHooks } from "../features/settings/hooks.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { formatUserRulesFragment } from "../features/settings/user-rules.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type { ToolExecutionContext, ToolRegistry } from "../kernel/types.js";
import { instanceHeadersOption } from "../providers/instance-headers.js";
import { resolveInstanceChatModel } from "../providers/resolve.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createPipelineLogger } from "../ws/logger.js";
import { type CompactionPlan, resolveCompactionPlan } from "./auto-compact.js";
import { createAgentBackend } from "./backends/index.js";
import type { ToolGate, ToolGateHooks } from "./deep-agent.js";
import {
  createDefaultModelSpecifier,
  createKenFutWorkDeepAgent,
  type KenFutWorkAgent,
  type KenFutWorkAgentFactory,
} from "./deep-agent.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { measureTools } from "./prompt-composition.js";
import { withBoundWorkDir } from "./sandbox-dir.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";
import {
  createToolDenialTracker,
  type ToolDenialRecord,
} from "./tool-denial.js";
// execute 工具由 deepagents 内置提供（LocalShellBackend 作为 sandbox backend）
// 不需要自定义代码执行工具
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { buildCanvasSummaryForContext } from "./tools/inspect-canvas.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type {
  WorkspaceSkillEntry,
  WorkspaceSkillsLoader,
} from "./workspace-skills.js";
/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
/**
 * run → agent preset（DEC-2 会话级能力集）：
 * 画布内运行归 design preset（画布工具为主），无画布的纯会话归 code preset。
 * 显式传入 preset 时以传入值优先。
 */
export function resolvePresetForRun(run: {
  canvasId?: string | undefined;
  preset?: "design" | "code" | undefined;
}): "design" | "code" {
  return run.preset ?? (run.canvasId ? "design" : "code");
}

export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  mentions: MessageMention[] = [],
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
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

  const mentionXmlBlocks = buildMentionXmlBlocks(mentions);
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

function buildMentionXmlBlocks(mentions: MessageMention[]): string[] {
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
      .map(
        (mention, i) =>
          `<skill index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" name="${escapeXmlAttribute(mention.label)}" slug="${escapeXmlAttribute(mention.slug)}">\nThe user explicitly requested this skill. Read \`/workspace-skills/${mention.slug}/SKILL.md\` for full instructions and follow them.\n</skill>`,
      )
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
  accessToken?: string;
  /** billing 门中止原因：流会静默结束（无终态事件），收尾须据此补 run.failed。 */
  billingFailure?: { code: string; message: string };
  consumed: boolean;
  controller: AbortController;
  modelOverride?: string;
  runId: string;
  /**
   * 沙箱目录名用的 id（画布 UUID）。
   *
   * 无工作目录的 Code 会话，客户端只能把**会话 UUID** 当 canvasId 发上来，
   * 直接落盘会得到 `tmp/sandbox/<会话UUID>`——与服务端懒供给的「Code 工作台」画布对不上。
   * 运行入口解析出真实画布后放这里；事件路由仍用 `canvasId`（客户端认的是它）。
   */
  sandboxScopeId?: string;
  status: RuntimeRunStatus;
  threadId?: string;
  userId?: string;
  /** 用量归属元数据（DEC-6），模型解析后填入；turn-stopping 结算时消费。 */
  usageMeta?: {
    provider: string;
    model: string;
    providerInstanceId?: string;
  };
};

type CreateAgentRuntimeOptions = {
  agentPersistenceService?: AgentPersistenceService;
  agentFactory?: KenFutWorkAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  /** 品牌套件服务（brand-kit 插件提供）：get_brand_kit 工具经它取数。 */
  brandKitService?: BrandKitService;
  /** 画布数据访问（工作区作用域）：run 启动时读画布摘要、解析 brandKitId。 */
  canvasRepository?: CanvasRepository;
  /** 画布写入（canvas 插件提供）：生成物落画布经此，运行时不再直连存储 SDK。 */
  canvasService?: CanvasService;
  /** 工作区技能加载（skills/canvas 聚合的数据访问提供）：运行时不再直连 SDK。 */
  workspaceSkillsLoader?: WorkspaceSkillsLoader;
  /**
   * 画布 → 项目绑定的本机工作目录（`projects.work_dir`，判定见
   * features/projects/work-dir.ts）。命中时覆盖 `env.canvasWorkDirs`：
   * 用户在界面上绑定的目录优先于运维的环境变量映射。
   */
  projectWorkDirLoader?: (canvasId: string) => Promise<string | null>;
  connectionManager?: ConnectionManager;
  /** 对象存储（blob 缝）：生成物落盘与 URL（M3.1 起不再直连 Supabase Storage）。 */
  blob: BlobStore;
  creditService?: CreditService;
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
  /** 工作区设置（读「用户规则」拼进系统提示词；缺省不注入）。 */
  settingsService?: Pick<SettingsService, "getWorkspaceSettings"> | undefined;
  /** agent 链路用量累积器（turn-stopping 结算，DEC-6）。 */
  runUsage?: RunUsageAccumulator;
  /** 内核统一工具注册表：按 run 的 preset 过滤后桥接进模型工具列表（§4.5）。 */
  tools?: ToolRegistry;
  /** 事件缝（DEC-1）：turn 收尾时发射 turn-stopping，插件据此结算。 */
  emitTurnStopping?: (payload: { runId: string }) => Promise<void>;
  /**
   * 事件缝（DEC-1）：turn 开始时发射 pre-step（waterfall），插件可改写/拒绝模型输入。
   * 返回改写后的 input（无监听器时原样返回）。
   */
  emitPreStep?: (payload: {
    input: string;
    runId: string;
    threadId?: string | undefined;
  }) => Promise<{ input: unknown }>;
  /**
   * 执行模式工具门（agent-modes 缝经 agent-runs 插件注入）：按线程返回
   * solo/plan 的工具拦截判定；返回 undefined 表示全放行（agent 等模式）。
   */
  toolGateFor?: (threadId: string) => ToolGate | undefined;
  /** 插件贡献的提示段（能力 systemPrompt）；每次 run 调用一次。 */
  pluginPromptFragments?: () => string[];
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  viewerService?: ViewerService;
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());

  // DEC-1 pre-step：把改写权交给事件监听器（执行模式 plan 引导等），无监听器原样返回
  const applyPreStep = async (
    input: string,
    threadId: string | undefined,
  ): Promise<string> => {
    if (!options.emitPreStep) {
      return input;
    }
    const result = await options.emitPreStep({
      input,
      runId: "",
      ...(threadId ? { threadId } : {}),
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
        blob: options.blob,
        onToolInventory: (tools) => {
          lastToolInventory = tools;
        },
      }));

  // ── Billing error helper: push WS event + abort run ──────────
  function pushBillingErrorAndAbort(
    run: {
      billingFailure?: { code: string; message: string };
      conversationId: string;
      controller: AbortController;
      runId: string;
    },
    canvasId: string | undefined,
    opts: { connectionManager?: ConnectionManager },
    code: BillingErrorCode,
    message: string,
    extra?: {
      currentBalance?: number;
      requiredAmount?: number;
      plan?: string;
      dailyClaimed?: boolean;
    },
  ): void {
    const canvasTarget = canvasId ?? run.conversationId;
    // 先记录中止原因：billing 门直接 abort 会让流静默结束（不产生 run.failed），
    // 收尾处据此补发失败事件——否则 run 行永远停在 running，且 WS 重试判定
    // 拿不到失败文案，额度不足这类永久性失败会被无意义地连环重试。
    run.billingFailure = { code, message };
    if (!opts.connectionManager || !canvasTarget) {
      console.warn(
        `[billing] pushBillingErrorAndAbort: no connectionManager or canvasTarget, billing.error (${code}) not sent to client`,
      );
    } else {
      opts.connectionManager.pushToCanvas(canvasTarget, {
        type: "billing.error",
        runId: run.runId,
        timestamp: new Date().toISOString(),
        code,
        message,
        ...extra,
      });
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
  }

  return {
    cancelRun(runId: string): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }

      run.status = "canceled";
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RunCreateRequest,
      runOptions?: {
        accessToken?: string;
        model?: string;
        /** 沙箱目录名用的 id（画布 UUID）；缺省回落到 canvasId。 */
        sandboxScopeId?: string;
        threadId?: string;
        userId?: string;
      },
    ): RunCreateResponse {
      const runId = runIdFactory();
      const { accessToken: _ignoredAccessToken, ...runInput } = input;

      runs.set(runId, {
        ...runInput,
        ...(runOptions?.accessToken
          ? { accessToken: runOptions.accessToken }
          : {}),
        consumed: false,
        controller: new AbortController(),
        ...(runOptions?.model ? { modelOverride: runOptions.model } : {}),
        ...(runOptions?.sandboxScopeId
          ? { sandboxScopeId: runOptions.sandboxScopeId }
          : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.userId ? { userId: runOptions.userId } : {}),
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

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.consumed) {
        return;
      }

      run.consumed = true;
      run.status = "running";

      const rlog = createPipelineLogger("runtime", { runId });

      try {
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
      if (options.jobService && run.accessToken && run.userId) {
        const jobSvc = options.jobService;
        const accessToken = run.accessToken;
        const userId = run.userId;
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

          // Look up personal workspace directly — the viewer is already
          // bootstrapped from the normal auth flow, so we skip ensureViewer
          // to avoid its strict email validation on the profile schema.
          const ws = await options.viewerService
            ?.resolveWorkspace({ id: userId })
            .catch(() => null);
          if (!ws?.id) throw new Error("No personal workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // ── Tier guard + credit checks (same as HTTP route) ──
          const workspaceId = ws.id;
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            const quality = (input.quality as ImageQualityLevel) ?? "hd";
            try {
              options.tierGuard.checkModelAccess(sub.plan, input.model);
              options.tierGuard.checkResolution(sub.plan, quality);
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              input.model,
              "image_generation",
              { quality },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  currentBalance: balanceInfo.balance,
                  requiredAmount: creditsCost,
                  plan: balanceInfo.plan,
                  dailyClaimed: balanceInfo.dailyClaimed,
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          const job = await jobSvc.createJob(user, {
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "image_generation",
            payload: {
              prompt: input.prompt,
              title: input.title,
              model: input.model,
              aspect_ratio: input.aspectRatio,
              ...(input.inputImages ? { input_images: input.inputImages } : {}),
            },
          });

          // Deduct credits after job creation
          if (options.creditService && creditsCost > 0) {
            try {
              const txId = await options.creditService.deductCredits(
                workspaceId,
                userId,
                creditsCost,
                job.id,
                `Image generation: ${input.model}`,
              );
              await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
            } catch (deductError) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              throw deductError;
            }
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
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
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

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
                    await options.canvasService.insertImageElement(
                      { accessToken, id: userId },
                      {
                        canvasId,
                        objectPath: result.object_path,
                        width: result.width ?? 1024,
                        height: result.height ?? 1024,
                        mimeType: result.mime_type ?? "image/png",
                        ...(input.title ? { title: input.title } : {}),
                        ...(explicitPlacement
                          ? { placement: explicitPlacement }
                          : {}),
                      },
                    );
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

          const ws = await options.viewerService
            ?.resolveWorkspace({ id: userId })
            .catch(() => null);
          if (!ws?.id) throw new Error("No personal workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // ── Tier guard + credit checks (same as HTTP route) ──
          const workspaceId = ws.id;
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            try {
              options.tierGuard.checkModelAccess(sub.plan, input.model);
              if (input.resolution) {
                // 工具分辨率还含 "480p"（不在 VideoResolution 枚举内，计费守卫按最低档放行）
                options.tierGuard.checkVideoResolution(
                  sub.plan,
                  input.resolution as VideoResolution,
                );
              }
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              input.model,
              "video_generation",
              {
                ...(input.duration != null ? { duration: input.duration } : {}),
                ...(input.resolution
                  ? { resolution: input.resolution as VideoResolution }
                  : {}),
              },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  currentBalance: balanceInfo.balance,
                  requiredAmount: creditsCost,
                  plan: balanceInfo.plan,
                  dailyClaimed: balanceInfo.dailyClaimed,
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          const job = await jobSvc.createJob(user, {
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "video_generation",
            payload: {
              prompt: input.prompt,
              model: input.model,
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

          // Deduct credits after job creation
          if (options.creditService && creditsCost > 0) {
            try {
              const txId = await options.creditService.deductCredits(
                workspaceId,
                userId,
                creditsCost,
                job.id,
                `Video generation: ${input.model}`,
              );
              await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
            } catch (deductError) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              throw deductError;
            }
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
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
              throw new Error("Run was canceled");
            }

            const current = await jobSvc.getJobAdmin(job.id);

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
                    await options.canvasService.insertVideoElement(
                      { accessToken, id: userId },
                      {
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
                      },
                    );
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

      // Load workspace skills (user-installed skills from DB).
      // Done before backend creation so we know whether to add the
      // /workspace-skills/ Store route.
      let workspaceSkills: WorkspaceSkillEntry[] = [];
      if (run.canvasId && options.workspaceSkillsLoader) {
        try {
          workspaceSkills = await options.workspaceSkillsLoader(run.canvasId);
          rlog.lap("workspace_skills_loaded", {
            count: workspaceSkills.length,
          });
        } catch (err) {
          // Non-fatal: agent runs without workspace skills
          console.warn("[runtime] Failed to load workspace skills:", err);
        }
      }

      // Create backend — production uses StateBackend (no local shell).
      const backendCanvasId = run.sandboxScopeId ?? run.canvasId;
      // 项目绑定的本机工作目录（Code 模式「工作目录=项目」）：覆盖环境变量映射。
      // 读不到就照旧回沙箱目录——绑定是增强，不是 run 的前置条件。
      const boundWorkDir =
        backendCanvasId && options.projectWorkDirLoader
          ? await options
              .projectWorkDirLoader(backendCanvasId)
              .catch(() => null)
          : null;
      const backendResult = createAgentBackend(
        withBoundWorkDir(options.env, backendCanvasId, boundWorkDir),
        backendCanvasId,
        { hasWorkspaceSkills: workspaceSkills.length > 0 },
      );

      /**
       * 自动压缩的两个运行期值，声明在**装配块之外**：触发线在装配期算（要读模型目录与设置），
       * 事件检测在流式适配期用（同一个口径）——两个块是兄弟，必须看到同一份。
       */
      let autoCompactEnabled = true;
      let autoCompact: CompactionPlan | undefined;
      /** 用户钩子（R5-2）：起点在装配前跑，终点在本轮收尾时跑；都是旁路。 */
      let hookCommands: { start: string[]; end: string[] } = {
        start: [],
        end: [],
      };
      let hookShell: WorkspaceSettings["terminalShell"] | undefined;

      try {
        /** 被拒工具调用的记账（含连续拒绝计数）；门存在时才有值。 */
        let denialTracker:
          | ReturnType<typeof createToolDenialTracker>
          | undefined;
        let agent: KenFutWorkAgent;
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
          if (
            typeof resolvedModel === "string" &&
            run.accessToken &&
            run.userId &&
            options.modelProviders
          ) {
            const instanceSpec = parseInstanceSpecifier(resolvedModel);
            if (instanceSpec) {
              /**
               * 起始期 fail loud（E）：带实例前缀的模型必须能在这个用户的目录里找到。
               * 不做这一步时，模型被改名/停用后要等上游回 4xx 才暴露，且界面只有通用文案。
               */
              if (options.modelCatalog) {
                const verdict = await options.modelCatalog
                  .validateSpecifier(
                    {
                      accessToken: run.accessToken,
                      email: "",
                      id: run.userId,
                      userMetadata: {},
                    },
                    resolvedModel,
                  )
                  .catch(() => ({ ok: true as const }));
                if (!verdict.ok) {
                  throw new Error(verdict.message);
                }
              }
              const credentials =
                await options.modelProviders.resolveCredentials(
                  {
                    accessToken: run.accessToken,
                    email: "",
                    id: run.userId,
                    userMetadata: {},
                  },
                  instanceSpec.instanceId,
                );
              resolvedModel = resolveInstanceChatModel(
                credentials.protocol,
                instanceSpec.model,
                {
                  apiKey: credentials.apiKey,
                  ...(credentials.baseUrl
                    ? { baseUrl: credentials.baseUrl }
                    : {}),
                  // 自定义头逐会话取值（§4.8）：亲和类头写死固定值会把所有会话钉到同一分片
                  ...instanceHeadersOption(credentials.headers, {
                    sessionId: run.sessionId,
                    threadId: run.threadId,
                  }),
                },
              );
              run.usageMeta = {
                provider: "instance",
                model: instanceSpec.model,
                providerInstanceId: instanceSpec.instanceId,
              };

              // 平台池额度门（FORM-10）：走系统供应商的对话必须有余额。
              // 放在 runtime 而非 HTTP 路由，是因为 workbench 经 WS 发起 run，
              // 只在路由拦会漏掉真实使用路径。BYOK 不计费也不拦。
              // 工作区直查用户 client（同图像路径）：ensureViewer 的邮箱校验
              // 在 runtime 上下文拿不到真实邮箱，不可用。
              const scope = await options.modelProviders.getInstanceScope(
                instanceSpec.instanceId,
              );
              if (scope === "system" && options.creditService) {
                const balanceWorkspace = await options.viewerService
                  ?.resolveWorkspace({ id: run.userId })
                  .catch(() => null);
                if (balanceWorkspace?.id) {
                  const balanceInfo = await options.creditService.getBalance(
                    balanceWorkspace.id,
                  );
                  if (balanceInfo.balance <= 0) {
                    const billingMessage =
                      "平台额度已用完，请联系管理员充值或改用自己的供应商 Key。";
                    pushBillingErrorAndAbort(
                      run,
                      run.canvasId,
                      options,
                      "insufficient_credits",
                      billingMessage,
                      {
                        currentBalance: balanceInfo.balance,
                        plan: balanceInfo.plan,
                        dailyClaimed: balanceInfo.dailyClaimed,
                      },
                    );
                    // 不能静默 return：生成器零事件结束会让 run 行停在 running、
                    // WS 重试判定拿不到失败文案（额度这类永久性失败被连环重试）。
                    run.status = "failed";
                    await updatePersistedRunFailure(
                      options.agentRunMetadataService,
                      run,
                      now,
                      new Error(billingMessage),
                    ).catch((persistErr) =>
                      console.error(
                        "[agent-runtime] Failed to persist billing run failure:",
                        persistErr,
                      ),
                    );
                    yield {
                      error: { code: "run_failed", message: billingMessage },
                      runId,
                      timestamp: now(),
                      type: "run.failed",
                    };
                    return;
                  }
                }
              }
            }
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

              const resolved = run.userId
                ? await options.viewerService
                    ?.resolveWorkspace({ id: run.userId })
                    .catch(() => null)
                : null;
              const workspaceId = resolved?.id ?? "default";
              const objectPath = `${workspaceId}/${Date.now()}-${fileName}`;

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
          if (run.canvasId && run.userId && options.canvasRepository) {
            const canvasWorkspace = await options.viewerService
              ?.resolveWorkspace({ id: run.userId })
              .catch(() => null);
            if (canvasWorkspace) {
              brandKitId = await options.canvasRepository
                .findProjectBrandKitId(canvasWorkspace.id, run.canvasId)
                .catch(() => null);
            }
          }

          rlog.lap("brand_kit_resolved");

          // Pre-write workspace skill SKILL.md files AND associated files
          // (scripts/, references/, assets/) into the Store so the agent can
          // read_file them via the /workspace-skills/ route.
          const store = persistence?.store;
          if (workspaceSkills.length > 0 && store && run.canvasId) {
            const storeNamespace = [
              "projects",
              run.canvasId,
              "workspace-skills",
            ];
            const now_ = new Date().toISOString();

            const writeOps: Promise<void>[] = [];
            for (const skill of workspaceSkills) {
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
            const totalFiles = workspaceSkills.reduce(
              (sum, s) => sum + s.files.length,
              0,
            );
            rlog.lap("workspace_skills_stored", {
              count: workspaceSkills.length,
              files: totalFiles,
            });
          }

          // §4.5 统一工具注册表：ctx.tools 按 preset 过滤后桥接进模型工具列表；
          // execute 改经注册表 guarded 路径派发（tool-pre-execute 拦截在注册表侧生效）
          const preset = resolvePresetForRun(run);
          const kernelToolRegistry = options.tools;
          const kernelToolDefinitions = kernelToolRegistry
            ? kernelToolRegistry.list(preset).map((tool) => ({
                ...tool,
                execute: (
                  args: Record<string, unknown>,
                  execCtx: ToolExecutionContext,
                ) => kernelToolRegistry.execute(tool.name, args, execCtx),
              }))
            : [];

          // 执行模式工具门：solo/plan 按线程策略拦截（undefined = 全放行）
          const toolGate =
            run.threadId && options.toolGateFor
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

          // 工具执行上下文的工作区：工具侧（skill 目录等）按工作区取数，
          // 否则只能拿到 runId/accessToken，无法解析工作区（曾致技能工具恒空）。
          let toolWorkspaceId: string | undefined;
          if (run.userId && options.viewerService) {
            const workspace = await options.viewerService
              .resolveWorkspace({ id: run.userId })
              .catch(() => null);
            toolWorkspaceId = workspace?.id;
          }

          /**
           * 用户规则（设置 → 规则与记忆）拼进系统提示词：这是那段 UI 的**真实消费方**
           * （此前只写 localStorage，服务端没人读）。读失败不阻断 run（规则是增强，不是前置）。
           */
          let userRulesFragment: string[] = [];
          if (toolWorkspaceId && options.settingsService) {
            const workspaceSettings = await options.settingsService
              .getWorkspaceSettings(
                {
                  accessToken: run.accessToken ?? "",
                  email: "",
                  id: run.userId ?? "",
                  userMetadata: {},
                },
                toolWorkspaceId,
              )
              .catch(() => null);
            userRulesFragment = formatUserRulesFragment({
              userRules: workspaceSettings?.userRules,
              ruleEntries: workspaceSettings?.ruleEntries,
            });
            // 同一个设置对象顺带读压缩开关（少一次库往返）
            autoCompactEnabled = workspaceSettings?.autoCompactEnabled ?? true;
            // 钩子也从这个对象读（同一趟）：起点钩子在装配 agent 之前跑
            hookCommands = {
              start: hooksFor(workspaceSettings?.hooks, "turn-start"),
              end: hooksFor(workspaceSettings?.hooks, "turn-end"),
            };
            hookShell = workspaceSettings?.terminalShell;
          }

          if (hookCommands.start.length > 0 && backendResult.sandboxDir) {
            for (const hook of await runHooks({
              event: "turn-start",
              commands: hookCommands.start,
              cwd: backendResult.sandboxDir,
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
          if (autoCompactEnabled) {
            const specifier =
              typeof run.modelOverride === "string"
                ? run.modelOverride
                : typeof options.model === "string"
                  ? options.model
                  : "";
            let declaredWindow: number | null = null;
            let declaredMaxOutput: number | null = null;
            if (specifier && options.modelCatalog && run.accessToken) {
              const entries = await options.modelCatalog
                .listCatalog({
                  accessToken: run.accessToken,
                  email: "",
                  id: run.userId ?? "",
                  userMetadata: {},
                })
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
            console.log(
              `[agent] 自动压缩触发线 ${plan.trigger.value} tokens（来源 ${plan.source}，保留 ${plan.keep.value} 条）`,
            );
          }

          agent = resolvedAgentFactory({
            backendResult,
            ...(brandKitId ? { brandKitId } : {}),
            ...(options.brandKitService
              ? { brandKitService: options.brandKitService }
              : {}),
            ...(options.canvasRepository
              ? { canvasRepository: options.canvasRepository }
              : {}),
            ...(run.canvasId ? { canvasId: run.canvasId } : {}),
            ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
            ...(options.connectionManager
              ? { connectionManager: options.connectionManager }
              : {}),
            env: options.env,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(persistImage ? { persistImage } : {}),
            ...(autoCompact ? { autoCompact } : {}),
            // execute 工具由 LocalShellBackend 自动提供，无需手动传递
            ...(submitImageJob ? { submitImageJob } : {}),
            ...(submitVideoJob ? { submitVideoJob } : {}),
            ...(persistence ? { store: persistence.store } : {}),
            ...(workspaceSkills.length > 0 ? { workspaceSkills } : {}),
            ...(kernelToolDefinitions.length > 0
              ? { kernelTools: kernelToolDefinitions }
              : {}),
            // 执行模式工具门（solo/plan 硬约束）：拦截内置与桥接工具的全部调用
            ...(toolGate ? { toolGate } : {}),
            ...(toolGateHooks ? { toolGateHooks } : {}),
            // 插件提示段每次 run 取一次：新装/卸载插件下一轮即生效；用户规则拼在它之后
            ...(options.pluginPromptFragments || userRulesFragment.length > 0
              ? {
                  systemPromptExtras: [
                    ...(options.pluginPromptFragments?.() ?? []),
                    ...userRulesFragment,
                  ],
                }
              : {}),
            runToolContext: {
              runId,
              ...(run.canvasId ? { canvasId: run.canvasId } : {}),
              ...(run.threadId ? { threadId: run.threadId } : {}),
              ...(run.accessToken ? { accessToken: run.accessToken } : {}),
              ...(toolWorkspaceId ? { workspaceId: toolWorkspaceId } : {}),
            },
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

        let stream: AsyncIterable<unknown>;
        try {
          // Auto-inject canvas state summary so the agent has immediate awareness
          // of what's on the canvas without needing to call inspect_canvas first.
          let canvasSummary: string | null = null;
          if (run.canvasId && run.userId && options.canvasRepository) {
            try {
              const canvasWorkspace = await options.viewerService
                ?.resolveWorkspace({ id: run.userId })
                .catch(() => null);
              const canvasRow = canvasWorkspace
                ? await options.canvasRepository
                    .findById(canvasWorkspace.id, run.canvasId)
                    .catch(() => null)
                : null;
              const content = canvasRow?.content as
                | { elements?: unknown[] }
                | undefined;
              if (content?.elements) {
                canvasSummary = buildCanvasSummaryForContext(
                  content.elements as Array<Record<string, unknown>>,
                );
              }
            } catch {
              // Non-critical — agent can still call inspect_canvas manually
            }
          }

          // 附件在下载与提示词构建两处消费：收窄成局部 const（缺省空数组，分支内不再判空）
          const attachments = run.attachments ?? [];
          const hasAttachments = attachments.length > 0;
          let userMessage: HumanMessage;
          let attachmentDataMap: Record<string, string> = {};

          if (hasAttachments) {
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
            );
            enrichedPrompt = await applyPreStep(enrichedPrompt, run.threadId);

            // Build assetId → data URI map for tool-level resolution
            attachmentDataMap = buildAttachmentDataMap(downloaded);

            userMessage = new HumanMessage({
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
            );
            enrichedPrompt = await applyPreStep(enrichedPrompt, run.threadId);
            userMessage = new HumanMessage(enrichedPrompt);
          }

          rlog.lap("stream_call_start");
          stream = agent.streamEvents(
            {
              messages: [userMessage],
            },
            {
              ...(run.threadId ||
              run.canvasId ||
              run.accessToken ||
              run.userId ||
              Object.keys(attachmentDataMap).length > 0
                ? {
                    configurable: {
                      ...(run.threadId ? { thread_id: run.threadId } : {}),
                      ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                      ...(run.accessToken
                        ? { access_token: run.accessToken }
                        : {}),
                      ...(run.userId ? { user_id: run.userId } : {}),
                      ...(Object.keys(attachmentDataMap).length > 0
                        ? { user_attachment_map: attachmentDataMap }
                        : {}),
                    },
                  }
                : {}),
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

        const usageUserId = run.userId;
        // 终态事件哨兵：正常路径适配器必发 run.completed / run.canceled / run.failed；
        // billing 门中止等异常路径会让 for-await 静默结束——收尾必须补失败事件。
        let sawTerminalEvent = false;
        try {
          for await (const event of adaptDeepAgentStream({
            conversationId: run.conversationId,
            now,
            ...(options.runUsage && usageUserId
              ? {
                  onUsage: (usage: {
                    inputTokens: number;
                    outputTokens: number;
                  }) => {
                    options.runUsage?.update(runId, {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      provider: run.usageMeta?.provider ?? "builtin",
                      model: run.usageMeta?.model ?? "unknown",
                      ...(run.usageMeta?.providerInstanceId
                        ? {
                            providerInstanceId:
                              run.usageMeta.providerInstanceId,
                          }
                        : {}),
                      userId: usageUserId,
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
            run.status = mapEventToStatus(event);
            if (isTerminalEvent(event)) {
              sawTerminalEvent = true;
            }
            // billing 门中止（如图片生成的额度/tier 拒绝）会把异常误报成「用户取消」
            // ——中止信号先于错误到达适配器。有 billingFailure 在身却报取消的，
            // 一律改判 run.failed，文案给可读的 billing 原因。
            // 被拒工具触发的有界失败：abort 后适配器报「用户取消」，但这是系统
            // 主动中止——改判 run.failed 并把可读原因带给客户端（同 billing 口径）
            if (
              event.type === "run.canceled" &&
              !run.billingFailure &&
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
            if (event.type === "run.canceled" && run.billingFailure) {
              const failedEvent: StreamEvent = {
                error: {
                  code: "run_failed",
                  message: run.billingFailure.message,
                },
                runId,
                timestamp: now(),
                type: "run.failed",
              };
              run.status = "failed";
              await updatePersistedRunFailure(
                options.agentRunMetadataService,
                run,
                now,
                new Error(run.billingFailure.message),
              ).catch((persistErr) =>
                console.error(
                  "[agent-runtime] Failed to persist billing-canceled run failure:",
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

        // 流静默结束（无终态事件）：billing 门中止是已知路径（abort 后适配器不发
        // 事件）。这里补发 run.failed——持久化失败终态，并让 WS 重试判定拿到
        // 失败文案（额度不足命中永久性失败模式，不再连环重试）。
        if (!sawTerminalEvent && run.status === "running") {
          // error.code 是封闭枚举（shared/errors.ts），billing 细节留在 billing.error
          // 事件里；这里统一 run_failed，可读原因由 message 承载。
          const message =
            run.billingFailure?.message ??
            "运行被中止且未产生结束事件（无终态事件）。";
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
      } finally {
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
        if (backendResult.sandboxDir && backendResult.ephemeral) {
          rm(backendResult.sandboxDir, { recursive: true, force: true }).catch(
            (err) => console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
      }
    },
  };
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
