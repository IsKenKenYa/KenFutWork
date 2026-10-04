import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerEnv } from "../config/env.js";
import type { PermissionInvocation } from "../features/permissions/approval-types.js";
import type { PermissionService } from "../features/permissions/permission-service.js";
import { publicToolArguments } from "./tool-arguments.js";
import type {
  AgentRunEvent,
  AgentRunEventPayloads,
  CapabilityRegistration,
  CapabilityRegistry,
  DepsOf,
  DynamicToolEntry,
  KernelEvents,
  ListenerOf,
  PluginContext,
  PromptCompositionContext,
  PromptSectionDefinition,
  RunToolResolutionContext,
  SerialListener,
  ServiceKey,
  ServiceMap,
  SystemPromptRegistry,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
  ToolScope,
  TurnStoppingPayload,
  WaterfallListener,
} from "./types.js";

type RegisterFn = <K extends ServiceKey>(
  key: K,
  factory: (deps: DepsOf<K>) => ServiceMap[K],
) => void;

type GetFn = <K extends ServiceKey>(key: K) => ServiceMap[K];

export class ToolDeniedError extends Error {
  constructor(toolName: string, reason: string | undefined) {
    super(
      `工具 ${toolName} 被 tool-pre-execute 拦截拒绝${reason ? `：${reason}` : ""}`,
    );
    this.name = "ToolDeniedError";
  }
}

/**
 * agent-run 事件缝派发器（DEC-1，只有 3 个事件）。
 * waterfall：监听器按注册顺序包链，必须调 next() 委托，不调即拦截；
 * serial：监听器按注册顺序串行，next() 进入下一个。
 */
export class AgentRunEventBus {
  private readonly listeners = new Map<
    AgentRunEvent,
    Array<
      (
        payload: never,
        next: never,
      ) => Promise<AgentRunEventPayloads[AgentRunEvent]> | Promise<void>
    >
  >();

  on<E extends AgentRunEvent>(event: E, listener: ListenerOf<E>): () => void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener as never);
    this.listeners.set(event, bucket);
    return () => {
      const current = this.listeners.get(event);
      if (!current) {
        return;
      }
      const index = current.indexOf(listener as never);
      if (index >= 0) {
        current.splice(index, 1);
      }
    };
  }

  emitWaterfall<E extends Exclude<AgentRunEvent, "turn-stopping">>(
    event: E,
    payload: AgentRunEventPayloads[E],
  ): Promise<AgentRunEventPayloads[E]> {
    const chain = (this.listeners.get(event) ?? []) as unknown as Array<
      WaterfallListener<E>
    >;
    const dispatch = (
      index: number,
      current: AgentRunEventPayloads[E],
    ): Promise<AgentRunEventPayloads[E]> => {
      const listener = chain[index];
      if (!listener) {
        return Promise.resolve(current);
      }
      return listener(current, (next) => dispatch(index + 1, next));
    };
    return dispatch(0, payload);
  }

  emitSerial(
    event: "turn-stopping",
    payload: TurnStoppingPayload,
  ): Promise<void> {
    const chain = (this.listeners.get(event) ?? []) as unknown as Array<
      SerialListener<"turn-stopping">
    >;
    const dispatch = (index: number): Promise<void> => {
      const listener = chain[index];
      if (!listener) {
        return Promise.resolve();
      }
      return listener(payload, () => dispatch(index + 1));
    };
    return dispatch(0);
  }
}

