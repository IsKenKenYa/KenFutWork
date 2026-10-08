import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { isCommand } from "@langchain/langgraph";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { ChatOpenAI } from "@langchain/openai";
import {
  createDeepAgent,
  createFilesystemMiddleware,
  createSummarizationMiddleware,
} from "deepagents";
import {
  type AgentMiddleware,
  createAgent,
  todoListMiddleware,
} from "langchain";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_GOOGLE_AGENT_MODEL,
  type ServerEnv,
} from "../config/env.js";
import {
  createCodeFilesystemMiddleware,
  createNativeToolExclusionMiddleware,
} from "../features/code-tools/native-tool-exclusion.js";
import {
  createTaskWorkNotificationMiddleware,
  type TaskWorkBinding,
} from "../features/task-work/model-mailbox.js";
import type { ToolDefinition, ToolExecutionContext } from "../kernel/types.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { CompactionPlan, CompactionRetention } from "./auto-compact.js";
import { resolveCompactionPlan } from "./auto-compact.js";
import {
  type AgentBackendResult,
  createAgentBackend,
} from "./backends/index.js";
import type { AgentContextHistory } from "./context-history.js";
import { createExecuteBackgroundTool } from "./execute-background.js";
import { bridgeKernelTools } from "./kernel-tools-bridge.js";
import { createLlmRequestRetryMiddleware } from "./llm-retry-middleware.js";
import { attachNativeCheckpointDurability } from "./native-checkpoint-durability.js";
import { createNativeCompactionTracker } from "./native-compaction.js";
import {
  createNativeContextHistory,
  effectiveNativeMessages,
} from "./native-context-history.js";
import type {
  AgentRunExtension,
  AgentRunExtensionContext,
} from "./run-extension.js";
import {
  resolveChildToolbelt,
  resolveSubagentDefinitions,
  type SubagentDefinition,
} from "./subagent-definitions.js";
import {
  createBuiltinTaskExclusionMiddleware,
  createSubagentTaskTools,
  type SubagentChildRunner,
} from "./subagent-tools.js";
import { createTaskNotificationMiddleware } from "./task-notifications.js";

export type KenFutWorkAgent = Pick<
  ReturnType<typeof createDeepAgent>,
  "stream" | "streamEvents"
> & { canonicalToolEvents?: boolean; contextHistory?: AgentContextHistory };

/**
 * 执行模式工具门（solo/plan 硬约束）：拦截 deepagents 内置工具
 * （write_file/edit_file/execute/task 等）与桥接工具的全部调用。
 */
