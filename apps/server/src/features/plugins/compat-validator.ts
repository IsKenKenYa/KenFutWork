import type {
  CompatIssue,
  CompatReport,
  PluginBundleManifest,
} from "@loomic/shared";

import {
  type BundleFiles,
  BundleManifestError,
  buildBundleManifest,
} from "./bundle-manifest.js";
import {
  bindingOf,
  partitionCapabilities,
  SUPPORTED_EVENTS,
} from "./capability-binding.js";
import type { ModuleScan } from "./module-scan.js";
import { PatchParseError } from "./patch-parser.js";

/**
 * 兼容性门禁（安装前拦截）：判定一个 bundle 能否在本项目内核上运行。
 *
 * 设计原则：
 * - **默认拒绝**：无法判定（动态上下文访问、直连系统 API、依赖 dsh 运行时）即拦截。
 * - **可归因**：每条 issue 都带 code + 面向用户的理由，UI 直接展示为何不能装。
 * - **不以校验代替沙箱**：通过门禁的插件仍在进程内执行，门禁是兼容性判据而非隔离层；
 *   安装期生命周期脚本因此默认拒绝，需调用方显式授权。
 * - 纯函数：不触网、不读盘、不执行待安装代码，全部分支可单测。
 */

export interface ValidateOptions {
  /** 宿主 Node 主版本，用于 engines 判定 */
  hostNodeMajor: number;
  /** 用户/调用方是否已显式授权安装期生命周期脚本 */
  allowLifecycleScripts: boolean;
  /** 解析失败时用于报告的兜底标识（如 owner/repo） */
  fallbackName: string;
}

function issue(
  code: CompatIssue["code"],
  severity: CompatIssue["severity"],
  message: string,
  detail?: string,
): CompatIssue {
  return detail === undefined
    ? { code, severity, message }
    : { code, severity, message, detail };
}

function emptyReport(
  name: string,
  issues: CompatIssue[],
  format: CompatReport["format"] = "dsh",
): CompatReport {
  return {
    compatible: false,
    format,
    name,
    version: "0.0.0",
    requiredCapabilities: [],
    supportedCapabilities: [],
    unsupportedCapabilities: [],
    issues,
    checkedAt: new Date().toISOString(),
  };
}

