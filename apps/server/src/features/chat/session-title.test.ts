import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  stripLeadingDirectiveBlocks,
} from "./session-title.js";

describe("stripLeadingDirectiveBlocks", () => {
  it("剥掉工作目录提示块与空行，保留正文", () => {
    const prompt =
      "【目录名称：test（仅用户标注的命名提示；本机路径对服务端不可达，读写发生在沙箱工作区，路径以工具返回为准）】\n\n帮我创建 hello.py";
    expect(stripLeadingDirectiveBlocks(prompt)).toBe("帮我创建 hello.py");
  });

  it("剥掉连续多个指令块（目录提示 + 思考强度）", () => {
    const prompt =
      "【目录名称：test（略）】\n【思考强度：high】\n只回复两个字：收到";
    expect(stripLeadingDirectiveBlocks(prompt)).toBe("只回复两个字：收到");
  });

  it("正文以【开头但不是整行成块时不误剥", () => {
    expect(stripLeadingDirectiveBlocks("【重要】请保留这个标记")).toBe(
      "【重要】请保留这个标记",
    );
  });

  it("没有指令块时原样返回（trim）", () => {
    expect(stripLeadingDirectiveBlocks("普通任务描述")).toBe("普通任务描述");
  });

  it("纯指令块输入返回空串", () => {
    expect(stripLeadingDirectiveBlocks("【目录名称：test（略）】")).toBe("");
  });
});

describe("deriveSessionTitle", () => {
  it("带目录提示的 prompt 派生出正文标题（历史泄漏场景）", () => {
    const prompt =
      "【目录名称：test（仅用户标注的命名提示；本机路径对服务端不可达，读写发生在沙箱工作区，路径以工具返回为准）】\n\n在当前工作目录创建 Python 项目 kfw-demo";
    expect(deriveSessionTitle(prompt)).toBe(
      "在当前工作目录创建 Python 项目 kfw-",
    );
  });

  it("普通 prompt 取前 24 字", () => {
    expect(deriveSessionTitle("只回复两个字：收到")).toBe("只回复两个字：收到");
    expect(deriveSessionTitle("a".repeat(30))).toBe("a".repeat(24));
  });

  it("剥完为空时回落缺省标题", () => {
    expect(deriveSessionTitle("【思考强度：high】")).toBe(
      DEFAULT_SESSION_TITLE,
    );
    expect(deriveSessionTitle("   ")).toBe(DEFAULT_SESSION_TITLE);
  });
});
