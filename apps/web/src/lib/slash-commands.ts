/**
 * 自定义斜杠命令的**消费方逻辑**（R5-2 的「命令」条目）。
 *
 * 形态：设置里定义 `名字 + 说明 + 提示词模板`，输入框里 `/名字 参数` 触发，
 * **提交前**展开成提示词——用户能在转录里看到自己实际发出去的是什么（比服务端偷偷替换好排查）。
 *
 * 口径：
 * - 名字只认字母/数字/连字符，大小写不敏感（`/Review` 与 `/review` 同一条）；
 * - 模板里的 `{{args}}` 换成命令后面的参数；**没有占位符**就把参数追加到末尾（空参数不加）；
 * - 认不出的名字**原样发出**（不吞掉用户输入，也不报错打断发送）。
 */

export interface WorkspaceCommand {
  name: string;
  description: string;
  prompt: string;
}

export interface ExpandedCommand {
  /** 真正发出去的文本。 */
  text: string;
  /** 命中的命令（没命中为 undefined）。 */
  command?: WorkspaceCommand;
  /** 命令后面的参数（已 trim）。 */
  args: string;
}

/** `/名字 参数…` 的解析（名字之后可选空白 + 参数）。认不出返回 null。 */
export function parseCommandInput(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const match = /^([a-zA-Z0-9][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!match) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/** 按名字查命令（大小写不敏感）。 */
export function findCommand(
  name: string,
  commands: readonly WorkspaceCommand[],
): WorkspaceCommand | undefined {
  const needle = name.toLowerCase();
  return commands.find((command) => command.name.toLowerCase() === needle);
}

/** 展开：命中就替换成模板（带参数），没命中原样返回。 */
export function expandCommand(
  text: string,
  commands: readonly WorkspaceCommand[],
): ExpandedCommand {
  const parsed = parseCommandInput(text);
  if (!parsed) return { text, args: "" };
  const command = findCommand(parsed.name, commands);
  if (!command) return { text, args: parsed.args };
  const hasPlaceholder = command.prompt.includes("{{args}}");
  const expanded = hasPlaceholder
    ? command.prompt.replaceAll("{{args}}", parsed.args)
    : parsed.args
      ? `${command.prompt}\n\n${parsed.args}`
      : command.prompt;
  return { text: expanded, command, args: parsed.args };
}

/**
 * 输入框里要不要给「可用命令」的提示：正在敲 `/`（还没敲出空格）时给。
 * 已经敲成完整命令、或压根不是命令输入，都不打扰。
 */
export function shouldSuggestCommands(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return false;
  return !/\s/.test(trimmed);
}
