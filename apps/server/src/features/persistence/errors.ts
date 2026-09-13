/**
 * PostgreSQL 错误的归一化形状：业务代码据此判重（如 `23505` 唯一冲突），
 * 不依赖驱动错误对象——换 Provider 时判重逻辑不动。
 */
export class SqlError extends Error {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly detail: string | undefined;

  constructor(
    message: string,
    options: {
      code?: string | undefined;
      constraint?: string | undefined;
      detail?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = "SqlError";
    this.code = options.code;
    this.constraint = options.constraint;
    this.detail = options.detail;
  }
}

/** PostgreSQL 唯一约束冲突（`23505`）。 */
export const SQLSTATE_UNIQUE_VIOLATION = "23505";

/** 隔离违约：workspace 作用域语句未引用 `:workspace` 谓词。 */
export class WorkspaceIsolationError extends Error {
  constructor(operation: string) {
    super(
      `[persistence] ${operation} 缺少 :workspace 谓词——workspace 数据必须经 forWorkspace() 绑定工作区（FORM-9）。`,
    );
    this.name = "WorkspaceIsolationError";
  }
}
