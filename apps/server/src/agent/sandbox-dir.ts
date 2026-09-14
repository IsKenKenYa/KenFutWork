import { resolve } from "node:path";

/**
 * 画布 → 沙箱工作目录的**唯一**解析处。
 *
 * 为什么单独抽出来：这个目录有两类消费者——agent 后端（文件工具与 `execute` 的 cwd）
 * 与需要在该目录里操作的能力（如 git 分支操作）。若各算各的，一旦命名规则或根目录
 * 来源漂移，「agent 在 A 目录干活、X 在 B 目录操作」就会静默发生（本项目已有一次
 * 文件系统割裂的历史事故）。故判定只有一处，两边共用。
 *
 * 目录名的判定优先级：
 * 1. **真实目录映射**（`LOOMIC_CANVAS_WORK_DIRS`，画布 → 本机绝对路径）：
 *    本地/桌面形态把工作目录映射到真实电脑环境时用（产品决策 2026-09-14：
 *    「工作目录和真实电脑环境做映射，暂时不用沙箱，高风险命令才用沙箱」）。
 *    映射存在时直接落该目录，不走根目录拼接。
 * 2. 缺省：`<sandboxRoot>/<画布UUID>`（目录名来自画布 id，做防御性清洗防路径穿越）。
 */

/**
 * 缺省沙箱根：**相对路径**，按进程 cwd 解析成 `<cwd>/tmp/sandbox`。
 *
 * 这只是兜底——生产入口（`server.ts`）显式注入
 * `<项目根（dev）/ exe 安装目录（打包）>/tmp/sandbox`，故实际落点由入口决定；
 * 这里保持相对是为了不把绝对路径（尤其带盘符的 Windows 路径）钉死在代码里。
 */
export const DEFAULT_SANDBOX_ROOT = "tmp/sandbox";

export function sanitizeCanvasIdForPath(canvasId: string): string {
  return canvasId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** 返回画布沙箱目录（未做 mkdir / realpath，由调用方按需处理）。 */
export function resolveSandboxDir(
  canvasId: string,
  sandboxRoot?: string,
  workDirOverride?: string,
): string {
  if (workDirOverride?.trim()) {
    return resolve(workDirOverride.trim());
  }
  const root = resolve(sandboxRoot ?? DEFAULT_SANDBOX_ROOT);
  return resolve(root, sanitizeCanvasIdForPath(canvasId));
}
