import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 随包分发的语言运行时（Node / Python / uv / JDK）。
 *
 * 背景：桌面包是 Node SEA 单 exe + 内嵌 Postgres，但 agent 的 `execute` 工具是在
 * **宿主机**上跑命令——用户机器没装 Node/Python/JDK 时，「建个 python 项目」「跑
 * 一段 Java」「npx 启 MCP server」全都不可用。本模块把「运行时目录怎么找」收敛成
 * 一处（与 `resolvePgBinDir` 同构），供 sandbox 的 PATH 注入与打包脚本共用。
 * `uv` 单列一项：Python 侧的 MCP server 官方推荐用 `uvx` 拉起（见 curated 目录），
 * 而 CPython 发行版不自带 uv。
 *
 * 解析链（每个运行时独立）：
 *   `KENFUTWORK_{NODE,PYTHON,UV,JAVA}_BIN_DIR`（显式覆盖）→ 发布包内 `<exeDir>/runtime/<x>/…`
 * 显式覆盖但目录不存在 = 配置错，**fail loud**；未捆绑则返回 undefined（属增强项，
 * 不阻断启动——宿主自带的 node/python/java 仍可用）。
 */

export type RuntimeName = "node" | "python" | "uv" | "java" | "git";

export interface RuntimeRoot {
  name: RuntimeName;
  /** 可执行文件所在目录（加入 PATH）。 */
  binDir: string;
  /** 运行时根（JDK 用：JAVA_HOME 指向它）。 */
  homeDir: string;
}

export interface RuntimeResolutionInput {
  env: Record<string, string | undefined>;
  /** 打包后的 exe 目录（发布包布局：`<exeDir>/runtime/...`）。 */
  exeDir: string;
  /** 注入以便测试。 */
  exists?: (path: string) => boolean;
}

/** 每个运行时在包内的相对布局与可执行文件名。 */
const RUNTIME_LAYOUT: Record<
  RuntimeName,
  {
    /** 包内相对根目录。 */
    dir: string;
    /** 运行时根内的 bin 相对路径（Windows 与 POSIX 同构，统一用 bin/ 或根）。 */
    bin: string;
    /** 用于判定「确实装了」的可执行文件名。 */
    probe: string;
    /** 环境变量覆盖名。 */
    envKey: string;
  }
> = {
  // Node 官方 zip 顶层就是 node.exe（fetch 脚本会把顶层目录拍平到 runtime/node）
  node: {
    dir: "node",
    bin: "",
    probe: "node.exe",
    envKey: "KENFUTWORK_NODE_BIN_DIR",
  },
  python: {
    dir: "python",
    bin: "",
    probe: "python.exe",
    envKey: "KENFUTWORK_PYTHON_BIN_DIR",
  },
  // uv 发布 zip 顶层是 uv.exe / uvx.exe（fetch 脚本拍平到 runtime/uv）
  uv: { dir: "uv", bin: "", probe: "uvx.exe", envKey: "KENFUTWORK_UV_BIN_DIR" },
  java: {
    dir: "jdk",
    bin: "bin",
    probe: "java.exe",
    envKey: "KENFUTWORK_JAVA_BIN_DIR",
  },
  // MinGit 的可执行体在 cmd/ 下（另有 mingw64/bin，二者都含 git.exe；取 cmd 更稳）
  git: {
    dir: "git",
    bin: "cmd",
    probe: "git.exe",
    envKey: "KENFUTWORK_GIT_BIN_DIR",
  },
};

function dirOf(input: { layoutBin: string; base: string }): string {
  return input.layoutBin ? join(input.base, input.layoutBin) : input.base;
}

/** 解析单个运行时；未捆绑返回 null，显式配置错误抛错。 */
export function resolveRuntime(
  name: RuntimeName,
  input: RuntimeResolutionInput,
): RuntimeRoot | null {
  const layout = RUNTIME_LAYOUT[name];
  const exists = input.exists ?? existsSync;

  const explicit = input.env[layout.envKey]?.trim();
  if (explicit) {
    if (!exists(join(explicit, layout.probe))) {
      throw new Error(
        `${layout.envKey} 指向的目录里找不到 ${layout.probe}：${explicit}（fail loud，避免静默回落宿主运行时）。`,
      );
    }
    const homeDir =
      layout.bin && explicit.endsWith(layout.bin)
        ? explicit.slice(0, explicit.length - layout.bin.length - 1)
        : explicit;
    return { name, binDir: explicit, homeDir };
  }

  const base = join(input.exeDir, "runtime", layout.dir);
  const binDir = dirOf({ layoutBin: layout.bin, base });
  if (!exists(join(binDir, layout.probe))) {
    return null;
  }
  return { name, binDir, homeDir: base };
}

