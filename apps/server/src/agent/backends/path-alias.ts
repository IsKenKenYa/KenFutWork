/**
 * 真实绝对路径 → 虚拟根路径的**别名层**（`withWorkDirAlias`）。
 *
 * 为什么需要：prod 沙箱（`LocalShellBackend` + `virtualMode: true`）把 rootDir 虚拟成
 * `/`，根外绝对路径一律**静默返回空结果**（ls 空、read 报不存在）——而模型恰恰会拿到
 * 真实绝对路径（用户消息里贴路径、历史对话、execute 里 `pwd` 的回显），然后拿着
 * `/Volumes/…/kimi-code` 去 ls，得到「目录是空的」（2026-09-20 用户实测）。
 *
 * 这层在**入站**把以沙箱真实目录开头的路径改写成虚拟路径（目录本身 → `/`，子路径 →
 * `/子路径`），其余一律原样透传——`/workspace/`、`/skills/` 等虚拟路由与相对路径不受影响。
 * `execute` 不在别名范围：它跑在真实文件系统上，绝对路径本来就可达。
 */

/** 文件工具方法 → 路径参数的下标（其余方法原样透传）。 */
const PATH_ARG_INDEX: Record<string, number> = {
  ls: 0,
  read: 0,
  readRaw: 0,
  write: 0,
  edit: 0,
  delete: 0,
  grep: 1,
  glob: 1,
};

/**
 * 把命中前缀的路径改写成虚拟路径；未命中原样返回。
 * `null`/`undefined`（grep/glob 的可选 path）原样透传；正反斜杠都认（Windows 路径）。
 */
export function aliasWorkDirPath(
  path: string | null | undefined,
  prefixes: readonly string[],
): string | null | undefined {
  if (!path) return path;
  const normalized = path.replaceAll("\\", "/");
  for (const raw of prefixes) {
    const prefix = raw.replaceAll("\\", "/").replace(/(.)[\\/]+$/, "$1");
    if (!prefix || prefix === "/") continue;
    if (normalized === prefix) return "/";
    if (normalized.startsWith(`${prefix}/`))
      return normalized.slice(prefix.length);
  }
  return path;
}

/** 给 backend 套上路径别名：文件工具的路径参数先过 `aliasWorkDirPath` 再委托内层。 */
export function withWorkDirAlias<T extends object>(
  backend: T,
  sandboxDirAliases: readonly string[],
): T {
  return new Proxy(backend, {
    get(target, prop) {
      // 以 target 为 receiver：类 getter（可能摸 #私有字段）不能落在 Proxy 上
      const value: unknown = (target as Record<string | symbol, unknown>)[prop];
      const argIndex = PATH_ARG_INDEX[prop as string];
      if (argIndex === undefined || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        args[argIndex] = aliasWorkDirPath(
          args[argIndex] as string | null | undefined,
          sandboxDirAliases,
        );
        return value.apply(target, args);
      };
    },
  });
}
