/**
 * 服务端内置斜杠命令。
 *
 * 命令目录由宿主发给界面（`WorkspaceSlashCommand.source = "builtin"`）；
 * 发送时在这里展开成模型输入。`/compact`、`/plan`、`/goal` 已由客户端本地消费，
 * 不在此重复注册，避免同一条命令出现两种执行方式。
 *
 * 内置命令优先于同名自定义命令：用户把命令改了名字也不会改变内置行为。
 */

type BuiltinCommand = {
  name: string;
  description: string;
  inputHint: string;
  /** 把参数展开成模型输入；空参数也要给出可执行的行为。 */
  buildPrompt: (args: string) => string;
};

const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: "init",
    description: "生成或更新项目说明",
    inputHint: "/init [补充要求]",
    buildPrompt: (args) =>
      [
        "检查当前工作目录，创建或更新项目根目录的 AGENTS.md。",
        "已有文件按现有结构修改，不要整篇覆盖；没有文件时写清构建、测试与代码约定。",
        args ? `补充要求：${args}` : "完成后说明改了哪些内容。",
      ].join("\n"),
  },
  {
    name: "review",
    description: "检查当前改动",
    inputHint: "/review [关注点]",
    buildPrompt: (args) =>
      [
        "检查当前工作区的未提交改动，按严重程度列出问题并给出文件与行号。",
        "只报告能证实的问题，不要顺手修改代码；需要修改时先说明方案。",
        args ? `关注点：${args}` : "重点看正确性、边界与回归风险。",
      ].join("\n"),
  },
  {
    name: "memory",
    description: "把结论存进项目记忆",
    inputHint: "/memory [要点]",
    buildPrompt: (args) =>
      [
        "从本次对话里挑出值得跨会话保留的结论，调用一次 `memory_save` 写入项目记忆。",
        "标题写短，正文写清结论、适用条件与证据位置；没有可保留的内容时直接说明，不要编造。",
        args
          ? `用户给出的要点：${args}`
          : "优先保留项目约定、踩坑结论与已验证的做法。",
      ].join("\n"),
  },
];

export type SlashCommandCatalogEntry = {
  name: string;
  description: string;
  inputHint: string;
  source: "builtin" | "custom";
};

/** 内置命令目录，供工作区配置下发。 */
export function builtinSlashCommandCatalog(): SlashCommandCatalogEntry[] {
  return BUILTIN_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    inputHint: command.inputHint,
    source: "builtin",
  }));
}

/**
 * 合并内置与自定义命令。
 *
 * 内置在前；自定义与内置或彼此重名时丢弃自定义，避免界面上出现两条同名命令。
 */
export function mergeBuiltinSlashCommands<T extends { name: string }>(
  custom: readonly T[],
): Array<SlashCommandCatalogEntry | T> {
  const seen = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  const customEntries: T[] = [];
  for (const entry of custom) {
    const key = entry.name.trim().replace(/^\/+/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    customEntries.push(entry);
  }
  return [...builtinSlashCommandCatalog(), ...customEntries];
}

/**
 * 命中内置命令时返回展开后的模型输入；未命中返回 null，交给自定义命令处理。
 */
export function resolveBuiltinCommandPrompt(
  name: string,
  args: string,
): string | null {
  const key = name.trim().replace(/^\/+/, "").toLowerCase();
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === key);
  return command ? command.buildPrompt(args.trim()) : null;
}
