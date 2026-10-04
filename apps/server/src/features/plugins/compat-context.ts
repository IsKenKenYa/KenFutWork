import { createResourceDisposer, type ResourceDisposer } from "../../kernel/disposal.js";
import type { PluginUiSlot } from "@kenfutwork/shared";

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
} from "../../kernel/types.js";
import { EVENT_ALIASES, partitionCapabilities } from "./capability-binding.js";

/**
 * 兼容上下文门面（互操作缝的 Service Provider 侧的适配层）。
 *
 * 作用：把 dsh 形状的插件（`export name / inject / apply(ctx)`）接到本项目内核上，
 * 而**不打开** `ServiceMap`（ctx key 仍是封闭联合）。做法是给插件一个受控门面：
 * 只有能力绑定表判定为支持的能力才会出现在门面上，其余一律不存在——插件拿不到
 * 未支持的能力面，也就不会出现「装上了但行为不确定」。
 *
 * 边界（有意为之）：
 * - 插件仍在进程内执行，本门面是**兼容性**适配，不是安全沙箱。
 * - 支持面见 `capability-binding.ts`（当前为 `tools`），改那里一处即改全局面。
 */

/** dsh 形状的工具定义（`output` 仅用于模型侧渲染，本项目忽略）。 */
export interface CompatToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  output?: unknown;
  execute?: (args: unknown, exec: unknown) => unknown | Promise<unknown>;
}

/** 插件贡献的提示段（追加进 system prompt——插件的「行为/工作模式」就是这么给的）。 */
export interface CompatPromptFragment {
  id?: string;
  text: string;
}

/** 插件自带的 HTTP 路由（挂在 `/api/plugins/<id>/…`）。 */
export interface CompatRouteSpec {
  method?: "GET" | "POST";
  /** 插件内路径（不含插件前缀），如 `panel` 或 `data/list`。 */
  path: string;
  /** 默认 false = 需要登录；面板页面本身（iframe 带不上头）通常声明 true。 */
  public?: boolean;
  handler: (request: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    headers: Record<string, string | undefined>;
    /**
     * 调用者所属工作区（未登录的公共路由为 undefined）。
     * `ctx.storage` 需要它——工作区是插件的**显式**入参，内核不代选默认值。
     */
    workspaceId?: string | undefined;
  }) => unknown | Promise<unknown>;
}

/** 插件贡献的 UI 面板入口（按 `slot` 出现在侧栏 / 对话 / 画布 / 设置页四处之一）。 */
export interface CompatUiEntry {
  id: string;
  title: string;
  slot?: PluginUiSlot;
  url: string;
  /** 入口图标（相对插件根的资源路径，如 `assets/icon.svg`）；缺省用宿主通用图标。 */
  icon?: string | null;
}

export interface CompatContext {
  readonly tools: {
    register(definition: CompatToolDefinition): () => void;
    get(name: string): ToolDefinition | undefined;
    list(): ToolDefinition[];
  };
  /** 提示段贡献（能力名 `systemPrompt`）。 */
  readonly promptFragments: {
    register(fragment: CompatPromptFragment): () => void;
  };
  /** 路由贡献（能力名 `routes`）。 */
  readonly routes: {
    register(spec: CompatRouteSpec): () => void;
  };
  /** UI 入口贡献（能力名 `ui`；清单里声明亦可）。 */
  readonly ui: {
    register(entry: CompatUiEntry): () => void;
  };
  /**
   * 存储贡献（能力名 `storage`）：按工作区隔离的键值存取，值加密落库、HTTP 永不回显。
   *
   * 工作区由插件**显式传入**：路由 handler 从 `request.workspaceId` 取，
   * 工具从执行上下文（`exec.workspaceId`）取。加载期没有该上下文，故不设默认值——
   * 缺工作区时内核直接报错（fail loud），不静默落到某个「默认工作区」。
   */
  readonly storage: {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
    remove(workspaceId: string, key: string): Promise<boolean>;
    keys(workspaceId: string): Promise<string[]>;
  };
  effect(fn: () => undefined | ResourceDisposer): void;
  on(
    event: string,
    listener: (payload: unknown, next?: unknown) => unknown,
  ): () => void;
  inject(capabilities: readonly string[], fn: () => void): void;
  readonly logger: {
    debug(message: unknown, ...rest: unknown[]): void;
    info(message: unknown, ...rest: unknown[]): void;
    warn(message: unknown, ...rest: unknown[]): void;
    error(message: unknown, ...rest: unknown[]): void;
  };
}

export type CompatLoadFailure =
  | "not_a_plugin"
  | "capability_unsupported"
  | "event_unsupported"
  | "tool_invalid"
  | "apply_failed";

export class CompatLoadError extends Error {
  constructor(
    message: string,
    readonly reason: CompatLoadFailure,
  ) {
    super(message);
    this.name = "CompatLoadError";
  }
}

