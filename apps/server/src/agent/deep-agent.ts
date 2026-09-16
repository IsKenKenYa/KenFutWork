import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { isCommand } from "@langchain/langgraph";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { type AgentMiddleware, todoListMiddleware } from "langchain";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_GOOGLE_AGENT_MODEL,
  type ServerEnv,
} from "../config/env.js";
import type { BlobStore } from "../features/blob/types.js";
import type { BrandKitService } from "../features/brand-kit/brand-kit-service.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import type { ToolDefinition, ToolExecutionContext } from "../kernel/types.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import {
  type AgentBackendResult,
  createAgentBackend,
} from "./backends/index.js";
import { bridgeKernelTools } from "./kernel-tools-bridge.js";
import { KENFUTWORK_SYSTEM_PROMPT } from "./prompts/kenfutwork-main.js";
import { createVideoSubAgent } from "./sub-agents.js";
import type {
  PersistImageFn,
  SubmitImageJobFn,
} from "./tools/image-generate.js";
import { createMainAgentTools } from "./tools/index.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";

export type KenFutWorkAgent = Pick<
  ReturnType<typeof createDeepAgent>,
  "stream" | "streamEvents"
>;

/**
 * 执行模式工具门（solo/plan 硬约束）：拦截 deepagents 内置工具
 * （write_file/edit_file/execute/task 等）与桥接工具的全部调用。
 */
export type ToolGate = (
  toolName: string,
) => { allowed: true } | { allowed: false; reason: string };

/**
 * 工具门的旁路钩子：运行时接上它，就能把「被拒的调用」合成成 tool.* 事件下发给
 * 客户端（此前门一拦，客户端什么都看不到），并据连续拒绝次数做有界失败。
 */
export interface ToolGateHooks {
  onDenied(entry: {
    toolCallId: string;
    toolName: string;
    reason: string;
    input?: Record<string, unknown> | undefined;
  }): void;
  onAllowed?(toolName: string): void;
}

/** 按工具门构造 wrapToolCall 中间件：拒绝即以 ToolMessage 回给模型，不执行。 */
export function createToolGateMiddleware(
  gate: ToolGate,
  hooks?: ToolGateHooks,
): AgentMiddleware {
  return {
    name: "kenfutwork-tool-gate",
    wrapToolCall: async (request, handler) => {
      const verdict = gate(request.toolCall.name);
      if (verdict.allowed) {
        hooks?.onAllowed?.(request.toolCall.name);
        return handler(request);
      }
      hooks?.onDenied({
        toolCallId: request.toolCall.id ?? request.toolCall.name,
        toolName: request.toolCall.name,
        reason: verdict.reason,
        ...(request.toolCall.args && typeof request.toolCall.args === "object"
          ? { input: request.toolCall.args as Record<string, unknown> }
          : {}),
      });
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? request.toolCall.name,
        content: `工具 ${request.toolCall.name} 被拒绝：${verdict.reason}`,
      });
    },
  };
}

/**
 * 未知工具兜底：模型依线程历史复述已停用/卸载插件的工具名时（工具不在当前
 * 注册表，`request.tool` 为空），以工具级结果回复而非让整轮 run 失败。
 */
function createUnknownToolGuardMiddleware(): AgentMiddleware {
  return {
    name: "kenfutwork-unknown-tool-guard",
    wrapToolCall: async (request, handler) => {
      if (request.tool) {
        return handler(request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? request.toolCall.name,
        content: `工具 ${request.toolCall.name} 当前不可用（可能已被停用或卸载）。请改用其它方式完成，或请用户重新启用相关插件。`,
      });
    },
  };
}

