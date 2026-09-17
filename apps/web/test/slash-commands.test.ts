import { describe, expect, it } from "vitest";

import {
  expandCommand,
  findCommand,
  parseCommandInput,
  shouldSuggestCommands,
} from "../src/lib/slash-commands.js";

/**
 * 自定义斜杠命令（R5-2「命令」条目）的消费方口径。
 *
 * 关键三条：认不出就**原样发**（不吞输入）、模板无占位符时参数追加到末尾（不是丢掉）、
 * 名字大小写不敏感（`/Review` 与 `/review` 同一条）。
 */
const commands = [
  {
    name: "review",
    description: "审查改动",
    prompt: "请审查以下改动：{{args}}",
  },
  { name: "explain", description: "解释代码", prompt: "解释这段代码" },
];

describe("解析 / 展开", () => {
  it("解析出名字与参数；不是命令输入返回 null", () => {
    expect(parseCommandInput("/review src/a.ts")).toEqual({
      name: "review",
      args: "src/a.ts",
    });
    expect(parseCommandInput("/review")).toEqual({ name: "review", args: "" });
    expect(parseCommandInput("随便说点什么")).toBeNull();
    expect(parseCommandInput("/")).toBeNull();
    // 名字里有空格/斜杠 → 不是我们的命令形态
    expect(parseCommandInput("/a/b x")).toBeNull();
  });

  it("有 {{args}} 占位符：替换成参数", () => {
    expect(expandCommand("/review src/a.ts", commands)).toMatchObject({
      text: "请审查以下改动：src/a.ts",
      args: "src/a.ts",
    });
  });

  it("没有占位符：参数追加到末尾；空参数不追加", () => {
    expect(expandCommand("/explain 这一段", commands).text).toBe(
      "解释这段代码\n\n这一段",
    );
    expect(expandCommand("/explain", commands).text).toBe("解释这段代码");
  });

  it("名字大小写不敏感", () => {
    expect(findCommand("REVIEW", commands)?.name).toBe("review");
    expect(expandCommand("/Review x", commands).text).toBe("请审查以下改动：x");
  });

  it("认不出的名字：原样返回（不吞用户输入）", () => {
    const result = expandCommand("/nope 参数", commands);
    expect(result.text).toBe("/nope 参数");
    expect(result.command).toBeUndefined();
  });

  it("不是命令形态的输入：原样返回", () => {
    expect(expandCommand("普通消息", commands).text).toBe("普通消息");
  });
});

describe("输入提示", () => {
  it("正在敲 / 时提示；敲完带参数后不再提示；非命令输入不提示", () => {
    expect(shouldSuggestCommands("/")).toBe(true);
    expect(shouldSuggestCommands("/re")).toBe(true);
    expect(shouldSuggestCommands("/review ")).toBe(false);
    expect(shouldSuggestCommands("你好")).toBe(false);
  });
});
