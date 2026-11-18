import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SANDBOX_ROOT,
  resolveSandboxDir,
  resolveSandboxScopeId,
  sanitizeCanvasIdForPath,
  withBoundWorkDir,
} from "./sandbox-dir.js";

const CANVAS_ID = "beb5095b-de61-4b3e-a376-501b9905344c";

describe("画布 → 沙箱目录解析", () => {
  it("缺省落 <sandboxRoot>/<canvasId>", () => {
    expect(resolveSandboxDir(CANVAS_ID)).toBe(
      resolveSandboxDir(CANVAS_ID, DEFAULT_SANDBOX_ROOT),
    );
  });

  /**
   * 产品决策 2026-09-14：沙箱改名并用**相对路径**——落点由入口定为
   * `<项目根（dev）/ exe 安装目录（打包）>/tmp/sandbox/<画布UUID>`，
   * 代码里不再钉死带盘符的绝对路径或旧名 `loomic-sandbox`（回归护栏）。
   */
  it("缺省根是相对路径 tmp/sandbox，不再叫 loomic-sandbox", () => {
    expect(DEFAULT_SANDBOX_ROOT).toBe("tmp/sandbox");
    expect(resolveSandboxDir(CANVAS_ID)).toBe(
      resolve("tmp/sandbox", CANVAS_ID),
    );
    expect(resolveSandboxDir(CANVAS_ID)).not.toContain("loomic-sandbox");
  });

  it("路径穿越被清洗，目录不会逃出根目录", () => {
    const root = resolve("C:/tmp/root");
    const dir = resolveSandboxDir("../../etc/passwd", "C:/tmp/root");
    expect(dir.startsWith(root)).toBe(true);
    expect(dir).toBe(
      resolve(root, sanitizeCanvasIdForPath("../../etc/passwd")),
    );
  });

  /**
   * 产品决策 2026-09-14：工作目录和真实电脑环境做映射（暂时不用沙箱）。
   * 映射存在时必须直接落真实目录——若仍拼 <root>/<canvasId>，用户选了目录
   * 也看不到文件落在哪（回归护栏）。
   */
  it("真实目录映射优先于根目录拼接", () => {
    const dir = resolveSandboxDir(
      CANVAS_ID,
      "C:/tmp/root",
      "D:\\Desktop\\test",
    );
    expect(dir).not.toContain(sanitizeCanvasIdForPath(CANVAS_ID));
    expect(dir.toLowerCase()).toContain("desktop");
    expect(dir.toLowerCase()).toContain("test");
  });

  it("映射为空白字符串时回落到缺省沙箱", () => {
    expect(resolveSandboxDir(CANVAS_ID, undefined, "   ")).toBe(
      resolveSandboxDir(CANVAS_ID),
    );
  });
});

/**
 * 沙箱目录名必须落在**画布 UUID** 上。
 *
 * 回归背景（2026-09-16 实测）：无工作目录的 Code 会话，客户端只有会话 UUID，
 * 会把 canvasId 发成会话 id → 沙箱落到 `tmp/sandbox/<会话UUID>`，
 * 而用户要求的是 `tmp/sandbox/<画布UUID|项目UUID>`。
 */
describe("resolveSandboxScopeId（沙箱作用域 = 画布 UUID）", () => {
  it("客户端给的是会话作用域：换成会话的真实画布", () => {
    expect(
      resolveSandboxScopeId({
        conversationId: "conv-1",
        requestedCanvasId: "conv-1",
        sessionCanvasId: "canvas-9",
      }),
    ).toBe("canvas-9");
  });

  it("客户端给的是项目主画布：一律不动（正常项目作用域）", () => {
    expect(
      resolveSandboxScopeId({
        conversationId: "conv-1",
        requestedCanvasId: "canvas-project",
        sessionCanvasId: "canvas-9",
      }),
    ).toBeUndefined();
  });

  it("解析不出会话画布：不覆盖（宁可保持原状也别乱指）", () => {
    expect(
      resolveSandboxScopeId({
        conversationId: "conv-1",
        requestedCanvasId: "conv-1",
        sessionCanvasId: null,
      }),
    ).toBeUndefined();
  });
});

describe("withBoundWorkDir（项目绑定目录 → env 画布映射）", () => {
  it("绑定存在时并进画布映射，并覆盖同名环境变量映射", () => {
    const env = { canvasWorkDirs: { c1: "/env/c1", c2: "/env/c2" } };
    const merged = withBoundWorkDir(env, "c1", "/bound/c1");
    expect(merged.canvasWorkDirs).toEqual({
      c1: "/bound/c1",
      c2: "/env/c2",
    });
    // 不改原对象（env 在进程内共享，就地改写会污染其它画布）
    expect(env.canvasWorkDirs.c1).toBe("/env/c1");
  });

  it("没有绑定 / 没有画布时原样返回", () => {
    const env = { canvasWorkDirs: { c1: "/env/c1" } };
    expect(withBoundWorkDir(env, "c1", null)).toBe(env);
    expect(withBoundWorkDir(env, undefined, "/bound/c1")).toBe(env);
  });

  it("原来没有映射时也能建立（env.canvasWorkDirs 缺省 undefined）", () => {
    const merged = withBoundWorkDir(
      { sandboxRoot: "/root" },
      "c1",
      "/bound/c1",
    );
    expect(merged).toEqual({
      sandboxRoot: "/root",
      canvasWorkDirs: { c1: "/bound/c1" },
    });
    // 结果仍然能被 resolveSandboxDir 消费（绑定目录优先于根目录拼接）
    expect(
      resolveSandboxDir("c1", merged.sandboxRoot, merged.canvasWorkDirs?.c1),
    ).toBe(resolve("/bound/c1"));
  });
});