/** 解析 engines.node 的期望主版本；无法解析时返回 null（不拦）。 */
export function parseRequiredNodeMajor(range: string | null): number | null {
  if (!range) return null;
  const match = range.match(/(\d+)/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

/**
 * 对已解析的清单 + 模块扫描结果做门禁判定。
 * 只产出 issue 与能力分组，不抛错。
 */
export function validateBundleManifest(
  manifest: PluginBundleManifest,
  scan: ModuleScan,
  options: ValidateOptions,
): CompatReport {
  const issues: CompatIssue[] = [];

  // 1) 依赖 dsh in-box 运行时
  if (manifest.dshBaseDependencies.length > 0) {
    issues.push(
      issue(
        "requires_dsh_runtime",
        "blocker",
        "该插件依赖 dsh 内置运行时包，本项目不提供这些包。",
        manifest.dshBaseDependencies.join(", "),
      ),
    );
  }

  // 2) dsh web 客户端 UI
  if (manifest.hasClientUi) {
    issues.push(
      issue(
        "requires_dsh_client",
        "blocker",
        "该插件包含 dsh web 客户端 UI（`dsh.client`），需要 dsh 的客户端插槽运行时。",
      ),
    );
  }

  // 3) 原生构建
  if (manifest.hasNativeBuild) {
    issues.push(
      issue(
        "native_build_required",
        "blocker",
        "该插件需要原生构建（binding.gyp / gypfile），本项目不代其编译原生模块。",
      ),
    );
  }

  // 4) 直连系统能力：绕过能力面，行为无法判定
  if (scan.unsafeModules.length > 0) {
    issues.push(
      issue(
        "unsafe_module_require",
        "blocker",
        "该插件直接引入系统模块，绕过能力面，无法判定其行为。",
        scan.unsafeModules.join(", "),
      ),
    );
  }

  // 5) 动态上下文访问：所需能力无法静态判定
  if (scan.hasDynamicAccess) {
    issues.push(
      issue(
        "dynamic_context_access",
        "blocker",
        "该插件使用动态属性访问上下文（`ctx[...]`），所需能力无法静态判定。",
      ),
    );
  }

  // 6) 能力面判定
  const { supported, unsupported, unknown } = partitionCapabilities(
    manifest.requiredCapabilities,
  );

  if (unsupported.length > 0) {
    const reasons = unsupported
      .map((capability) => {
        const binding = bindingOf(capability);
        return `- \`${capability}\`：${binding?.reason ?? "本项目未提供该能力。"}`;
      })
      .join("\n");
    issues.push(
      issue(
        "capability_unsupported",
        "blocker",
        `该插件需要本项目未提供的 ${unsupported.length} 项能力：${unsupported.join("、")}`,
        reasons,
      ),
    );
  }

  if (unknown.length > 0) {
    issues.push(
      issue(
        "capability_unsupported",
        "blocker",
        `该插件声明了无法识别的 ${unknown.length} 项能力：${unknown.join("、")}`,
        `未在能力绑定表（capability-binding.ts）中的能力一律拒绝，避免静默降级。未识别项：${unknown.join("、")}`,
      ),
    );
  }

  if (
    supported.length === 0 &&
    unsupported.length === 0 &&
    unknown.length === 0
  ) {
    issues.push(
      issue(
        "capability_undeclared",
        "warning",
        "该插件未声明任何所需能力，安装后不会向本内核贡献可调用能力。",
      ),
    );
  }

  // 7) 事件面判定：订阅了本内核不派发的事件
  const unsupportedEvents = scan.subscribedEvents.filter(
    (event) => !SUPPORTED_EVENTS.includes(event),
  );
  if (unsupportedEvents.length > 0) {
    issues.push(
      issue(
        "event_unsupported",
        "blocker",
        `该插件订阅了本内核不派发的 ${unsupportedEvents.length} 个事件：${unsupportedEvents.join("、")}`,
        `本内核只派发：${SUPPORTED_EVENTS.join("、")}（DEC-1 最小事件缝）。订阅未派发的事件不会报错但永不触发，故拒绝安装。`,
      ),
    );
  }

  // 8) 安装期生命周期脚本：默认拒绝
  if (manifest.lifecycleScripts.length > 0) {
    issues.push(
      issue(
        "lifecycle_script_present",
        options.allowLifecycleScripts ? "warning" : "blocker",
        options.allowLifecycleScripts
          ? "该插件包含安装期生命周期脚本，已按你的显式授权执行。"
          : "该插件包含安装期生命周期脚本，会在安装时执行任意代码。",
        manifest.lifecycleScripts.join(", "),
      ),
    );
  }

  // 9) Node 引擎
  const requiredMajor = parseRequiredNodeMajor(manifest.enginesNode);
  if (requiredMajor !== null && requiredMajor > options.hostNodeMajor) {
    issues.push(
      issue(
        "engines_incompatible",
        "warning",
        `该插件要求 Node ${manifest.enginesNode}，当前宿主为 ${options.hostNodeMajor}。`,
      ),
    );
  }

  const compatible = !issues.some((item) => item.severity === "blocker");

  return {
    compatible,
    format: manifest.format,
    name: manifest.name,
    version: manifest.version,
    requiredCapabilities: [...supported, ...unsupported],
    supportedCapabilities: supported,
    unsupportedCapabilities: unsupported,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 门禁入口：对 bundle 文件集合做完整校验。
 * 任何解析失败都转成**不通过的报告**而非抛错——门禁的职责是给出结论与理由。
 */
export function validateBundleFiles(
  files: BundleFiles,
  options: ValidateOptions,
): CompatReport {
  let built: ReturnType<typeof buildBundleManifest>;
  try {
    built = buildBundleManifest(files);
  } catch (error) {
    return failureReport(error, options.fallbackName);
  }
  return validateBundleManifest(built.manifest, built.scan, options);
}

function failureReport(error: unknown, fallbackName: string): CompatReport {
  if (error instanceof BundleManifestError) {
    const code: CompatIssue["code"] =
      error.reason === "manifest_missing"
        ? "manifest_missing"
        : error.reason === "manifest_invalid"
          ? "manifest_invalid"
          : "bundle_declaration_missing";
    return emptyReport(fallbackName, [issue(code, "blocker", error.message)]);
  }
  if (error instanceof PatchParseError) {
    return emptyReport(fallbackName, [
      issue(
        error.reason === "config_expression"
          ? "config_expression_unsupported"
          : "patch_invalid",
        "blocker",
        error.message,
      ),
    ]);
  }
  return emptyReport(fallbackName, [
    issue(
      "manifest_invalid",
      "blocker",
      `bundle 解析失败：${error instanceof Error ? error.message : String(error)}`,
    ),
  ]);
}
