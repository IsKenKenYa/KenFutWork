import { load as loadYaml } from "js-yaml";

/**
 * `cordis.patch.yml` 解析（dsh bundle 的配置层）。
 *
 * 文件形状是 YAML **数组**，每项要么是覆盖某一行、要么是插入新行：
 *
 * ```yaml
 * - insert:
 *     - id: hello
 *       name: dsh-hello-plugin
 * - id: some-row            # 覆盖：按 id 整份替换该行 config（不深合并）
 *   name: dsh-other-plugin
 *   inject: [tools]
 * ```
 *
 * 解析失败必须是**可归因**的：调用方据 `reason` 生成门禁报告，而不是笼统的
 * 「YAML 错误」。dsh 配置支持 `!!js` 表达式求值，本项目不求值，故单独识别。
 */

export interface PatchRow {
  /** 行 id（patch 定位键） */
  id: string;
  /**
   * 插件模块名（npm 包名或包内子路径）。
   * `insert` 行必填；**覆盖行可省略**——dsh 允许只给 `id` + `config` 来覆盖既有行的配置
   * （实测 `yujunzhixue/dsh-purge` 等真实插件即此写法），此时 name 为 null。
   */
  name: string | null;
  /** 该行显式声明的依赖能力 */
  inject: string[];
}

export interface ParsedPatch {
  rows: PatchRow[];
  /** 覆盖既有行的行（`id` 命中上游 bundle 的行） */
  overrides: PatchRow[];
  /** 原文含 `!!js` 配置表达式 */
  hasConfigExpressions: boolean;
}

export class PatchParseError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "not_yaml"
      | "not_array"
      | "row_invalid"
      | "config_expression",
  ) {
    super(message);
    this.name = "PatchParseError";
  }
}

/** 文本级检测：js-yaml 默认 schema 不认 `!!js`，先识别以给出精确归因。 */
export function hasConfigExpressions(source: string): boolean {
  return /!!js\b|!!js\//.test(source);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readId(raw: unknown, label: string): string {
  if (typeof raw !== "object" || raw === null) {
    throw new PatchParseError(`${label} 不是对象。`, "row_invalid");
  }
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new PatchParseError(`${label} 缺少 id。`, "row_invalid");
  }
  return id.trim();
}

/**
 * 解析 `insert` 里的新行：**必须**同时有 id 与 name——
 * 插入意味着要挂载一个模块，没有 name 就无从解析。
 */
function normalizeInsertRow(raw: unknown, label: string): PatchRow {
  const id = readId(raw, label);
  const name = (raw as Record<string, unknown>).name;
  if (typeof name !== "string" || !name.trim()) {
    throw new PatchParseError(
      `${label} 缺少 name（插入行必须指定模块）。`,
      "row_invalid",
    );
  }
  return {
    id,
    name: name.trim(),
    inject: asStringArray((raw as Record<string, unknown>).inject),
  };
}

/**
 * 解析覆盖行：只要求 id；name 可省略（覆盖既有行配置的常见写法）。
 * 若给了 name，也一并保留——它可能是在替换该行的模块。
 */
function normalizeOverrideRow(raw: unknown, label: string): PatchRow {
  const id = readId(raw, label);
  const name = (raw as Record<string, unknown>).name;
  return {
    id,
    name: typeof name === "string" && name.trim() ? name.trim() : null,
    inject: asStringArray((raw as Record<string, unknown>).inject),
  };
}

export function parsePatch(source: string): ParsedPatch {
  // 空（或纯空白）patch 合法：bundle 只是不贡献任何行。
  // js-yaml v5 对空输入抛「expected a document」，故先兜住。
  if (!source.trim()) {
    return { rows: [], overrides: [], hasConfigExpressions: false };
  }

  if (hasConfigExpressions(source)) {
    throw new PatchParseError(
      "配置含 dsh `!!js` 表达式，本项目不求值此类配置。",
      "config_expression",
    );
  }

  let loaded: unknown;
  try {
    loaded = loadYaml(source);
  } catch (error) {
    throw new PatchParseError(
      `不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
      "not_yaml",
    );
  }

  if (loaded === null || loaded === undefined) {
    // 空 patch 是合法的：bundle 只是不贡献任何行
    return { rows: [], overrides: [], hasConfigExpressions: false };
  }
  if (!Array.isArray(loaded)) {
    throw new PatchParseError(
      "patch 顶层必须是数组（每项为一行插入或覆盖）。",
      "not_array",
    );
  }

  const rows: PatchRow[] = [];
  const overrides: PatchRow[] = [];
  loaded.forEach((entry, index) => {
    const label = `patch 第 ${index + 1} 项`;
    if (typeof entry !== "object" || entry === null) {
      throw new PatchParseError(`${label} 不是对象。`, "row_invalid");
    }
    const container = entry as Record<string, unknown>;
    if ("insert" in container) {
      const inserted = container.insert;
      if (!Array.isArray(inserted)) {
        throw new PatchParseError(
          `${label} 的 insert 必须是数组。`,
          "row_invalid",
        );
      }
      inserted.forEach((row, rowIndex) => {
        rows.push(
          normalizeInsertRow(row, `${label} insert 第 ${rowIndex + 1} 行`),
        );
      });
      return;
    }
    overrides.push(normalizeOverrideRow(container, label));
  });

  return { rows, overrides, hasConfigExpressions: false };
}
