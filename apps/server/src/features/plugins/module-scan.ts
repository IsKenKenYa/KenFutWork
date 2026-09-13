/**
 * 插件模块静态扫描（门禁的第一道事实来源）。
 *
 * 门禁**不执行**待安装代码即可判定兼容性，故所需能力靠静态扫描得出。
 * 这是有意的近似：扫描是**兼容性**判据，不是安全沙箱——模块最终仍在进程内执行，
 * 因此对「越过能力面直连系统 API」的模式一律按不可判定处理（拒绝安装）。
 */

/** Cordis 上下文自带的框架方法，不占用能力名。 */
const FRAMEWORK_MEMBERS = new Set([
  "effect",
  "on",
  "inject",
  "logger",
  "get",
  "set",
  "provide",
  "consume",
  "scope",
  "isolate",
  "emit",
  "parallel",
  "waterfall",
  "serial",
  "bail",
  "then",
  "current",
  "root",
  "isolate",
]);

/** 直连系统能力的模块：插件绕过能力面，门禁无法判定其行为。 */
const UNSAFE_MODULES = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "node:vm",
  "vm",
  "node:cluster",
  "cluster",
  "node:fs",
  "node:fs/promises",
];

export interface ModuleScan {
  /** 模块显式声明的依赖能力（`export const inject = [...]` / `ctx.inject([...])`） */
  declaredInject: string[];
  /** 源码中实际访问的 `ctx.<name>` 成员（已剔除框架方法） */
  accessedMembers: string[];
  /** 静态可识别的 `ctx.on('<event>')` 订阅事件名 */
  subscribedEvents: string[];
  /** 是否使用了无法静态判定的动态访问（`ctx[...]`） */
  hasDynamicAccess: boolean;
  /** 直连的系统模块（命中即拒绝） */
  unsafeModules: string[];
}

function extractInjectArrays(source: string): string[] {
  const found: string[] = [];
  const pattern = /inject\s*[:(=]\s*\[([^\]]*)\]/g;
  for (const match of source.matchAll(pattern)) {
    for (const literal of match[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      found.push(literal[1]!.trim());
    }
  }
  return found;
}

function extractCtxMembers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/ctx\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const member = match[1]!;
    if (!FRAMEWORK_MEMBERS.has(member)) {
      found.add(member);
    }
  }
  return [...found];
}

function extractUnsafeModules(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /(?:require\s*\(\s*|from\s+)["'`]([^"'`]+)["'`]/g,
  )) {
    const specifier = match[1]!.trim();
    if (UNSAFE_MODULES.includes(specifier)) {
      found.add(specifier);
    }
    // `import { x } from "node:fs/promises"` 类前缀匹配
    if (
      UNSAFE_MODULES.some(
        (mod) => specifier === mod || specifier.startsWith(`${mod}/`),
      )
    ) {
      found.add(specifier);
    }
  }
  return [...found];
}

function extractSubscribedEvents(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bon\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    found.add(match[1]!.trim());
  }
  return [...found];
}

export function scanPluginModule(source: string): ModuleScan {
  return {
    declaredInject: extractInjectArrays(source),
    accessedMembers: extractCtxMembers(source),
    subscribedEvents: extractSubscribedEvents(source),
    hasDynamicAccess: /ctx\s*\[/.test(source),
    unsafeModules: extractUnsafeModules(source),
  };
}
