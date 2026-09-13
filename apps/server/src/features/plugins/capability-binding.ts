import type { CanonicalCapability } from "@loomic/shared";

import type { ServiceKey } from "../../kernel/types.js";

/**
 * 能力绑定表（互操作缝的 Service Definition）：规范能力名 → 我方 kernel 服务。
 *
 * 这是**唯一**的 dsh/Loomic 能力映射属主。新增可被第三方插件使用的 kernel 能力，
 * 只改本表一行；不支持的能力必须显式列出并给出面向用户的理由——门禁据此拒绝安装，
 * 禁止静默降级（会得到「装上了但行为不确定」的插件）。
 */
export interface CapabilityBinding {
  /** 规范能力名（dsh ctx key 语义） */
  capability: CanonicalCapability;
  /** 我方 kernel 服务 key；`null` = 未提供该能力 */
  serviceKey: ServiceKey | null;
  supported: boolean;
  /** 不支持时面向用户的理由（门禁报告直接展示） */
  reason?: string;
}

export const CAPABILITY_BINDINGS: readonly CapabilityBinding[] = [
  {
    capability: "tools",
    serviceKey: "tools",
    supported: true,
  },
  {
    capability: "settings",
    serviceKey: null,
    supported: false,
    reason:
      "本项目设置以用户/工作区为作用域（需 request 级令牌），插件加载期没有该上下文，无法提供语义正确的设置视图。",
  },
  {
    capability: "jobs",
    serviceKey: null,
    supported: false,
    reason:
      "本项目的后台任务是服务端内部 PGMQ 队列（ctx.jobs 为进程内契约），未对外开放注册，插件无法安全接管。",
  },
  {
    capability: "llm",
    serviceKey: null,
    supported: false,
    reason:
      "本项目供应商走 BYOK 实例 + 凭证缝（ctx.modelProviders / ctx.modelCatalog），与 dsh 的适配器缝形状不同。",
  },
  {
    capability: "sessions",
    serviceKey: null,
    supported: false,
    reason: "会话日志由本项目 runtime 与持久化缝独占，插件不可替换。",
  },
  {
    capability: "commands",
    serviceKey: null,
    supported: false,
    reason: "本项目无「人类命令」扩展点（dsh 的 ctx.commands）。",
  },
  {
    capability: "systemPrompt",
    serviceKey: null,
    supported: false,
    reason:
      "提示段装配在本项目 agent 运行时的 system prompt 组装内，未开放注册。",
  },
  {
    capability: "fs",
    serviceKey: null,
    supported: false,
    reason:
      "文件系统访问经 agent 后端虚拟 Store（backends），未对外开放 provider 注册。",
  },
  {
    capability: "subprocess",
    serviceKey: null,
    supported: false,
    reason: "子进程执行是世界缝（沙箱/后端），未对外开放 provider 注册。",
  },
  {
    capability: "sandbox",
    serviceKey: null,
    supported: false,
    reason: "沙箱由 agent 后端（本地/远程）决定，未对外开放注册。",
  },
  {
    capability: "agents",
    serviceKey: null,
    supported: false,
    reason: "子代理/agent 注册表由 agent 运行时独占，未对外开放。",
  },
];

const BY_CAPABILITY = new Map(
  CAPABILITY_BINDINGS.map((binding) => [binding.capability, binding]),
);

export function bindingOf(
  capability: CanonicalCapability,
): CapabilityBinding | undefined {
  return BY_CAPABILITY.get(capability);
}

/** 门禁放行的能力集合（支持的规范能力名）。 */
export const SUPPORTED_CAPABILITIES: readonly CanonicalCapability[] =
  CAPABILITY_BINDINGS.filter((binding) => binding.supported).map(
    (binding) => binding.capability,
  );

/**
 * 事件桥（互操作缝的事件面）：dsh 事件名 → 我方 agent-run 事件名。
 * 本项目的「最小事件缝」只有三个事件（DEC-1）；未列出的 dsh 事件一律拒绝，
 * 因为订阅了也永不触发——静默无效比拒绝安装更糟。
 */
export const EVENT_ALIASES: Readonly<Record<string, string>> = {
  "agent/pre-step": "pre-step",
  "tools/pre-execute": "tool-pre-execute",
  "agent/turn-stopping": "turn-stopping",
};

export const SUPPORTED_EVENTS: readonly string[] = Object.keys(EVENT_ALIASES);

/**
 * 解析插件声明所需能力 → 支持/不支持两组。
 * 形状异常的能力名（第三方清单可能塞任意字符串）一律归入不支持，并保留原名以便报告。
 */
export function partitionCapabilities(required: readonly string[]): {
  supported: CanonicalCapability[];
  unsupported: CanonicalCapability[];
  unknown: string[];
} {
  const supported: CanonicalCapability[] = [];
  const unsupported: CanonicalCapability[] = [];
  const unknown: string[] = [];
  for (const name of required) {
    const binding = BY_CAPABILITY.get(name as CanonicalCapability);
    if (!binding) {
      unknown.push(name);
      continue;
    }
    if (binding.supported) {
      supported.push(binding.capability);
    } else {
      unsupported.push(binding.capability);
    }
  }
  return { supported, unsupported, unknown };
}