/**
 * 工具执行失败兜底：**工具失败是工具级结果，不是运行级失败**。
 *
 * 实测（2026-09-16 全流程走查）：联网搜索上游偶发失败（本地代理回 errCode 5002
 * 「结果与查询没有词面重合」）时，异常从工具节点抛出 → 整轮 run 以 run.failed 收场。
 * 用户看到的是「跑一半突然失败」：模型既没机会换个关键词重搜，也没机会继续做
 * 后面的步骤。工具门拒绝早就按工具级结果处理（见上），执行失败同理——回一条带原因的
 * ToolMessage，让模型自己降级或改道。
 *
 * 连续失败会累计：同一个工具连续失败达上限后，回的消息明确要求停止重试并说明情况
 * （防止模型对着失败工具空转刷调用）。
 */
export function createToolErrorGuardMiddleware(
  options: { maxConsecutiveFailures?: number } = {},
): AgentMiddleware {
  const limit = options.maxConsecutiveFailures ?? 3;
  const failures = new Map<string, number>();
  return {
    name: "kenfutwork-tool-error-guard",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name;
      try {
        const result = await handler(request);
        failures.delete(toolName);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const count = (failures.get(toolName) ?? 0) + 1;
        failures.set(toolName, count);
        console.warn(
          `[agent] 工具执行失败降级为工具级结果：${toolName}（第 ${count} 次）：${reason}`,
        );
        const advice =
          count >= limit
            ? `该工具已连续失败 ${count} 次，**不要再重试它**：改用其它工具或直接说明限制后收尾。`
            : "这是工具级失败（不影响本轮其它步骤）：可换关键词/换方案重试，但不要重复同样的调用。";
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? toolName,
          content: `工具 ${toolName} 执行失败：${reason}
${advice}`,
          status: "error",
        });
      }
    },
  };
}

/**
 * 模型响应守卫：LangChain 对每层 wrapModelCall 的返回做形状校验
 * （AIMessage / Command / {structuredResponse, messages}），不合规即抛
 * `Invalid response from "wrapModelCall" …` 并**整轮 run 失败**。
 *
 * 实测（one-api 代理 + glm，工具执行后的下一轮模型调用偶发）：内层
 * handler 会返回未规整的裸对象——此前没有任何我方帧能介入。本守卫挂在
 * 最外层，把非法形状**规整为 AIMessage**（保住 content / tool_calls /
 * additional_kwargs），规整不了才放行让其按原错误暴露。日志记录原始形状
 * 便于追根（lc 序列化对象 / 供应商原始响应等）。
 */
function createModelResponseGuardMiddleware(): AgentMiddleware {
  return {
    name: "kenfutwork-model-response-guard",
    wrapModelCall: async (request, handler) => {
      let result: unknown;
      try {
        result = await handler(request);
      } catch (error) {
        // 内层已抛「Invalid response from wrapModelCall」形状校验错：原始对象
        // 不可得，但整轮 run 不必陪葬——以降级消息收尾，错误细节进日志。
        const message = error instanceof Error ? error.message : String(error);
        if (/Invalid response from "wrapModelCall"/.test(message)) {
          console.warn(
            `[model-response-guard] 内层模型响应形状校验失败（降级收尾）：${message}`,
          );
          return new AIMessage({
            content: "（本轮模型响应异常，系统已降级收尾；请重试或换模型。）",
          });
        }
        throw error;
      }
      const valid =
        AIMessage.isInstance(result) ||
        isCommand(result) ||
        (typeof result === "object" &&
          result !== null &&
          "structuredResponse" in result &&
          "messages" in result);
      if (valid) {
        return result as AIMessage;
      }
      const shape =
        result instanceof Error
          ? `Error: ${result.message}`
          : result === null || result === undefined
            ? String(result)
            : `${Object.prototype.toString.call(result)} keys=${Object.keys(
                result,
              )
                .slice(0, 20)
                .join(",")}`;
      console.warn(
        `[model-response-guard] 模型返回未规整形状（已尝试收敛为 AIMessage）：${shape}`,
      );
      if (typeof result !== "object" || result === null) {
        return result as AIMessage;
      }
      // lc 序列化对象或裸响应：收敛字段，缺的给空默认（content 空 + 无工具调用）
      const raw = result as Record<string, unknown>;
      const toolCalls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls
        : undefined;
      return new AIMessage({
        content:
          typeof raw.content === "string"
            ? raw.content
            : Array.isArray(raw.content)
              ? raw.content
              : "",
        ...(toolCalls ? { tool_calls: toolCalls as never } : {}),
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.additional_kwargs && typeof raw.additional_kwargs === "object"
          ? {
              additional_kwargs: raw.additional_kwargs as Record<
                string,
                unknown
              >,
            }
          : {}),
      });
    },
  };
}

