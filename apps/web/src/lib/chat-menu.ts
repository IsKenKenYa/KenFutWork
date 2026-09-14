/**
 * 对话区右键菜单（纯逻辑部分）。
 *
 * 背景：对话区（Code 模式工作台 / Design 模式画布助手侧栏）此前右键没有可用菜单
 * ——应用内浏览器不弹原生菜单，用户既不能复制也不能粘贴，只能靠快捷键。
 * 这里把「菜单里做什么」抽成纯函数，便于单测；渲染由
 * `components/chat/chat-context-menu.tsx` 负责（风格与画布右键菜单一致）。
 */

export interface ChatMenuMessage {
  role: string;
  text: string;
}

/** 消息里的文本块（contentBlocks 中 type=text 的 content）。 */
export interface TextBlockLike {
  type: string;
  content?: unknown;
}

/** 取一条消息的纯文本（只取 text 块；思考/工具块不算用户可见正文）。 */
export function extractMessageText(
  blocks: readonly TextBlockLike[] | null | undefined,
): string {
  if (!blocks) return "";
  return blocks
    .filter(
      (block) => block.type === "text" && typeof block.content === "string",
    )
    .map((block) => block.content as string)
    .join("\n")
    .trim();
}

/** 把消息数组转成菜单需要的 {role, text}（供「复制当前对话」用）。 */
export function toChatMenuMessages(
  messages: ReadonlyArray<{
    role: string;
    contentBlocks?: readonly TextBlockLike[] | null;
    /** 兜底：没有 contentBlocks 的历史消息。 */
    content?: string;
  }>,
): ChatMenuMessage[] {
  return messages.map((message) => ({
    role: message.role,
    text: extractMessageText(message.contentBlocks) || (message.content ?? ""),
  }));
}

export interface ChatMenuPoint {
  x: number;
  y: number;
}

export interface ChatMenuSize {
  width: number;
  height: number;
}

/**
 * 把整段对话导出为纯文本（按角色标注），用于「复制当前对话」。
 * 空消息（只有工具调用没有文本）跳过，避免产出空行块。
 */
export function buildConversationText(
  messages: ChatMenuMessage[],
  options: { userLabel?: string; assistantLabel?: string } = {},
): string {
  const userLabel = options.userLabel ?? "我";
  const assistantLabel = options.assistantLabel ?? "助手";
  return messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => {
      const label = message.role === "user" ? userLabel : assistantLabel;
      return `${label}：${message.text.trim()}`;
    })
    .join("\n\n");
}

/**
 * 菜单落点：默认在光标处，越界时向内收（右侧/下侧靠近视口边缘时翻转）。
 * 留出 8px 安全边距，避免贴边被裁。
 */
export function clampMenuPosition(
  point: ChatMenuPoint,
  size: ChatMenuSize,
  viewport: ChatMenuSize,
  margin = 8,
): ChatMenuPoint {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(point.x, margin), maxX),
    y: Math.min(Math.max(point.y, margin), maxY),
  };
}

/** 复制到剪贴板：优先 Clipboard API，失败时回落 execCommand（非安全上下文/旧内核）。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 回落：临时 textarea + execCommand（需在用户手势内调用）
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 读取剪贴板文本（权限被拒/不支持时返回 null，由调用方提示改用快捷键）。 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    return text ?? "";
  } catch {
    return null;
  }
}

/** 当前选区文本（无选区返回空串）。 */
export function getSelectedText(): string {
  try {
    return window.getSelection()?.toString() ?? "";
  } catch {
    return "";
  }
}

/**
 * 选中某个容器内的全部文本（用于「全选对话」）。
 * 返回是否成功选中。
 */
export function selectAllTextIn(container: HTMLElement | null): boolean {
  if (!container) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** 菜单项定义（文案与快捷键提示同源，便于测试断言）。 */
export interface ChatMenuItem {
  id: "copy" | "paste" | "select-all" | "copy-conversation";
  label: string;
  shortcut: string;
}

export const CHAT_MENU_ITEMS: readonly ChatMenuItem[] = [
  { id: "copy", label: "复制", shortcut: "Ctrl+C" },
  { id: "paste", label: "粘贴", shortcut: "Ctrl+V" },
  { id: "select-all", label: "全选对话", shortcut: "Ctrl+A" },
  { id: "copy-conversation", label: "复制当前对话", shortcut: "" },
] as const;
