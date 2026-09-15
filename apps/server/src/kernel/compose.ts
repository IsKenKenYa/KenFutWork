import type { FastifyInstance } from "fastify";

import type { ServerEnv } from "../config/env.js";
import {
  AgentRunEventBus,
  CapabilityRegistryImpl,
  createKernelEvents,
  createPluginContext,
  ToolRegistryImpl,
} from "./context.js";
import type {
  DepsOf,
  KernelEvents,
  KernelHandle,
  PluginContext,
  PluginDefinition,
  ServiceKey,
  ServiceMap,
} from "./types.js";

export interface ComposeOptions {
  /** HTTP 进程必传；worker 进程不传，此时插件访问 ctx.app 即抛错。 */
  app?: FastifyInstance;
  /** 服务实例直填（测试与 BuildAppOptions 收编用）；命中时跳过对应工厂。 */
  overrides?: Partial<ServiceMap>;
  /** 外部注入事件总线（装配方需要在 compose 前拿到派发器时使用）。 */
  events?: AgentRunEventBus;
  /** 打印挂载树（dsh --dump-config 轻量等价物）。 */
  dump?: boolean;
}

type ServiceState =
  | { kind: "ready"; service: ServiceMap[ServiceKey] }
  | { kind: "pending"; factory: (deps: DepsOf<ServiceKey>) => unknown };

/**
 * 装配插件树（内核唯一入口）。
 *
 * 装配语义：按声明顺序 apply；依赖经 ctx.get 惰性解析（递归实例化天然拓扑序），
 * 成环 / 缺依赖 / 重名 key / 重名插件在启动期全部 fail loud（§8 风险对策）。
 * 装配完成后强制定例化全部工厂，保证问题在启动期暴露而非首次请求时。
 */
export function composePlugins(
  env: ServerEnv,
  plugins: readonly PluginDefinition[],
  options: ComposeOptions = {},
): KernelHandle {
  const overrides: Partial<ServiceMap> = options.overrides ?? {};

  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new Error(`[kernel] 插件 ${plugin.name} 重复声明。`);
    }
    names.add(plugin.name);
  }

  const active = plugins.filter((plugin) => plugin.enabled?.(env) ?? true);
  const skipped = plugins.filter(
    (plugin) => plugin.enabled && !plugin.enabled(env),
  );
  if (skipped.length > 0) {
    // 配置 fail loud 的可见性面：enabled 判定为 false 的插件在此处留痕，
    // 否则「没配 key → 能力静默消失」无从排查（如联网搜索缺 KENFUTWORK_SEARCH_API_KEY）
    console.log(
      `[kernel] 未启用插件（enabled 判定为 false）：${skipped
        .map((plugin) => plugin.name)
        .join("、")}`,
    );
  }

  const factories = new Map<ServiceKey, ServiceState>();
  const disposers: Array<() => void> = [];
  const addDisposer = (disposer: () => void) => {
    disposers.push(disposer);
  };

  const resolving = new Set<ServiceKey>();

  const get = <K extends ServiceKey>(key: K): ServiceMap[K] => {
    const override = overrides[key];
    if (override !== undefined) {
      return override;
    }
    const state = factories.get(key);
    if (!state) {
      throw new Error(`[kernel] 服务 key ${key} 未注册（fail loud）。`);
    }
    if (state.kind === "ready") {
      return state.service as ServiceMap[K];
    }
    if (resolving.has(key)) {
      throw new Error(`[kernel] 服务 key ${key} 存在循环依赖（fail loud）。`);
    }
    resolving.add(key);
    let service: ServiceMap[ServiceKey];
    try {
      service = state.factory({ get }) as ServiceMap[ServiceKey];
    } finally {
      resolving.delete(key);
    }
    factories.set(key, { kind: "ready", service });
    return service as ServiceMap[K];
  };

  const tryGet = <K extends ServiceKey>(key: K): ServiceMap[K] | undefined => {
    const override = overrides[key];
    if (override !== undefined) {
      return override;
    }
    if (!factories.has(key)) {
      return undefined;
    }
    return get(key);
  };

  const events = options.events ?? new AgentRunEventBus();

  const mountTree: Array<{ plugin: string; key: ServiceKey }> = [];
  let currentPlugin = "kernel";

  const register = <K extends ServiceKey>(
    key: K,
    factory: (deps: DepsOf<K>) => ServiceMap[K],
  ) => {
    if (factories.has(key)) {
      throw new Error(`[kernel] 服务 key ${key} 被重复注册（fail loud）。`);
    }
    factories.set(key, {
      kind: "pending",
      factory: factory as unknown as (deps: DepsOf<ServiceKey>) => unknown,
    });
    mountTree.push({ plugin: currentPlugin, key });
  };

  // 内核自持的两个注册表型 key：在插件 apply 之前就绪（插件要在 apply 内向其贡献）。
  if (!overrides.tools) {
    factories.set("tools", {
      kind: "ready",
      service: new ToolRegistryImpl(events),
    });
  }
  if (!overrides.capabilities) {
    factories.set("capabilities", {
      kind: "ready",
      service: new CapabilityRegistryImpl(),
    });
  }

  const kernelContextFor = (plugin: PluginDefinition): PluginContext => {
    currentPlugin = plugin.name;
    return createPluginContext({
      env,
      ...(options.app ? { app: options.app } : {}),
      register,
      get,
      tryGet,
      events,
      addDisposer,
    });
  };

  for (const plugin of active) {
    const disposer = plugin.apply(kernelContextFor(plugin));
    if (typeof disposer === "function") {
      addDisposer(disposer);
    }
  }

  // inject 声明校验：依赖的 key 必须可解析（工厂或 overrides），缺了立即报错。
  for (const plugin of active) {
    for (const key of plugin.inject) {
      if (!factories.has(key) && overrides[key] === undefined) {
        throw new Error(
          `[kernel] 插件 ${plugin.name} 声明依赖 ${key}，但没有任何插件提供它（fail loud）。`,
        );
      }
    }
  }

  // 启动期强制定例化：缺依赖 / 成环在这里抛错，不留到首个请求。
  for (const [key] of factories) {
    get(key);
  }

  // mounted 阶段：服务全部就绪，插件在此做跨服务接线（路由注册等）。
  for (const plugin of active) {
    plugin.mounted?.(kernelContextFor(plugin));
  }

  if (options.dump) {
    const tree = new Map<string, string[]>();
    for (const { plugin, key } of mountTree) {
      const bucket = tree.get(plugin) ?? [];
      bucket.push(key);
      tree.set(plugin, bucket);
    }
    const lines = [...tree.entries()].map(
      ([plugin, keys]) => `  ${plugin} -> ${keys.join(", ")}`,
    );
    console.log(`[kernel] mount tree:\n${lines.join("\n")}`);
  }

  const kernelEvents: KernelEvents = createKernelEvents(events);

  return {
    dispose() {
      for (const disposer of disposers.reverse()) {
        disposer();
      }
      disposers.length = 0;
      factories.clear();
    },
    get,
    tryGet,
    events: kernelEvents,
  };
}
