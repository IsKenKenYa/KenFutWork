/**
 * 上下文容量浮层的「分类占比」（参考图 `模型旁边显示上下文容量和缓存命中等数据.png`）。
 *
 * **口径是字符数**：按「进入模型输入的各段文本长度」分段——不是 token 精确拆分
 * （那要求每个上游都回分类 token，现实里拿不到）。界面必须把这点写出来，
 * 不能让人以为这是 token 计量。
 *
 * 分类与来源：
 * - `系统提示词` ← 模型输入里的 SystemMessage（我们拼的系统提示 + 插件提示段）；
 * - `消息`       ← Human/AI 消息 + 普通工具结果（工具结果也是对话内容）；
 * - `技能`       ← 技能工具的**结果**（`use_skill` / `list_skills` 拉进来的技能文档）；
 * - `MCP 工具`   ← 工具 schema 里名字以 `mcp__` 开头的那些；
 * - `系统工具`   ← 其余工具 schema（内置文件/命令/搜索/生成等）；
 * - `其他`       ← 认不出的消息形态（例如多模态块里的非文本部分）。
 */

export type CompositionLabel =
  | "系统提示词"
  | "消息"
  | "技能"
  | "MCP 工具"
  | "系统工具"
  | "其他";

export interface CompositionPart {
  label: CompositionLabel;
  chars: number;
}

/** 技能相关工具：它们的**结果**算「技能」（技能文档就是这么进上下文的）。 */
export const SKILL_TOOL_NAMES = new Set(["use_skill", "list_skills"]);

/** MCP 工具的名字前缀（与统一注册表的命名约定一致）。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 一段内容折算成字符数：字符串取长度，其余取 JSON 文本长度（多模态块也算个量级）。 */
function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content === null || content === undefined) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

/** 取消息类型名：兼容 LangChain 的 `_getType()`、`getType()` 与构造器名。 */
function messageTypeOf(message: unknown): string {
  const candidate = message as {
    _getType?: () => string;
    getType?: () => string;
    constructor?: { name?: string };
  };
  if (typeof candidate?._getType === "function") {
    return candidate._getType();
  }
  if (typeof candidate?.getType === "function") {
    return candidate.getType();
  }
  return candidate?.constructor?.name ?? "";
}

/**
 * 按消息分段：SystemMessage → 系统提示词；技能工具结果 → 技能；
 * 其余 Human/AI/Tool → 消息；认不出的 → 其他。
 */
export function measureMessages(
  messages: readonly unknown[],
): CompositionPart[] {
  const buckets = new Map<CompositionLabel, number>();
  const add = (label: CompositionLabel, chars: number) => {
    buckets.set(label, (buckets.get(label) ?? 0) + chars);
  };

  for (const message of messages) {
    const type = messageTypeOf(message);
    const content = (message as { content?: unknown })?.content;
    const chars = contentChars(content);

    if (/system/i.test(type)) {
      add("系统提示词", chars);
      continue;
    }
    if (/tool/i.test(type)) {
      const toolName = (message as { name?: unknown })?.name;
      if (typeof toolName === "string" && SKILL_TOOL_NAMES.has(toolName)) {
        add("技能", chars);
        continue;
      }
      add("消息", chars);
      continue;
    }
    if (/human|user|ai|assistant/i.test(type)) {
      add("消息", chars);
      continue;
    }
    add("其他", chars);
  }

  return [...buckets.entries()].map(([label, chars]) => ({ label, chars }));
}

/**
 * 按工具 schema 分段：`mcp__` 前缀 → MCP 工具，其余 → 系统工具。
 * 字符数取 `JSON.stringify({name, description, schema})` 的长度——这是模型实际看到的形状。
 */
export function measureTools(tools: readonly unknown[]): CompositionPart[] {
  let mcpChars = 0;
  let systemChars = 0;

  for (const tool of tools) {
    const candidate = tool as {
      name?: unknown;
      description?: unknown;
      schema?: unknown;
      parameters?: unknown;
    };
    const name = typeof candidate?.name === "string" ? candidate.name : "";
    const chars = contentChars({
      name,
      description:
        typeof candidate?.description === "string" ? candidate.description : "",
      schema: candidate?.schema ?? candidate?.parameters ?? null,
    });
    if (name.startsWith(MCP_TOOL_PREFIX)) {
      mcpChars += chars;
    } else {
      systemChars += chars;
    }
  }

  const parts: CompositionPart[] = [];
  if (systemChars > 0) parts.push({ label: "系统工具", chars: systemChars });
  if (mcpChars > 0) parts.push({ label: "MCP 工具", chars: mcpChars });
  return parts;
}

/** 合并同类项、丢掉 0 值、按字符数降序（浮层按这个顺序列）。 */
export function mergeComposition(
  parts: readonly CompositionPart[],
): CompositionPart[] {
  const buckets = new Map<CompositionLabel, number>();
  for (const part of parts) {
    if (part.chars <= 0) continue;
    buckets.set(part.label, (buckets.get(part.label) ?? 0) + part.chars);
  }
  return [...buckets.entries()]
    .map(([label, chars]) => ({ label, chars }))
    .sort((a, b) => b.chars - a.chars);
}