export type KenFutWorkAgentFactory = (options: {
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
  /** 内核 ctx.tools 贡献的工具（按 preset 过滤后），桥接为模型可调用工具。 */
  kernelTools?: ToolDefinition[];
  /** 本次运行的工具执行上下文（runId/accessToken）。 */
  runToolContext?: ToolExecutionContext;
  /** 执行模式工具门（solo/plan 硬约束），拦截包括内置工具在内的全部调用。 */
  toolGate?: ToolGate;
  /** 工具门旁路钩子（拒绝可见性 + 连续拒绝计数）。 */
  toolGateHooks?: ToolGateHooks;
  /** 插件贡献的提示段（能力 `systemPrompt`）：追加在系统提示之后。 */
  systemPromptExtras?: readonly string[];
  /**
   * 装配完成时回吐工具清单（R4-1 分类占比要按 schema 量「系统工具 / MCP 工具」）。
   * 用回调而不是返回值：调用方（runtime）拿的是 agent 对象，工具清单只在装配期有。
   */
  onToolInventory?: (tools: readonly unknown[]) => void;
}) => KenFutWorkAgent;

export function createKenFutWorkDeepAgent(options: {
  backendResult?: AgentBackendResult;
  brandKitId?: string | null;
  /** 品牌套件服务（工具 get_brand_kit 经它取数，不再直连 SDK）。 */
  brandKitService?: BrandKitService;
  /** 对象存储（blob 缝）：沙箱文件持久化、生成物落盘经它（必需能力）。 */
  blob: BlobStore;
  /** 画布数据访问（工作区作用域）：工具的画布读写经它。 */
  canvasRepository?: CanvasRepository;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  persistImage?: PersistImageFn;

  submitImageJob?: SubmitImageJobFn;
  submitVideoJob?: SubmitVideoJobFn;
  store?: BaseStore;
  workspaceSkills?: WorkspaceSkillEntry[];
  kernelTools?: ToolDefinition[];
  runToolContext?: ToolExecutionContext;
  /** 执行模式工具门（solo/plan 硬约束），拦截包括内置工具在内的全部调用。 */
  toolGate?: ToolGate;
  /** 工具门旁路钩子（拒绝可见性 + 连续拒绝计数）。 */
  toolGateHooks?: ToolGateHooks;
  /** 插件贡献的提示段（能力 `systemPrompt`）：追加在系统提示之后。 */
  systemPromptExtras?: readonly string[];
  /**
   * 装配完成时回吐工具清单（R4-1 分类占比要按 schema 量「系统工具 / MCP 工具」）。
   * 用回调而不是返回值：调用方（runtime）拿到的是 agent 对象，工具清单只在装配期有。
   */
  onToolInventory?: (tools: readonly unknown[]) => void;
}): KenFutWorkAgent {
  const backendResult =
    options.backendResult ?? createAgentBackend(options.env, options.canvasId);

  applyOpenAICompatEnv(options.env);

  const modelSpec = options.model ?? createDefaultModelSpecifier(options.env);
  const resolvedModel =
    typeof modelSpec === "string"
      ? createStreamingChatModel(modelSpec)
      : modelSpec;

  let systemPrompt = options.brandKitId
    ? KENFUTWORK_SYSTEM_PROMPT +
      "\n\n当前项目已绑定品牌套件。在进行设计相关工作时，请先使用 get_brand_kit 工具查询品牌信息，确保设计符合品牌规范。"
    : KENFUTWORK_SYSTEM_PROMPT;

  // Inject enabled skills (both system and user-created) into the system prompt.
  // All skills are loaded from the database via loadWorkspaceSkills() in runtime.ts.
  const wsSkills = options.workspaceSkills ?? [];
  if (wsSkills.length > 0) {
    const skillsList = wsSkills
      .map((s) => {
        let line = `- **${s.name}**: ${s.description}\n  → Read \`${s.path}\` for full instructions`;
        if (s.files.length > 0) {
          const counts: Record<string, number> = {};
          for (const f of s.files) {
            const dir = f.path.split("/")[0] ?? "other";
            counts[dir] = (counts[dir] ?? 0) + 1;
          }
          const summary = Object.entries(counts)
            .map(([dir, n]) => `${dir}/ (${n})`)
            .join(", ");
          line += `\n  → Has: ${summary}`;
        }
        return line;
      })
      .join("\n");
    systemPrompt += `\n\n## Skills\n\nThe following skills are enabled in this workspace:\n${skillsList}`;
  }

  // 插件提示段（能力 systemPrompt）：接在品牌/技能之后——插件是外部贡献，
  // 不该覆盖内置规则，只追加行为引导。
  const extras = (options.systemPromptExtras ?? []).filter(
    (section) => section.trim().length > 0,
  );
  if (extras.length > 0) {
    systemPrompt += `\n\n## 插件提示段\n\n${extras.join("\n\n")}`;
  }

  // 工具清单先落地成变量：R4-1 的分类占比要按 schema 量「系统工具 / MCP 工具」，
  // 而调用方（runtime）拿到的是 agent 对象，只有这里才知道装配了什么工具。
  const tools = [
    ...createMainAgentTools(backendResult.factory, {
      ...(options.brandKitService
        ? { brandKitService: options.brandKitService }
        : {}),
      blob: options.blob,
      ...(options.canvasRepository
        ? { canvasRepository: options.canvasRepository }
        : {}),
      ...(options.brandKitId != null ? { brandKitId: options.brandKitId } : {}),
      ...(options.connectionManager
        ? { connectionManager: options.connectionManager }
        : {}),
      ...(options.persistImage ? { persistImage: options.persistImage } : {}),
      ...(backendResult.sandboxDir
        ? { sandboxDir: backendResult.sandboxDir }
        : {}),

      ...(options.submitImageJob
        ? { submitImageJob: options.submitImageJob }
        : {}),
      ...(options.submitVideoJob
        ? { submitVideoJob: options.submitVideoJob }
        : {}),
    }),
    ...bridgeKernelTools(options.kernelTools ?? [], options.runToolContext ?? {}),
  ];

  options.onToolInventory?.(tools);

  return createDeepAgent({
    backend: backendResult.factory,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    model: resolvedModel,
    name: "kenfutwork",
    ...(options.store ? { store: options.store } : {}),
    subagents: [createVideoSubAgent()],
    systemPrompt,
    // 待办表（`write_todos`）：deepagents 只在它的 Codex profile 里挂 todoListMiddleware，
    // 非 Codex 模型默认**没有这个工具**——不挂的话「目标 + 进度」面板永远没有数据源，
    // 执行模式的 plan 只读白名单里的 write_todos 也形同虚设。这里显式挂上：
    // 工具是整表替换语义（langchain todoListMiddleware），前端据工具事件推导进度。
    // 该中间件自带 state 泛型（todos 通道），与 deepagents 的宽松 middleware 签名不同型，
    // 按 deepagents 内部同样的做法擦除一次类型。
    // 未知工具兜底恒挂；模型响应守卫挂最外层（收敛非法形状）；执行模式工具门在
    // 标准中间件之后应用，覆盖全部工具调用
    ...(options.toolGate
      ? {
          middleware: [
            todoListMiddleware() as unknown as AgentMiddleware,
            createToolErrorGuardMiddleware(),
            createModelResponseGuardMiddleware(),
            createUnknownToolGuardMiddleware(),
            createToolGateMiddleware(options.toolGate, options.toolGateHooks),
          ],
        }
      : {
          middleware: [
            todoListMiddleware() as unknown as AgentMiddleware,
            createToolErrorGuardMiddleware(),
            createModelResponseGuardMiddleware(),
            createUnknownToolGuardMiddleware(),
          ],
        }),
    tools,
  });
}

