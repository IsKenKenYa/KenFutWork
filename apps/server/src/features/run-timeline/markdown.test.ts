import { describe, expect, it } from "vitest";
import { renderRunTimelineMarkdown, runTimelineFilename } from "./markdown.js";
import type { RunTimelineResult } from "./types.js";

const RUN_ID = "6ae844c1-4f62-42b2-9ee3-a03700000000";
const STARTED = "2026-11-04T00:00:00.000Z";
const COMPLETED = "2026-11-04T00:01:05.000Z";

function timeline(
  overrides: Partial<RunTimelineResult> = {},
): RunTimelineResult {
  return {
    run: {
      runId: RUN_ID,
      model: "deepseek-v4",
      status: "completed",
      stopReason: "completed",
      errorCode: null,
      errorMessage: null,
      startedAt: STARTED,
      completedAt: COMPLETED,
      usage: { inputTokens: 1234, outputTokens: 567, costUsd: 0.012345 },
    },
    entries: [],
    ...overrides,
  };
}

describe("renderRunTimelineMarkdown", () => {
  it("头部包含状态、模型、时长与用量", () => {
    const markdown = renderRunTimelineMarkdown(timeline());

    expect(markdown).toContain("# 运行时间线");
    expect(markdown).toContain(`- 状态：completed`);
    expect(markdown).toContain("- 模型：deepseek-v4");
    expect(markdown).toContain("- 时长：1m5s");
    expect(markdown).toContain("输入 1234 · 输出 567 · 成本 $0.012345");
  });

  it("成本未上报与用量未统计分开表达", () => {
    const noCost = renderRunTimelineMarkdown(
      timeline({
        run: {
          ...timeline().run,
          usage: { inputTokens: 1, outputTokens: 2, costUsd: null },
        },
      }),
    );
    expect(noCost).toContain("成本未上报");

    const noUsage = renderRunTimelineMarkdown(
      timeline({
        run: { ...timeline().run, usage: null },
      }),
    );
    expect(noUsage).toContain("- 用量：未统计");
  });

  it("仍在运行时不编造完成时间与时长", () => {
    const markdown = renderRunTimelineMarkdown(
      timeline({
        run: {
          ...timeline().run,
          status: "running",
          completedAt: null,
          usage: null,
        },
      }),
    );

    expect(markdown).toContain("- 完成：仍在运行或未收尾");
    expect(markdown).toContain("- 时长：—");
  });

  it("失败代码与失败原因单独列出", () => {
    const markdown = renderRunTimelineMarkdown(
      timeline({
        run: {
          ...timeline().run,
          status: "failed",
          errorCode: "run_failed",
          errorMessage: "上游拒绝",
        },
      }),
    );

    expect(markdown).toContain("- 失败代码：run_failed");
    expect(markdown).toContain("- 失败原因：上游拒绝");
  });

  it("条目带上类别、状态、耗时与摘要", () => {
    const markdown = renderRunTimelineMarkdown(
      timeline({
        entries: [
          {
            kind: "tool",
            seq: 1,
            at: STARTED,
            title: "Read",
            name: "Read",
            status: "success",
            durationMs: 2_000,
            detail: "src/a.ts",
          },
          {
            kind: "subagent",
            seq: 2,
            at: COMPLETED,
            title: "explorer · 查依赖",
            agentName: "explorer",
            status: "error",
            detail: "失败",
          },
        ],
      }),
    );

    expect(markdown).toContain("**[工具]** Read · 成功 · 2.0s · src/a.ts");
    expect(markdown).toContain(
      "**[子代理]** explorer · 查依赖 （子代理：explorer） · 失败 · 失败",
    );
  });

  it("转义换行、竖线、反引号与方括号，避免破坏列表", () => {
    const markdown = renderRunTimelineMarkdown(
      timeline({
        entries: [
          {
            kind: "tool",
            seq: 1,
            at: STARTED,
            title: "Bash",
            detail: "a | b\n`rm -rf` [x] <y>",
          },
        ],
      }),
    );

    expect(markdown).toContain("a \\| b");
    expect(markdown).toContain("\\`rm -rf\\`");
    expect(markdown).toContain("\\[x\\]");
    expect(markdown).toContain("&lt;y&gt;");
    expect(markdown).not.toContain("[x] <y>");
  });

  it("没有条目时写明这一轮没有留下事件", () => {
    expect(renderRunTimelineMarkdown(timeline())).toContain(
      "这一轮没有留下可回看的事件。",
    );
  });

  it("毫秒级耗时按毫秒输出", () => {
    const markdown = renderRunTimelineMarkdown(
      timeline({
        entries: [
          {
            kind: "tool",
            seq: 1,
            at: STARTED,
            title: "Grep",
            durationMs: 35,
          },
        ],
      }),
    );

    expect(markdown).toContain("· 35ms");
  });

  it("导出文件名过滤路径分隔符与引号", () => {
    expect(runTimelineFilename(RUN_ID)).toBe(
      `run-${RUN_ID}-timeline.md`,
    );
    expect(runTimelineFilename('a/b"c')).toBe("run-a_b_c-timeline.md");
    expect(runTimelineFilename("")).toBe("run-unknown-timeline.md");
  });
});
