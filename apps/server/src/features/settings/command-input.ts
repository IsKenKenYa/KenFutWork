import type { InstanceSettings } from "@kenfutwork/shared";
import { resolveBuiltinCommandPrompt } from "../commands/builtin.js";
import { expandCustomCommandPrompt } from "./zcode-command-expansion.js";

/** 实例命令仅编译模型输入；不修改原转录或签发工具权限。 */
export function resolveConfiguredCommandPrompt(
  input: string,
  commands: readonly InstanceSettings["commands"][number][] | undefined,
): string {
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(
    input.trimStart(),
  );
  if (!match) return input;
  const builtin = resolveBuiltinCommandPrompt(match[1] ?? "", match[2] ?? "");
  if (builtin !== null) return builtin;
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
