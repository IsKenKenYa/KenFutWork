import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SANDBOX_ROOT,
  resolveSandboxDir,
  sanitizeCanvasIdForPath,
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
