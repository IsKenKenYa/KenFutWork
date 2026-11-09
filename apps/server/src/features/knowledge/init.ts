/**
 * 初始化编排（M2，KB-1 / KB-3）。
 *
 * KB-1：`sag config` 无参数在非交互环境输出脱敏 ModelConfig（上游 main.rs
 * `configure()` 全空选项直接 `return Ok(current)`）。`has_key`/`auth_mode` 已配置
 * → **复用、绝不覆盖**；未配置 → 从宿主 `modelProviders` 取唯一权威 key，
 * 经 `sag config --auth bearer --key-stdin` 的 **stdin** 注入（不进 argv、日志、事件）。
 *
 * KB-3：M2 核验确认服务端**没有**「不依赖 run 的全局当前工作区根」服务，
 * 因此「自动注册」从「安装时」改为「首次检索时按 run 的真实工作目录」：
 * 这里只提供幂等的 `ensureKnowledgeRoot(path)`，由 M3 的 pre-step 传入目录。
 */

import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  isSagCliPlatformSupported,
  isSagConfigured,
  isSagIndexReady,
  SAG_EXIT,
  sagCheckOutputSchema,
  sagModelConfigSchema,
} from "./sag-cli-contract.js";
import { SAG_EXIT_TIMEOUT, type SagRunner } from "./sag-cli-runner.js";
import {
  KNOWLEDGE_INDEX_EXTENSIONS,
  type KnowledgeEnsureResult,
  type KnowledgeInitResult,
} from "./types.js";

export interface KnowledgeInitOptions {
  runner: SagRunner;
  /** 后台路径用 `modelProviders.resolveCredentialsById(id).apiKey`；无实例返回 null。 */
  readJevCredential: () => Promise<string | null>;
  platform?: NodeJS.Platform;
  arch?: string;
  indexExtensions?: readonly string[];
}

function normalized(path: string): string {
  return resolve(path)
    .toLowerCase()
    .replace(/[\\/]+$/, "");
}

/**
 * 个人目录 / 磁盘根 / 系统目录一律拒绝自动注册（KB-3 隐私护栏）。
 * 显式由用户在侧栏添加的目录不走这个判定——拒绝只作用于「自动」路径。
 */
export function isPersonalDirectory(input: string): boolean {
  const target = resolve(input);
  const key = normalized(target);
  const home = normalized(homedir());
  const diskRoot = normalized(parse(target).root);

  if (key === diskRoot) return true;
  // target 是 home 的祖先（如 C:\Users、/Users）也属个人区域。
  if (home.startsWith(`${key}${sep}`)) return true;
  if (
    [home, ...["Desktop", "Downloads", "Documents"].map((p) => join(home, p))]
      .map(normalized)
      .includes(key)
  ) {
    return true;
  }
  const systemRoots = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "/etc",
    "/usr",
    "/System",
    "/Library",
  ];
  return systemRoots.some((root) => key === normalized(root));
}

/** 解析 `sag ... --json` 的 stdout；失败必须有明确原因，不静默吞掉。 */
export function parseJsonOutput(
  result: { code: number; stdout: string; stderr: string },
  label: string,
): unknown {
  if (result.code === SAG_EXIT_TIMEOUT) {
    throw new Error(`${label} 超时：请缩小检索范围或稍后重试。`);
  }
  if (result.code === SAG_EXIT.interrupted) {
    throw new Error(`${label} 被中断。`);
  }
  if (result.code === SAG_EXIT.argument) {
    throw new Error(
      `${label} 参数或执行错误：${result.stderr.trim() || "无输出"}`,
    );
  }
  const text = result.stdout.trim();
  if (!text) {
    throw new Error(
      `${label} 未返回 JSON（退出码 ${result.code}）：${result.stderr.trim() || "SAG CLI 不可用或未就绪"}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 输出不是合法 JSON（可能来自首次配置引导）。`);
  }
}

/**
 * 幂等初始化：平台 → CLI 探测（借 `sag config`）→ 凭据复用或 stdin 注入。
 * **不注册任何知识库根**，也不改用户已有的 SAG 桌面端设置。
 */