export type ToolGate = (
  toolName: string,
  /** 子代理派发细节（DEC-17）：plan 档按目标定义只读性放行 task/task_background。 */
  detail?: { subagentReadOnly?: boolean },
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
        status: "error",
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
  const requireResponse = (message: AIMessage) => {
    const hasContent =
      typeof message.content === "string"
        ? Boolean(message.content.trim())
        : message.content.length > 0;
    if (!hasContent && !message.tool_calls?.length)
      throw new Error("模型返回空响应，请重试或更换模型。");
    return message;
  };
  return {
    name: "kenfutwork-model-response-guard",
    wrapModelCall: async (request, handler) => {
      let result: unknown;
      try {
        result = await handler(request);
      } catch (error) {
        // 内层已抛「Invalid response from wrapModelCall」形状校验错：原始对象
        // 不可得，必须透出运行错误，不能生成一条AI答复冒充成功结束。
        const message = error instanceof Error ? error.message : String(error);
        if (/Invalid response from "wrapModelCall"/.test(message)) {
          console.warn(
            `[model-response-guard] 内层模型响应形状校验失败：${message}`,
          );
          throw new Error("模型响应格式异常，请重试或更换模型。", {
            cause: error,
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
        return AIMessage.isInstance(result)
          ? requireResponse(result)
          : (result as AIMessage);
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
      return requireResponse(
        new AIMessage({
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
        }),
      );
    },
  };
}

export type KenFutWorkAgentFactory = (options: {
  runExtensions?: readonly AgentRunExtension[];
  extensionContext?: AgentRunExtensionContext;
  backendResult?: AgentBackendResult;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  store?: BaseStore;
  /** 内核 ctx.tools 贡献的工具（按 preset 过滤后），桥接为模型可调用工具。 */
  kernelTools?: ToolDefinition[];
  /** 本次运行的工具执行上下文（runId/LocalActor）。 */
  runToolContext?: ToolExecutionContext;
  /** 执行模式工具门（solo/plan 硬约束），拦截包括内置工具在内的全部调用。 */
  toolGate?: ToolGate;
  /** 工具门旁路钩子（拒绝可见性 + 连续拒绝计数）。 */
  toolGateHooks?: ToolGateHooks;
  /**
   * 上下文自动压缩的口径（阈值/保留条数，见 agent/auto-compact.ts）。
   * 传了才挂中间件——设置里关掉时**一个字都不挂**，不是挂上再短路。
   */
  autoCompact?: CompactionPlan;
  /** 手动operation沿同一保留策略；停用auto时仍可显式维护历史。 */
  manualCompactPlan?: CompactionPlan;
  /** 原生维护适配器缺省预算仍消费本 Run 已解析的实例保留目标。 */
  compactionRetention?: CompactionRetention;
  /**
   * 装配完成时回吐工具清单（R4-1 分类占比要按 schema 量「系统工具 / MCP 工具」）。
   * 用回调而不是返回值：调用方（runtime）拿的是 agent 对象，工具清单只在装配期有。
   */
  onToolInventory?: (tools: readonly unknown[]) => void;
  /**
   * 运行 preset（DEC-2，会话级能力集）：运行态工具与子代理清单按它装配——
   * 生图生频仅 design（Code 会话无画布落点），execute_background 仅 code。
   */
  preset: "design" | "code";
  /** 本 run 的系统提示：runtime 经内核段注册表组装后传入（deep-agent 只消费）。 */
  systemPrompt: string;
  /**
   * 子代理派发缝（DEC-14/15/16）：注册表由 runtime 按 run 创建（并发上限来自治理设置）。
   * 传入即挂 task / task_background / task_output 三工具与后台通知中间件；
   * 缺席（部分装配/测试）则完全不出现派发能力。
   */
  backgroundTasks?: {
    registry: import("./background-tasks.js").BackgroundTaskRegistry;
  };
  taskWork?: TaskWorkBinding;
  /** Code 长命令超时（毫秒，DEC-18）：治理设置值；缺省走 governance 默认。 */
  executeTimeoutMs?: number;
  /** LLM 请求级重试（DEC-18）：治理设置值；缺省走 governance 默认（不无限）。 */
  llmRetry?: { maxAttempts: number; infinite: boolean };
}) => KenFutWorkAgent;

export function createKenFutWorkDeepAgent(options: {
  runExtensions?: readonly AgentRunExtension[];
  extensionContext?: AgentRunExtensionContext;
  backendResult?: AgentBackendResult;
  canvasId?: string;
  checkpointer?: BaseCheckpointSaver;
  connectionManager?: ConnectionManager;
  env: ServerEnv;
  model?: BaseLanguageModel | string;
  store?: BaseStore;
  kernelTools?: ToolDefinition[];
  runToolContext?: ToolExecutionContext;
  /** 执行模式工具门（solo/plan 硬约束），拦截包括内置工具在内的全部调用。 */
  toolGate?: ToolGate;
  /** 工具门旁路钩子（拒绝可见性 + 连续拒绝计数）。 */
  toolGateHooks?: ToolGateHooks;
  /** 上下文自动压缩的口径（见 agent/auto-compact.ts）。 */
  autoCompact?: CompactionPlan;
  /** 手动operation沿同一保留策略；停用auto时仍可显式维护历史。 */
  manualCompactPlan?: CompactionPlan;
  compactionRetention?: CompactionRetention;
  /**
   * 装配完成时回吐工具清单（R4-1 分类占比要按 schema 量「系统工具 / MCP 工具」）。
   * 用回调而不是返回值：调用方（runtime）拿到的是 agent 对象，工具清单只在装配期有。
   */
  onToolInventory?: (tools: readonly unknown[]) => void;
  /** 子代理派发缝（DEC-14/15/16），同 {@link KenFutWorkAgentFactory.backgroundTasks}。 */
  backgroundTasks?: {
    registry: import("./background-tasks.js").BackgroundTaskRegistry;
  };
  taskWork?: TaskWorkBinding;
  /** Code 长命令超时（毫秒，DEC-18）。 */
  executeTimeoutMs?: number;
  /** LLM 请求级重试（DEC-18）。 */
  llmRetry?: { maxAttempts: number; infinite: boolean };
  /** 运行 preset（DEC-2），同 {@link KenFutWorkAgentFactory.preset}。 */
  preset: "design" | "code";
  /** 本 run 的系统提示：runtime 经内核段注册表组装后传入（deep-agent 只消费）。 */
  systemPrompt: string;
}): KenFutWorkAgent {
  const backendResult =
    options.backendResult ?? createAgentBackend(options.env, options.canvasId);

  // 运行 preset（DEC-2）：本次装配的能力集口径——运行态工具、子代理清单共用
  const preset = options.preset;
  // 权威生命周期包住工具目录/权限的提前返回，拒绝也必须进入原产品事件链。
  const runExtensions = [...(options.runExtensions ?? [])].sort(
    (left, right) =>
      Number(Boolean(right.canonicalToolEvents)) -
      Number(Boolean(left.canonicalToolEvents)),
  );

  applyOpenAICompatEnv(options.env);

  const modelSpec = options.model ?? createDefaultModelSpecifier(options.env);
  const resolvedModel =
    typeof modelSpec === "string"
      ? createStreamingChatModel(modelSpec)
      : modelSpec;

  // 系统提示由调用方（runtime）经内核段注册表组装后传入——deep-agent 只消费，
  // 不再自带组装逻辑（提示段属主是各 feature 插件，挂载即出现）。
  const systemPrompt = options.systemPrompt;

  // 工具清单先落地成变量：R4-1 的分类占比要按 schema 量「系统工具 / MCP 工具」，
  // 而调用方（runtime）拿到的是 agent 对象，只有这里才知道装配了什么工具。
  // 全部工具经内核注册表（runtime 已按 preset 解析静态+动态后经 kernelTools 传入）。
  const tools = [
    ...bridgeKernelTools(
      options.kernelTools ?? [],
      options.runToolContext ?? {},
    ),
  ];

  /**
   * 子代理派发缝（DEC-14/15/16）：后台任务注册表在传入时挂三件套——
   * task（前台并行）、task_background（后台 + 通知）、task_output（结果查询）。
   * 子代理按定义经 createAgent 组装：模型同父、工具按定义白名单拾取、
   * 只读定义挂文件工具白名单中间件（结构性无 execute）；子代理不挂任何
   * 派发工具——深度上限 1 是结构性的（DEC-17）。
   */
  let subagentMiddleware: AgentMiddleware[] = [];
  if (options.backgroundTasks) {
    const { registry } = options.backgroundTasks;
    const toolGateForDispatch = options.toolGate;
    const childRunner: SubagentChildRunner = async ({
      definition,
      description,
      signal,
      callId,
      parentCallbacks,
    }) => {
      const { tools: picked } = resolveChildToolbelt(definition, tools);
      const middleware: AgentMiddleware[] = definition.filesystemTools?.length
        ? [
            createFilesystemMiddleware({
              backend: backendResult.factory,
              // 允许清单即白名单：read_file 必带；execute 不在列表 = 只读子代理无执行能力
              tools: [...definition.filesystemTools],
            }) as unknown as AgentMiddleware,
          ]
        : [];
      middleware.unshift(
        ...runExtensions.map((extension) =>
          extension.createMiddleware({
            agentCallId: callId,
            agentName: definition.name,
          }),
        ),
      );
      const child = createAgent({
        model: resolvedModel,
        name: definition.name,
        // 语言规则单点追加（子代理结论回填主对话，英文结论会带偏主对话语言）：
        // 定义里的 systemPrompt 是中文，但其工具面（deepagents 文件工具等）描述是英文
        systemPrompt:
          definition.systemPrompt +
          "\n\n始终用中文思考、工作与汇报（用户消息为其他语言时跟随用户语言）；" +
          "代码、命令、路径、专有名词保留原文。",
        tools: picked,
        middleware,
      });
      const result = (await child.invoke(
        { messages: [new HumanMessage(description)] },
        {
          signal,
          // 事件归因与路由（DEC-19）：name 供识别、call_id 供前端路由进对应子代理视图
          metadata: {
            lc_agent_name: definition.name,
            lc_agent_call_id: callId,
          },
          configurable: { ls_agent_type: "subagent" },
          // 继承父 run 的 callbacks：子代理内部事件（模型流/工具行）冒泡进父流，
          // stream-adapter 按 metadata 归因路由进右栏子代理线程；不带 = 静默执行
          ...(parentCallbacks
            ? { callbacks: parentCallbacks as Callbacks }
            : {}),
        },
      )) as { messages?: Array<{ content: unknown; getType?: () => string }> };
      const messages = result?.messages ?? [];
      const lastAi = [...messages]
        .reverse()
        .find((message) => message.getType?.() === "ai");
      const content = lastAi?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (part): part is { text: string } =>
                    typeof part === "object" &&
                    part !== null &&
                    typeof (part as { text?: unknown }).text === "string",
                )
                .map((part) => part.text)
                .join("\n")
            : "";
      if (!text.trim()) {
        throw new Error("子代理结束但没有产出任何结论");
      }
      return text;
    };

    const dispatchTools = createSubagentTaskTools({
      registry,
      definitions: resolveSubagentDefinitions(preset),
      childRunner,
      // plan 档派发门（DEC-17）：按目标定义只读性判定——复用同一把工具门，
      // solo/plan 的拒绝理由与普通工具一致
      ...(toolGateForDispatch
        ? {
            dispatchGate: (def: SubagentDefinition) =>
              toolGateForDispatch("task", { subagentReadOnly: def.readOnly }),
          }
        : {}),
    });
    tools.push(
      dispatchTools.taskTool as never,
      dispatchTools.taskBackgroundTool as never,
      dispatchTools.taskOutputTool as never,
    );
    subagentMiddleware = [
      createTaskNotificationMiddleware(registry) as unknown as AgentMiddleware,
      // deepagents 无条件内建 `task` 工具（无关闭开关）：从模型工具清单整体排除——
      // 派发只走受治理的 subagent_task/subagent_background（DEC-16/17）
      createBuiltinTaskExclusionMiddleware(),
    ];

    // Code 长命令（DEC-15）：与子代理共用注册表与通知通道；execute 能力探测失败
    // （非 shell 后端）则不挂，不给模型一个必然失败的工具
    if (preset === "code") {
      const backendInstance = backendResult.factory({
        store: options.store,
        state: {},
      } as never) as unknown as {
        execute?: (command: string) => Promise<{
          output: string;
          exitCode: number | null;
          truncated: boolean;
        }>;
      };
      if (typeof backendInstance?.execute === "function") {
        tools.push(
          createExecuteBackgroundTool({
            registry,
            backend: backendInstance as {
              execute: (command: string) => Promise<{
                output: string;
                exitCode: number | null;
                truncated: boolean;
              }>;
            },
            timeoutMs:
              options.executeTimeoutMs ??
              AGENT_GOVERNANCE_DEFAULTS.executeTimeoutMs,
          }) as never,
        );
      }
    }
  }

  options.onToolInventory?.(tools);

  /**
   * 上下文自动压缩（R4-1 输出预留线的执行面）：只在设置开着、且算得出触发线时挂。
   *
   * - **摘要模型**：不传 `model` → 中间件用本轮 run 的模型（BYOK 就是用户那把 Key，
   *   不引入第二个模型配置）；
   * - **历史对齐**：被压掉的消息 offload 到工作区 `/conversation_history/`，模型上下文里
   *   换成一条摘要（`lc_source="summarization"`）。库里的转录不动——界面上用一条提示说明
   *   （见 stream-adapter 的 `run.compacted`）；
   * - **backend**：与 agent 同一个后端工厂（offload 落到用户自己的工作目录，可追溯）。
   */
  const nativeSummarization = createSummarizationMiddleware({
    backend: backendResult.factory,
    ...(options.autoCompact
      ? { trigger: options.autoCompact.trigger, keep: options.autoCompact.keep }
      : {}),
  }) as unknown as AgentMiddleware;
  const compactionTracker = options.autoCompact
    ? createNativeCompactionTracker(nativeSummarization)
    : undefined;
  // 同名覆盖DA默认auto行为，仍保留summary state schema供显式维护operation。
  const summaryExecution: AgentMiddleware = compactionTracker?.middleware ?? {
    ...nativeSummarization,
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        messages: effectiveNativeMessages(request.messages, request.state),
      }),
  };
  const summaryCall = summaryExecution.wrapModelCall;
  if (!summaryCall) throw new Error("摘要模型请求入口未装配。");
  const summarizationMiddleware: AgentMiddleware[] = [
    {
      ...summaryExecution,
      async wrapModelCall(request, handler) {
        // SDK默认摘要位于普通扩展之前；这里统一采用已消费输入的冻结模型。
        const model =
          await options.extensionContext?.modelControl?.resolveCurrent();
        return summaryCall(
          { ...request, ...(model ? { model } : {}) },
          handler,
        );
      },
    },
  ];

  // 后台任务通知（DEC-15）：每次模型调用前注入已结算未消费的通知
  const notificationMiddleware: AgentMiddleware[] = [
    ...(options.backgroundTasks ? subagentMiddleware : []),
    ...(options.taskWork
      ? [createTaskWorkNotificationMiddleware(options.taskWork)]
      : []),
    ...(preset === "code"
      ? [
          createCodeFilesystemMiddleware(backendResult.factory),
          createNativeToolExclusionMiddleware(),
        ]
      : []),
  ];

  // LLM 请求级重试（DEC-18）：maxAttempts 含首次；infinite 为用户显式开启。
  // 默认档（10 次/不无限）也挂——治上游抖动是基线行为，不是可选项。
  const llmRetryMiddleware = createLlmRequestRetryMiddleware({
    maxAttempts:
      options.llmRetry?.maxAttempts ??
      AGENT_GOVERNANCE_DEFAULTS.llmRequestMaxRetries,
    infinite:
      options.llmRetry?.infinite ?? AGENT_GOVERNANCE_DEFAULTS.llmInfiniteRetry,
  });

  const agent = createDeepAgent({
    backend: backendResult.factory,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    model: resolvedModel,
    name: "kenfutwork",
    ...(options.store ? { store: options.store } : {}),
    // 子代理派发改走自有 task/task_background 工具（DEC-14/15，见 backgroundTasks）：
    // 不再传 deepagents 的 `subagents:` —— 内置 task 的 2 字段 schema、同步阻塞与
    // 固定装配满足不了后台化与目录治理，自建缝声明/装配/消费三元组齐备。
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
            ...runExtensions.map((extension) =>
              extension.createMiddleware({}, options.extensionContext),
            ),
            ...summarizationMiddleware,
            ...notificationMiddleware,
            llmRetryMiddleware,
            todoListMiddleware() as unknown as AgentMiddleware,
            createToolErrorGuardMiddleware(),
            createModelResponseGuardMiddleware(),
            createUnknownToolGuardMiddleware(),
            createToolGateMiddleware(options.toolGate, options.toolGateHooks),
          ],
        }
      : {
          middleware: [
            ...runExtensions.map((extension) =>
              extension.createMiddleware({}, options.extensionContext),
            ),
            ...summarizationMiddleware,
            ...notificationMiddleware,
            llmRetryMiddleware,
            todoListMiddleware() as unknown as AgentMiddleware,
            createToolErrorGuardMiddleware(),
            createModelResponseGuardMiddleware(),
            createUnknownToolGuardMiddleware(),
          ],
        }),
    tools,
  });
  if (options.checkpointer) attachNativeCheckpointDurability(agent);
  if (compactionTracker && options.checkpointer)
    compactionTracker.attach(agent);
  return Object.assign(agent, {
    ...(options.checkpointer
      ? {
          contextHistory: createNativeContextHistory(agent, {
            model: resolvedModel,
            backend: backendResult.factory,
            ...(options.store ? { store: options.store } : {}),
            plan:
              options.manualCompactPlan ??
              options.autoCompact ??
              resolveCompactionPlan({
                ...(options.compactionRetention
                  ? { retention: options.compactionRetention }
                  : {}),
              }),
            llmRetry: options.llmRetry ?? {
              maxAttempts: AGENT_GOVERNANCE_DEFAULTS.llmRequestMaxRetries,
              infinite: AGENT_GOVERNANCE_DEFAULTS.llmInfiniteRetry,
            },
          }),
        }
      : {}),
    canonicalToolEvents: runExtensions.some(
      (extension) => extension.canonicalToolEvents,
    ),
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

  const googleApiKey = process.env.GOOGLE_API_KEY;
  const vertexProject = process.env.GOOGLE_VERTEX_PROJECT;
  const vertexLocation = process.env.GOOGLE_VERTEX_LOCATION;
  const hasGoogleApiKey = !!googleApiKey;
  const hasVertexAI = !!(vertexProject && vertexLocation);
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
      if (vertexProject && vertexLocation) {
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
      if (!googleApiKey) {
        // 上方可用性回退已排除「两套 Google 配置都缺失」；走到这里说明配置不全，fail loud
        throw new Error(
          "[model] Google 供应商缺少 GOOGLE_API_KEY，且 Vertex AI 的 project/location 不全。",
        );
      }
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: googleApiKey,
        streaming: true,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1, // dynamic — let the model decide
        },
      });
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
