/**
 * 审查视图「暂存块」的 patch 校验。
 *
 * 客户端送来的是**patch 文本**，而 `git apply --cached` 会照 patch 里写的路径改索引——
 * 所以服务端不能只看那个 `path` 字段：必须核对 patch 里出现的文件路径**确实只有它**，
 * 否则一份手工拼的 patch 就能把工作目录里任意文件塞进索引（越权面）。
 * 这里只做「路径提取与比对」，真正的应用交给 git（它自会校验上下文是否对得上）。
 */

/** 从 patch 里提取被改动的文件路径（`diff --git a/x b/y` 与 `+++ b/y` 两种写法）。 */
export function patchTargetPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/y`：b/ 侧是应用后的路径（重命名时与 a 侧不同）
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
      if (match?.[2]) paths.add(match[2]);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // `/dev/null` = 删除文件（没有目标路径），跳过
      if (target.startsWith("b/")) paths.add(target.slice(2));
    }
  }
  return [...paths];
}

/**
 * 这份 patch 是否**只动 declared 这一个文件**。
 * 空 patch（没解析出任何路径）也判 false——宁可让客户端重来，也不放一份看不懂的 patch 进 git。
 */
export function patchTargetsOnly(patch: string, declaredPath: string): boolean {
  const paths = patchTargetPaths(patch);
  return paths.length > 0 && paths.every((path) => path === declaredPath);
}
