import type { InstanceSettings } from "@kenfutwork/shared";
import { expandCustomCommandPrompt } from "./zcode-command-expansion.js";

export type ConfiguredCommand = InstanceSettings["commands"][number];

/**
 * 合并命令来源：实例设置优先（同名不覆盖用户配置），插件贡献补充其后。
 * 名字按大小写不敏感去重，与 `/name` 的匹配口径一致。
 */
export function mergeConfiguredCommands(
  instance: readonly ConfiguredCommand[],
  plugin: readonly ConfiguredCommand[],
): ConfiguredCommand[] {
  const names = new Set(instance.map((command) => command.name.toLowerCase()));
  return [
    ...instance,
    ...plugin.filter((command) => !names.has(command.name.toLowerCase())),
  ];
}

/** 实例命令仅编译模型输入；不修改原转录或签发工具权限。 */
export function resolveConfiguredCommandPrompt(
  input: string,
  commands: readonly ConfiguredCommand[] | undefined,
): string {
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(
    input.trimStart(),
  );
  if (!match) return input;
  if (!commands) throw new Error("命令配置读取失败，请重试。");
  const command = commands.find(
    (entry) => entry.name.toLowerCase() === match[1]?.toLowerCase(),
  );
  if (!command) return input;
  return expandCustomCommandPrompt({
    args: match[2] ?? "",
    command: {
      content: command.prompt,
      metadata: {
        name: command.name,
        scope: "user",
        source: "zcode",
        skills: [],
      },
    },
  }).prompt;
}
