/**
 * ZodError 判定与描述（HTTP 路由共用）。
 *
 * 为什么是鸭子类型而不是 `instanceof z.ZodError`：zod 4 的 class 在「同一进程里存在
 * 多份 zod 实例」时 `instanceof` 会假失败（pnpm 严格布局 + 可选依赖很容易造出多份），
 * 而路由的包体校验失败必须稳定地映射成 400 —— 判错的代价是「把客户端错误报成 500」。
 */

/** zod issue 的最小可用形状（`message` 供人读，`path` 定位字段）。 */
export type ZodIssueLike = { message: string; path: Array<string | number> };

export function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}

/**
 * 把 issues 拼成人可读的一句话：「字段路径：规则说明；…」。
 * 只输出路径与规则，**不回显收到的值**——请求体里可能有只写字段（apiKey、自定义头值）。
 */
export function describeZodIssues(issues: unknown[], limit = 5): string {
  const parts = issues
    .slice(0, limit)
    .map((issue) => {
      const shaped = issue as Partial<ZodIssueLike>;
      const path = Array.isArray(shaped.path) ? shaped.path.join(".") : "";
      const message =
        typeof shaped.message === "string" ? shaped.message : "不符合契约";
      return path ? `${path}：${message}` : message;
    })
    .filter((part) => part.length > 0);

  return parts.join("；") || "请求体不符合契约。";
}
