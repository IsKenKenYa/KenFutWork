import { describe, expect, it } from "vitest";

import { loadServerEnv, parseCanvasWorkDirs } from "./env.js";

describe("LOOMIC_CANVAS_WORK_DIRS 解析", () => {
  it("空值返回 undefined", () => {
    expect(parseCanvasWorkDirs(undefined)).toBeUndefined();
    expect(parseCanvasWorkDirs("")).toBeUndefined();
    expect(parseCanvasWorkDirs("   ")).toBeUndefined();
  });

  it("合法映射逐条归一化（去空白）", () => {
    const parsed = parseCanvasWorkDirs(
      '{" canvas-1 ":" D:/Desktop/test "}',
    );
    expect(parsed).toEqual({ "canvas-1": "D:/Desktop/test" });
  });

  /** fail loud：结构非法启动期报错，不允许静默降级回沙箱。 */
  it("非法结构 fail loud", () => {
    expect(() => parseCanvasWorkDirs("not-json")).toThrow();
    expect(() => parseCanvasWorkDirs("[1,2]")).toThrow(/JSON object/);
    expect(() => parseCanvasWorkDirs('{"a": 1}')).toThrow(/required/);
    expect(() => parseCanvasWorkDirs('{"": "D:/x"}')).toThrow(/required/);
    expect(parseCanvasWorkDirs("{}")).toBeUndefined();
  });

  it("loadServerEnv 把映射装入 env（overrides 优先）", () => {
    const fromSource = loadServerEnv(
      {},
      {
        LOOMIC_CANVAS_WORK_DIRS: '{"c1":"D:/Desktop/test"}',
      } as NodeJS.ProcessEnv,
    );
    expect(fromSource.canvasWorkDirs).toEqual({ c1: "D:/Desktop/test" });

    const overridden = loadServerEnv({
      canvasWorkDirs: { c2: "E:/work" },
    });
    expect(overridden.canvasWorkDirs).toEqual({ c2: "E:/work" });
  });
});
