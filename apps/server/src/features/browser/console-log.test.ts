import { describe, expect, it } from "vitest";

import {
  createConsoleBuffer,
  formatConsoleCall,
  formatEvalResult,
  formatExceptionThrown,
  formatLogEntry,
  formatRemoteValue,
} from "./console-log.js";

/**
 * 悬浮控制台的数据层：把 CDP 的控制台事件折成一行行文本。
 *
 * 折错的表现很隐蔽——用户看到的只是「控制台里那行字不对」（`[object Object]`、栈没了、
 * 报错被当成普通日志），所以这里逐种取值形态钉住。
 */
describe("值 → 一行文本", () => {
  it("基本类型照值显示（字符串不加引号，与 DevTools 观感一致）", () => {
    expect(formatRemoteValue({ type: "string", value: "hi" })).toBe("hi");
    expect(formatRemoteValue({ type: "number", value: 42 })).toBe("42");
    expect(formatRemoteValue({ type: "boolean", value: false })).toBe("false");
    expect(formatRemoteValue({ type: "undefined" })).toBe("undefined");
  });

  it("特殊数值走 unserializableValue（NaN / -0 / Infinity / 1n）", () => {
    expect(
      formatRemoteValue({ type: "number", unserializableValue: "NaN" }),
    ).toBe("NaN");
    expect(
      formatRemoteValue({ type: "bigint", unserializableValue: "1n" }),
    ).toBe("1n");
  });

  it("对象/数组用一行预览（不然只能看到 Object）", () => {
    expect(
      formatRemoteValue({
        type: "object",
        description: "Object",
        preview: {
          properties: [
            { name: "a", type: "number", value: 1 },
            { name: "b", type: "string", value: "x" },
          ],
        },
      }),
    ).toBe('{ a: 1, b: "x" }');
  });

  it("预览里嵌套对象用 valuePreview.description；超过 6 个属性折成省略", () => {
    expect(
      formatRemoteValue({
        type: "object",
        preview: {
          properties: [
            { name: "deep", valuePreview: { description: "Object" } },
            ...Array.from({ length: 7 }, (_, index) => ({
              name: `k${index}`,
              type: "number",
              value: index,
            })),
          ],
        },
      }),
    ).toBe("{ deep: Object, k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, … }");
  });

  it("没有预览的对象退回 description；函数给 description", () => {
    expect(formatRemoteValue({ type: "object", description: "Object" })).toBe(
      "Object",
    );
    expect(
      formatRemoteValue({ type: "function", description: "ƒ foo()" }),
    ).toBe("ƒ foo()");
  });

  it("undefined 值不炸", () => {
    expect(formatRemoteValue(undefined)).toBe("undefined");
  });
});

describe("页面里的 console.* → 一行", () => {
  it("多个参数用空格连起来", () => {
    expect(
      formatConsoleCall(
        {
          type: "log",
          args: [
            { type: "string", value: "a" },
            {
              type: "object",
              preview: {
                properties: [{ name: "b", type: "number", value: 1 }],
              },
            },
          ],
        },
        "2026-09-18T00:00:00.000Z",
      ),
    ).toMatchObject({ level: "log", text: "a { b: 1 }", source: "console" });
  });

  it("warning→warn、error/assert→error、info/debug→info", () => {
    const at = "2026-09-18T00:00:00.000Z";
    const level = (type: string) =>
      formatConsoleCall({ type, args: [] }, at).level;
    expect(level("warning")).toBe("warn");
    expect(level("error")).toBe("error");
    expect(level("assert")).toBe("error");
    expect(level("info")).toBe("info");
    expect(level("debug")).toBe("info");
    expect(level("log")).toBe("log");
    expect(level("table")).toBe("log");
  });
});

