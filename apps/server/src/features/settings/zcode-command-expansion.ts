// ZCode 3.14.3 / 29628c9acdb81b703bbd4080c207a0e7ce5e276e, Apache-2.0.
// 原参数展开声明机械提取；仅缩窄未使用的类型依赖，不含文件扫描或shell预展开。
interface CustomCommandContent {
  content: string;
  metadata: { name: string; scope: CustomCommandScope; source: CustomCommandSource; skills: string[] };
}

export type CustomCommandScope = "project" | "user" | "system" | "admin";

export type CustomCommandSource = "agents" | "zcode" | "plugin";

export interface CustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

export interface CustomCommandTemplateExpansion {
  argumentCount: number;
  body: string;
  usedArgumentsPlaceholder: boolean;
}

const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;

const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";

const INLINE_SHELL_PATTERN = /!`[^`]*`/;

const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;

export function expandCustomCommandPrompt(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandExpansion {
  const expanded = expandCustomCommandTemplate(input);
  const dynamicSyntax = detectUnsupportedDynamicSyntax(expanded.body);
  if (dynamicSyntax) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported ${dynamicSyntax} expansion. Dynamic expansion is not available yet.`,
    );
  }

  return formatCustomCommandPrompt({
    body: expanded.body,
    command: input.command,
    argumentCount: expanded.argumentCount,
    usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
  });
}

export function expandCustomCommandTemplate(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandTemplateExpansion {
  const args = input.args.trim();
  const positional = splitCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    const offset = Number(index) - 1;
    return positional[offset] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    body,
    usedArgumentsPlaceholder,
  };
}

export function formatCustomCommandPrompt(input: {
  argumentCount: number;
  body: string;
  command: CustomCommandContent;
  usedArgumentsPlaceholder: boolean;
}): CustomCommandExpansion {
  return {
    argumentCount: input.argumentCount,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      input.body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder: input.usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

export function detectUnsupportedDynamicSyntax(content: string): "shell" | undefined {
  if (INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content)) {
    return "shell";
  }
  return undefined;
}