/**
 * Create a streaming chat model from a `<provider>:<model-id>` specifier.
 *
 * Supported providers:
 * - `openai` (default) — uses ChatOpenAI with `streamUsage: false` to work
 *   around the one-api proxy stripping `delta.role` from chunks.
 * - `google` — uses ChatGoogleGenerativeAI (Google AI Studio, API Key) or
 *   ChatVertexAI (Vertex AI, service account) depending on available config.
 */
function createStreamingChatModel(specifier: string): BaseLanguageModel {
  const colonIdx = specifier.indexOf(":");
  let provider = colonIdx > 0 ? specifier.slice(0, colonIdx) : "openai";
  let modelName = colonIdx > 0 ? specifier.slice(colonIdx + 1) : specifier;

  const hasGoogleApiKey = !!process.env.GOOGLE_API_KEY;
  const hasVertexAI = !!(
    process.env.GOOGLE_VERTEX_PROJECT && process.env.GOOGLE_VERTEX_LOCATION
  );
  const hasGoogle = hasGoogleApiKey || hasVertexAI;

  // Provider availability fallback
  if (provider === "google" && !hasGoogle) {
    console.warn(
      `[model] Google unavailable (no GOOGLE_API_KEY or Vertex AI config), falling back to OpenAI for: ${specifier}`,
    );
    provider = "openai";
    modelName = DEFAULT_AGENT_MODEL;
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY && hasGoogle) {
    console.warn(
      `[model] OpenAI unavailable (no OPENAI_API_KEY), falling back to Google for: ${specifier}`,
    );
    provider = "google";
    modelName = DEFAULT_GOOGLE_AGENT_MODEL;
  }

  switch (provider) {
    case "google":
      // Prefer Vertex AI (service account) when configured; fall back to Developer API key
      if (hasVertexAI) {
        const vertexProject = process.env.GOOGLE_VERTEX_PROJECT!;
        const vertexLocation = process.env.GOOGLE_VERTEX_LOCATION!;
        console.log(
          `[model] Using Vertex AI for: ${modelName} (project=${vertexProject}, location=${vertexLocation})`,
        );
        return new ChatVertexAI({
          model: modelName,
          location: vertexLocation,
          authOptions: { projectId: vertexProject },
          streaming: true,
        });
      }
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: process.env.GOOGLE_API_KEY!,
        streaming: true,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1, // dynamic — let the model decide
        },
      });
    case "openai":
    default:
      return new ChatOpenAI({
        model: modelName,
        streaming: true,
        streamUsage: false,
      });
  }
}

/** Known model-name prefixes that map to Google Gemini. */
const GOOGLE_MODEL_PREFIXES = ["gemini-"];

export function createDefaultModelSpecifier(
  env: Pick<ServerEnv, "agentModel">,
) {
  const model = env.agentModel;
  // Already has an explicit provider prefix — pass through as-is.
  if (model.includes(":")) return model;
  // Auto-detect Google models by name prefix.
  if (GOOGLE_MODEL_PREFIXES.some((p) => model.startsWith(p)))
    return `google:${model}`;
  return `openai:${model}`;
}

export function applyOpenAICompatEnv(
  env: Pick<ServerEnv, "openAIApiBase" | "openAIApiKey">,
  target: NodeJS.ProcessEnv = process.env,
) {
  if (env.openAIApiKey) {
    target.OPENAI_API_KEY = env.openAIApiKey;
  }

  if (env.openAIApiBase) {
    target.OPENAI_BASE_URL = env.openAIApiBase;
  }
}