export interface ResolvedRuntimes {
  roots: RuntimeRoot[];
  /**
   * 注入 sandbox 的 PATH 前缀（顺序：node → python → uv → java → git）。
   * 注意 git 只在其未被宿主找到时才出现——见 `hasSystemGit`。
   */
  pathAdditions: string[];
  /** JDK 存在时设置（许多 Java 工具依赖）。 */
  javaHome: string | undefined;
  /** 供启动日志与界面提示：已捆绑哪些运行时。 */
  bundled: RuntimeName[];
}

/**
 * 宿主自带 git 的探测：扫 PATH 各段里有没有 `git.exe`。
 *
 * 为什么要探测：用户要求 **git 优先用本地的、打包的只作兜底**（python/node/jdk 相反，
 * 那三个是随包优先）。PATH 前缀一旦无脑前置打包目录就会把本地 git 顶掉，故这里先探
 * 本地；本地有就**不注入**打包 git。
 *
 * 纯函数（注入 exists）便于测试；`pathValue` 为 undefined 视为「本地没有」。
 */
export function hasSystemGit(options: {
  path?: string | undefined;
  exists?: (path: string) => boolean;
  separator?: string;
  executable?: string;
}): boolean {
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? "git.exe";
  const separator = options.separator ?? ";";
  return (options.path ?? "")
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((dir) => exists(join(dir, executable)));
}

export function resolveRuntimes(
  input: RuntimeResolutionInput & {
    /** 宿主 PATH（判定本地 git；缺省读 process.env.PATH）。 */
    systemPath?: string | undefined;
  },
): ResolvedRuntimes {
  const roots: RuntimeRoot[] = [];
  const names: RuntimeName[] = ["node", "python", "uv", "java"];
  // git 优先本地：宿主已有 git 就不注入打包的（显式 KENFUTWORK_GIT_BIN_DIR 仍优先，走同一解析）
  const gitExplicit = input.env[RUNTIME_LAYOUT.git.envKey]?.trim();
  if (
    gitExplicit ||
    !hasSystemGit({
      path: input.systemPath ?? process.env.PATH,
      ...(input.exists ? { exists: input.exists } : {}),
    })
  ) {
    names.push("git");
  }
  for (const name of names) {
    const root = resolveRuntime(name, input);
    if (root) {
      roots.push(root);
    }
  }
  const java = roots.find((root) => root.name === "java");
  return {
    roots,
    pathAdditions: roots.map((root) => root.binDir),
    javaHome: java?.homeDir,
    bundled: roots.map((root) => root.name),
  };
}

/** 把运行时 bin 目录前置到既有 PATH（去重：已含则不加）。 */
export function prependRuntimePath(
  existingPath: string | undefined,
  additions: readonly string[],
  separator = ";",
): string {
  const parts = (existingPath ?? "")
    .split(separator)
    .filter((part) => part.length > 0);
  const missing = additions.filter((dir) => !parts.includes(dir));
  return [...missing, ...parts].join(separator);
}

export interface RuntimeEnvOptions {
  runtimePathAdditions?: string[] | undefined;
  javaHome?: string | undefined;
  /** 注入以便测试。 */
  platform?: NodeJS.Platform;
  basePath?: string | undefined;
  pathext?: string | undefined;
}

/**
 * 把解析出的运行时折成 sandbox 的 env 片段（dev/prod 两个 backend 共用）：
 *   - `PATH`：运行时 bin 目录前置，宿主机没装也能跑对应任务；
 *   - `JAVA_HOME`：JDK 存在时设置；
 *   - `PATHEXT`：**Windows 必传**——`uv` / `npx` 这类工具自己扫 PATH，靠 PATHEXT 才把
 *     `python` 匹配到 `python.exe`；缺了它，即使 python.exe 就在 PATH 上也会报
 *     「找不到解释器」（实测 `uv venv --python python` 直接失败）。
 */
export function runtimeEnvAdditions(
  options: RuntimeEnvOptions = {},
): Record<string, string> {
  const separator =
    (options.platform ?? process.platform) === "win32" ? ";" : ":";
  const env: Record<string, string> = {
    PATH: prependRuntimePath(
      options.basePath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      options.runtimePathAdditions ?? [],
      separator,
    ),
  };
  if (options.javaHome) {
    env.JAVA_HOME = options.javaHome;
  }
  const pathext = options.pathext ?? process.env.PATHEXT;
  if (separator === ";" && pathext) {
    env.PATHEXT = pathext;
  }
  return env;
}