export async function initializeKnowledge(
  options: KnowledgeInitOptions,
): Promise<KnowledgeInitResult> {
  if (!isSagCliPlatformSupported(options.platform, options.arch)) {
    return {
      ok: false,
      credential: "missing",
      cli: "unsupported_platform",
      reason:
        "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。",
    };
  }

  let config: ReturnType<typeof sagModelConfigSchema.parse>;
  try {
    const raw = parseJsonOutput(
      await options.runner({ args: ["config"] }),
      "读取 SAG 配置",
    );
    config = sagModelConfigSchema.parse(raw);
  } catch (error) {
    return {
      ok: false,
      credential: "missing",
      cli: "missing",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (isSagConfigured(config)) {
    return { ok: true, credential: "reused", cli: "available", reason: null };
  }

  let credential: string | null;
  try {
    credential = await options.readJevCredential();
  } catch (error) {
    return {
      ok: false,
      credential: "missing",
      cli: "available",
      reason: `读取宿主检索凭据失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!credential?.trim()) {
    return {
      ok: false,
      credential: "missing",
      cli: "available",
      reason:
        "尚未配置 Jev 检索凭据：请在供应商设置中登记 TypeSafe 实例，或沿用 SAG Wiki 桌面端已有配置。",
    };
  }

  const result = await options.runner({
    // `--key-stdin` 与 `--key` 互斥；不传 --url/--model 以保留用户现有值。
    args: ["config", "--auth", "bearer", "--key-stdin"],
    stdin: credential.trim(),
  });
  if (result.code !== SAG_EXIT.ok) {
    return {
      ok: false,
      credential: "missing",
      cli: "available",
      reason: `注入检索凭据失败（退出码 ${result.code}）：${result.stderr.trim() || "无输出"}`,
    };
  }
  // 成功路径不回显任何凭据内容。
  return { ok: true, credential: "injected", cli: "available", reason: null };
}

/**
 * 幂等确保某个真实工作目录已被索引。
 * 新根用 `--types` 显式开启代码/配置扩展名（M0 §3 核实 `code:false`）；
 * 已存在的根只回报、不改设置，避免覆盖用户桌面端的文件类型配置。
 */
export async function ensureKnowledgeRoot(
  options: KnowledgeInitOptions,
  root: string,
): Promise<KnowledgeEnsureResult> {
  if (!isAbsolute(root)) {
    return {
      path: root,
      action: "rejected",
      reason: "知识库根必须是绝对路径。",
    };
  }
  if (isPersonalDirectory(root)) {
    return {
      path: root,
      action: "rejected",
      reason:
        "拒绝自动索引个人目录、磁盘根或系统目录；如需索引请在侧边栏显式添加。",
    };
  }

  const check = await options.runner({ args: ["check", root, "--json"] });
  // check 未通过是 exit(1) 的正常语义，仍带 JSON 输出，不能当错误吞掉。
  let parsed: ReturnType<typeof sagCheckOutputSchema.parse>;
  try {
    parsed = sagCheckOutputSchema.parse(parseJsonOutput(check, "检查索引覆盖"));
  } catch (error) {
    return {
      path: root,
      action: "deferred",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed.coverage === "included") {
    return {
      path: root,
      action: "already-indexed",
      ...(isSagIndexReady(parsed)
        ? {}
        : { reason: "目录已在索引内，但索引尚未就绪或被禁用。" }),
    };
  }
  if (parsed.coverage === "partial" || parsed.coverage === "excluded") {
    return {
      path: root,
      action: "deferred",
      reason: "目录处于部分覆盖或已排除状态，请检查忽略规则，插件不自动改写。",
    };
  }

  const extensions = options.indexExtensions ?? KNOWLEDGE_INDEX_EXTENSIONS;
  const added = await options.runner({
    args: ["add", root, "--types", extensions.join(","), "--json"],
  });
  if (added.code !== SAG_EXIT.ok) {
    return {
      path: root,
      action: "deferred",
      reason: `注册知识库失败（退出码 ${added.code}）：${added.stderr.trim() || "无输出"}`,
    };
  }
  return { path: root, action: "added" };
}