export interface CompatHostDeps {
  tools: ToolRegistry;
  /** 订阅我方 agent-run 事件（kernel 的 `ctx.on`）。 */
  subscribe: (
    event: string,
    listener: (payload: unknown, next?: unknown) => unknown,
  ) => () => void;
  /** 提示段 sink（返回注销函数）。 */
  promptFragments: (fragment: CompatPromptFragment) => () => void;
  /** 路由 sink（返回注销函数）。 */
  routes: (spec: CompatRouteSpec) => () => void;
  /** UI 入口 sink（返回注销函数）。 */
  ui: (entry: CompatUiEntry) => () => void;
  /**
   * 存储 sink（调用方实现时已绑定插件 id）；工作区由插件显式传入。
   * 与其它 sink 不同，这里返回的是**数据通道**而不是注销函数——存储归插件生命周期管，
   * 由 registry 在卸载时 purge。
   */
  storage: {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
    remove(workspaceId: string, key: string): Promise<boolean>;
    keys(workspaceId: string): Promise<string[]>;
  };
  /** 插件标识，用于日志前缀与错误信息。 */
  label: string;
}

export interface CompatLoadResult {
  pluginName: string;
  /** 本插件注册的工具名（卸载与展示用）。 */
  toolNames: string[];
  dispose(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 提取 dsh ContentBlock 数组里的文本（只认 text 块，其余忽略）。 */
function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      const record = asRecord(block);
      return record && record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * dsh 工具结果 → 本项目工具返回值。
 * dsh 用 `{ content: ContentBlock[], structuredContent?, isError? }`；本项目直接把值交给
 * LangChain，故优先取 `structuredContent`，否则取文本；`isError` 转为抛错（让运行时标记失败）。
 */
export function normalizeToolResult(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.content)) {
    return value;
  }
  const text = extractText(record.content);
  if (record.isError === true) {
    throw new Error(text || "插件工具执行失败。");
  }
  if (record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  return text;
}

/** 本项目执行上下文 → dsh 形状的 `ToolExecution`（插件可能读 `signal` / `callId`）。 */
function buildExecutionShim(
  execCtx: ToolExecutionContext,
): Record<string, unknown> {
  return {
    signal: execCtx.signal,
    callId: execCtx.runId,
    runId: execCtx.runId,
    workspaceId: execCtx.workspaceId,
  };
}

function normalizeToolDefinition(raw: unknown, label: string): ToolDefinition {
  const record = asRecord(raw);
  if (!record) {
    throw new CompatLoadError(
      `${label}：ctx.tools.register 的入参不是对象。`,
      "tool_invalid",
    );
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    throw new CompatLoadError(`${label}：工具定义缺少 name。`, "tool_invalid");
  }
  if (typeof record.execute !== "function") {
    throw new CompatLoadError(
      `${label}：工具 ${name} 缺少 execute 函数。`,
      "tool_invalid",
    );
  }
  const parameters = asRecord(record.parameters) ?? {
    type: "object",
    properties: {},
  };
  const description =
    typeof record.description === "string" && record.description
      ? record.description
      : name;

  const pluginExecute = record.execute as (
    args: unknown,
    exec: unknown,
  ) => unknown | Promise<unknown>;

  return {
    name,
    description,
    scope: "shared",
    exposure: "deferred",
    // 兼容bundle没有可信只读证明，不能进入explore/review。
    access: "execute",
    parameters,
    execute: async (args, execCtx) =>
      normalizeToolResult(
        await pluginExecute(args, buildExecutionShim(execCtx)),
      ),
  };
}

/**
 * 加载一个插件模块命名空间：校验能力/事件面后调用其 `apply(ctx)`。
 *
 * 能力面在**运行时二次校验**（门禁已静态校验过）：静态扫描可能漏判，
 * 这里是最后一道，拒绝比静默运行更安全。
 */
export async function loadCompatPlugin(
  moduleExports: unknown,
  deps: CompatHostDeps,
): Promise<CompatLoadResult> {
  const namespace = asRecord(moduleExports);
  const apply = namespace?.apply;
  if (typeof apply !== "function") {
    throw new CompatLoadError(
      `${deps.label}：插件模块未导出 apply 函数。`,
      "not_a_plugin",
    );
  }

  const pluginName =
    typeof namespace?.name === "string" && namespace.name
      ? namespace.name
      : deps.label;

  const declaredInject = Array.isArray(namespace?.inject)
    ? namespace.inject.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const { unsupported, unknown } = partitionCapabilities(declaredInject);
  if (unsupported.length > 0 || unknown.length > 0) {
    throw new CompatLoadError(
      `${deps.label}：插件声明了未支持的能力（${[...unsupported, ...unknown].join("、")}）。`,
      "capability_unsupported",
    );
  }

  const toolDisposers: Array<() => void> = [];
  const effectDisposers: ResourceDisposer[] = [];
  const contributionDisposers: Array<() => void> = [];
  const toolNames: string[] = [];

  const context: CompatContext = {
    tools: {
      register(definition) {
        const normalized = normalizeToolDefinition(definition, deps.label);
        const dispose = deps.tools.register(normalized);
        toolDisposers.push(dispose);
        toolNames.push(normalized.name);
        return dispose;
      },
      get(name) {
        return deps.tools.get(name);
      },
      list() {
        return deps.tools.list();
      },
    },
    promptFragments: {
      register(fragment) {
        const text = typeof fragment?.text === "string" ? fragment.text : "";
        if (!text.trim()) {
          throw new CompatLoadError(
            `${deps.label}：ctx.promptFragments.register 需要非空 text。`,
            "tool_invalid",
          );
        }
        const dispose = deps.promptFragments({ ...fragment, text });
        contributionDisposers.push(dispose);
        return dispose;
      },
    },
    routes: {
      register(spec) {
        const routePath =
          typeof spec?.path === "string" ? spec.path.trim() : "";
        if (!routePath || typeof spec?.handler !== "function") {
          throw new CompatLoadError(
            `${deps.label}：ctx.routes.register 需要 path 与 handler。`,
            "tool_invalid",
          );
        }
        const dispose = deps.routes({ ...spec, path: routePath });
        contributionDisposers.push(dispose);
        return dispose;
      },
    },
    ui: {
      register(entry) {
        const title =
          typeof entry?.title === "string" ? entry.title.trim() : "";
        const url = typeof entry?.url === "string" ? entry.url.trim() : "";
        if (!title || !url) {
          throw new CompatLoadError(
            `${deps.label}：ctx.ui.register 需要 title 与 url。`,
            "tool_invalid",
          );
        }
        const dispose = deps.ui({ ...entry, title, url });
        contributionDisposers.push(dispose);
        return dispose;
      },
    },
    storage: {
      get: (workspaceId, key) => deps.storage.get(workspaceId, key),
      set: (workspaceId, key, value) =>
        deps.storage.set(workspaceId, key, value),
      remove: (workspaceId, key) => deps.storage.remove(workspaceId, key),
      keys: (workspaceId) => deps.storage.keys(workspaceId),
    },
    // 副作用由本适配层自己调用并登记：不能同时委托给 kernel 的 effect，
    // 否则 fn 会被执行两次（kernel 的 effect 也会调用它）。
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") {
        effectDisposers.push(dispose);
      }
    },
    on(event, listener) {
      const bridged = EVENT_ALIASES[event];
      if (!bridged) {
        throw new CompatLoadError(
          `${deps.label}：订阅了本内核不派发的事件 ${event}。`,
          "event_unsupported",
        );
      }
      return deps.subscribe(bridged, listener);
    },
    inject(capabilities, fn) {
      const { unsupported: missing, unknown: unknownCaps } =
        partitionCapabilities(capabilities);
      if (missing.length > 0 || unknownCaps.length > 0) {
        throw new CompatLoadError(
          `${deps.label}：ctx.inject 请求了未支持的能力（${[...missing, ...unknownCaps].join("、")}）。`,
          "capability_unsupported",
        );
      }
      fn();
    },
    logger: {
      debug: (message, ...rest) =>
        console.debug(`[plugin:${deps.label}]`, message, ...rest),
      info: (message, ...rest) =>
        console.log(`[plugin:${deps.label}]`, message, ...rest),
      warn: (message, ...rest) =>
        console.warn(`[plugin:${deps.label}]`, message, ...rest),
      error: (message, ...rest) =>
        console.error(`[plugin:${deps.label}]`, message, ...rest),
    },
  };

  // 保留组间注销次序；失败时真实资源仍可重试，不把异步close丢到后台。
  const disposeStack: ResourceDisposer[] = [];
  const drain = createResourceDisposer(disposeStack);
  let prepared = false;
  const rollback = (): Promise<void> => {
    if (!prepared) {
      prepared = true;
      disposeStack.push(...contributionDisposers, ...effectDisposers, ...toolDisposers);
    }
    return drain();
  };

  try {
    await (apply as (ctx: CompatContext) => unknown)(context);
  } catch (error) {
    // 装载失败必须整体回滚：否则实例只装了一半，注册表里留下孤儿工具，
    // 而插件又不在「已安装」列表里，无人能卸载它。
    await rollback();
    toolNames.length = 0;
    if (error instanceof CompatLoadError) throw error;
    throw new CompatLoadError(
      `${deps.label}：apply 执行失败：${error instanceof Error ? error.message : String(error)}`,
      "apply_failed",
    );
  }

  return {
    pluginName,
    toolNames,
    dispose: rollback,
  };
}