/** 统一工具注册表：schema + scope + guarded 执行（先过 tool-pre-execute 事件）。 */
export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly dynamicEntries = new Map<string, DynamicToolEntry>();

  constructor(
    private readonly events: AgentRunEventBus,
    private readonly permissions?: () => PermissionService | undefined,
  ) {}

  register(tool: ToolDefinition): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[kernel] 工具 ${tool.name} 重复注册。`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      this.tools.delete(tool.name);
    };
  }

  registerDynamic(entry: DynamicToolEntry): () => void {
    if (this.dynamicEntries.has(entry.id)) {
      throw new Error(`[kernel] 动态工具 ${entry.id} 重复注册。`);
    }
    this.dynamicEntries.set(entry.id, entry);
    return () => {
      this.dynamicEntries.delete(entry.id);
    };
  }

  resolveRunTools(ctx: RunToolResolutionContext): ToolDefinition[] {
    const resolved: ToolDefinition[] = [];
    for (const entry of this.dynamicEntries.values()) {
      if (entry.scope !== "shared" && entry.scope !== ctx.preset) {
        continue;
      }
      const tool = entry.resolve(ctx);
      if (tool && (tool.scope === "shared" || tool.scope === ctx.preset)) {
        resolved.push(tool);
      }
    }
    return [...this.list(ctx.preset), ...resolved];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  require(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`[kernel] 工具 ${name} 未注册。`);
    }
    return tool;
  }

  list(scope?: ToolScope): ToolDefinition[] {
    const all = [...this.tools.values()];
    if (!scope) {
      return all;
    }
    return all.filter(
      (tool) => tool.scope === scope || tool.scope === "shared",
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    execCtx: ToolExecutionContext = {},
  ): Promise<unknown> {
    return this.executeDefinition(this.require(name), args, execCtx);
  }

  async executeDefinition(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    execCtx: ToolExecutionContext = {},
  ): Promise<unknown> {
    execCtx.signal?.throwIfAborted();
    const handle = execCtx.scopeHandle;
    const approval = execCtx.codeApproval;
    const permissions = handle ? this.permissions?.() : undefined;
    const normalized = execCtx.scopeHandle
      ? ((tool.zodSchema ?? z.fromJSONSchema(tool.parameters)).parse(
          args,
        ) as Record<string, unknown>)
      : args;
    let invocation: PermissionInvocation | undefined;
    let approvedExecutionMode: ToolExecutionContext["approvedExecutionMode"];
    if (execCtx.scopeHandle) {
      await execCtx.scopeHandle.resolvePath(".", "read");
      if (tool.scope === "design")
        throw new ToolDeniedError(
          tool.name,
          "Code Task 不包含可视化画布目标。",
        );
      const readonly =
        execCtx.scopeHandle.role === "explore" ||
        execCtx.scopeHandle.role === "review" ||
        execCtx.scopeHandle.describe().sandboxMode === "read-only";
      if (
        readonly &&
        tool.access !== "read" &&
        !(tool.access === "execute" && tool.readonlyExecution)
      )
        throw new ToolDeniedError(
          tool.name,
          "当前作用域只读，该工具没有声明可验证的只读执行能力。",
        );
      if (
        !approval ||
        !execCtx.runId ||
        !execCtx.toolCallId ||
        !execCtx.userId ||
        !permissions
      )
        throw new ToolDeniedError(tool.name, "缺少可信逐调用审批上下文。");
      const scope = execCtx.scopeHandle.describe();
      const policy = await approval.resolve();
      if (policy.scopeGeneration !== scope.generation)
        throw new ToolDeniedError(tool.name, "工具调用的授权代际已失效。");
      invocation = {
        preset: "code",
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        runId: execCtx.runId,
        toolCallId: execCtx.toolCallId,
        userId: execCtx.userId,
        agentId: execCtx.scopeHandle.agentId,
        role: execCtx.scopeHandle.role,
        scopeGeneration: policy.scopeGeneration,
        branchGeneration: policy.branchGeneration,
        mode: policy.mode,
        approvalCeiling: approval.ceiling,
        toolName: tool.name,
        args: normalized,
        displayArgs: publicToolArguments(tool, normalized),
        access: tool.access,
        readonlyExecution: tool.readonlyExecution,
        signal: execCtx.signal,
        ...(execCtx.threadId ? { threadId: execCtx.threadId } : {}),
      };
    }
    const decision = await this.events.emitWaterfall("tool-pre-execute", {
      args: normalized,
      ...(invocation ? { permissionInvocation: invocation } : {}),
      decision: "allow",
      runId: execCtx.runId,
      ...(execCtx.threadId ? { threadId: execCtx.threadId } : {}),
      toolName: tool.name,
    });
    if (decision.decision === "deny") {
      throw new ToolDeniedError(tool.name, decision.denyReason);
    }
    execCtx.signal?.throwIfAborted();
    if (invocation && handle && approval && permissions) {
      await handle.resolvePath(".", "read");
      const current = await approval.resolve();
      if (
        current.scopeGeneration !== invocation.scopeGeneration ||
        current.branchGeneration !== invocation.branchGeneration
      )
        throw new ToolDeniedError(
          tool.name,
          "等待审批期间 Task 授权代际或分支已改变。",
        );
      const claim = permissions.claim({
        ...invocation,
        mode: current.mode,
      });
      if (claim.decision === "deny")
        throw new ToolDeniedError(tool.name, claim.reason);
      approvedExecutionMode =
        invocation.mode === "plan" || current.mode === "plan"
          ? "plan"
          : current.mode;
    }
    return tool.execute(
      normalized,
      invocation
        ? {
            ...execCtx,
            permissionInvocation: invocation,
            approvedExecutionMode,
          }
        : execCtx,
    );
  }
}

/**
 * 系统提示段注册表：插件贡献段（scope/order/resolve），组装按 scope 过滤、
 * order 升序（Map 迭代序=注册序，sort 稳定 → 同 order 保注册序）、空段剔除。
 */
export class SystemPromptRegistryImpl implements SystemPromptRegistry {
  private readonly sections = new Map<string, PromptSectionDefinition>();

  register(section: PromptSectionDefinition): () => void {
    if (this.sections.has(section.name)) {
      throw new Error(`[kernel] 提示段 ${section.name} 重复注册。`);
    }
    this.sections.set(section.name, section);
    return () => {
      this.sections.delete(section.name);
    };
  }

  async compose(ctx: PromptCompositionContext): Promise<string> {
    const active = [...this.sections.values()].filter(
      (section) => section.scope === "always" || section.scope === ctx.preset,
    );
    active.sort((a, b) => a.order - b.order);
    const texts: string[] = [];
    for (const section of active) {
      const text = await section.resolve(ctx);
      if (text && text.trim().length > 0) {
        texts.push(text);
      }
    }
    return texts.join("\n\n");
  }
}

/** 能力贡献者注册表：开放贡献（同一 capability 多 provider）、运行时按 key 解析。 */
export class CapabilityRegistryImpl implements CapabilityRegistry {
  private readonly providers = new Map<
    string,
    Map<string, CapabilityRegistration<unknown>>
  >();

  register<T>(
    capability: string,
    provider: CapabilityRegistration<T>,
  ): () => void {
    const bucket = this.providers.get(capability) ?? new Map();
    if (bucket.has(provider.id)) {
      throw new Error(
        `[kernel] 能力 ${capability} 的贡献者 ${provider.id} 重复注册。`,
      );
    }
    bucket.set(
      provider.id,
      provider as unknown as CapabilityRegistration<unknown>,
    );
    this.providers.set(capability, bucket);
    return () => {
      bucket.delete(provider.id);
    };
  }

  list<T>(capability: string): Array<CapabilityRegistration<T>> {
    const bucket = this.providers.get(capability);
    if (!bucket) {
      return [];
    }
    return [...bucket.values()] as unknown as Array<CapabilityRegistration<T>>;
  }

  get<T>(capability: string, id: string): T | undefined {
    return this.providers.get(capability)?.get(id)?.value as T | undefined;
  }

  require<T>(capability: string, id: string): T {
    const value = this.get<T>(capability, id);
    if (value === undefined) {
      throw new Error(`[kernel] 能力 ${capability} 的贡献者 ${id} 未注册。`);
    }
    return value;
  }
}

export interface KernelContextOptions {
  env: ServerEnv;
  /** worker 进程 compose 时不传 Fastify 实例，此时 ctx.app 访问即抛错。 */
  app?: FastifyInstance;
  register: RegisterFn;
  get: GetFn;
  tryGet: <K extends ServiceKey>(key: K) => ServiceMap[K] | undefined;
  events: AgentRunEventBus;
  /** kernel dispose 时 LIFO 执行的 disposer 收集器（ctx.effect 落点）。 */
  addDisposer: (disposer: () => void) => void;
}

export function createPluginContext(
  options: KernelContextOptions,
): PluginContext {
  const { env, events, addDisposer } = options;
  const appInstance: FastifyInstance | undefined = options.app;

  const context: PluginContext = {
    register: (key, factory) => options.register(key, factory),
    get: (key) => options.get(key),
    tryGet: (key) => options.tryGet(key),
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === "function") {
        addDisposer(disposer);
      }
    },
    on: <E extends AgentRunEvent>(event: E, listener: ListenerOf<E>) =>
      events.on(event, listener),
    get app() {
      if (!appInstance) {
        throw new Error(
          "[kernel] ctx.app 在本进程不可用（composePlugins 未传入 Fastify 实例）。",
        );
      }
      return appInstance;
    },
    env,
  };
  return context;
}

export function createKernelEvents(events: AgentRunEventBus): KernelEvents {
  return {
    emitPreStep: (payload) => events.emitWaterfall("pre-step", payload),
    emitToolPreExecute: (payload) =>
      events.emitWaterfall("tool-pre-execute", payload),
    emitTurnStopping: (payload) => events.emitSerial("turn-stopping", payload),
  };
}