describe("未捕获异常 / 浏览器日志", () => {
  it("异常优先给带调用栈的 description，并附上报位置（行号从 0 起要 +1）", () => {
    const message = formatExceptionThrown(
      {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Error: boom\n    at <anonymous>:1:1" },
          url: "https://a.com/app.js",
          lineNumber: 41,
          columnNumber: 7,
        },
      },
      "2026-09-18T00:00:00.000Z",
    );
    expect(message.level).toBe("error");
    expect(message.source).toBe("exception");
    expect(message.text).toContain("Error: boom");
    expect(message.text).toContain("https://a.com/app.js:42");
  });

  it("没有 description 时退回 text（不显示空白行）", () => {
    expect(
      formatExceptionThrown(
        { exceptionDetails: { text: "Uncaught (in promise)" } },
        "2026-09-18T00:00:00.000Z",
      ).text,
    ).toBe("Uncaught (in promise)");
  });

  it("浏览器日志带 URL；level 映射到三档", () => {
    expect(
      formatLogEntry(
        {
          entry: {
            level: "error",
            text: "Failed to load resource",
            url: "https://a.com/x.js",
          },
        },
        "2026-09-18T00:00:00.000Z",
      ),
    ).toMatchObject({
      level: "error",
      source: "log",
      text: "Failed to load resource (https://a.com/x.js)",
    });
    expect(
      formatLogEntry({ entry: { level: "verbose", text: "x" } }, "at").level,
    ).toBe("info");
  });
});

describe("自己敲的表达式的结果", () => {
  it("成功：格式化成一行（对象给预览）", () => {
    expect(
      formatEvalResult(
        { result: { type: "string", value: "Example Domain" } },
        "2026-09-18T00:00:00.000Z",
      ),
    ).toMatchObject({ level: "log", source: "input", text: "Example Domain" });
  });

  it("页面里抛错：当错误显示（带栈）", () => {
    expect(
      formatEvalResult(
        {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "ReferenceError: nope is not defined" },
          },
        },
        "2026-09-18T00:00:00.000Z",
      ),
    ).toMatchObject({
      level: "error",
      source: "input",
      text: "ReferenceError: nope is not defined",
    });
  });
});

describe("环形缓冲（按 seq 增量取）", () => {
  it("seq 单调递增；since 只取更新的那条", () => {
    const buffer = createConsoleBuffer(10);
    const first = buffer.push({
      level: "log",
      text: "a",
      at: "t",
      source: "console",
    });
    const second = buffer.push({
      level: "log",
      text: "b",
      at: "t",
      source: "console",
    });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(buffer.since(1).map((m) => m.text)).toEqual(["b"]);
    expect(buffer.since(2)).toEqual([]);
    expect(buffer.latestSeq()).toBe(2);
  });

  it("超过上限丢最旧的（内存不随时间涨）", () => {
    const buffer = createConsoleBuffer(3);
    for (const text of ["1", "2", "3", "4"]) {
      buffer.push({ level: "log", text, at: "t", source: "console" });
    }
    expect(buffer.since(0).map((m) => m.text)).toEqual(["2", "3", "4"]);
    // seq 不回退：客户端按它增量拉，回退会漏消息
    expect(buffer.latestSeq()).toBe(4);
  });

  it("一次最多给 200 条（界面不会被一次拉爆）", () => {
    const buffer = createConsoleBuffer(500);
    for (let index = 0; index < 250; index += 1) {
      buffer.push({
        level: "log",
        text: `${index}`,
        at: "t",
        source: "console",
      });
    }
    expect(buffer.since(0)).toHaveLength(200);
  });

  it("clear 清空消息但保留 seq（清空后新消息的 seq 继续涨）", () => {
    const buffer = createConsoleBuffer(10);
    buffer.push({ level: "log", text: "a", at: "t", source: "console" });
    buffer.clear();
    expect(buffer.since(0)).toEqual([]);
    const next = buffer.push({
      level: "log",
      text: "b",
      at: "t",
      source: "console",
    });
    expect(next.seq).toBe(2);
  });
});
