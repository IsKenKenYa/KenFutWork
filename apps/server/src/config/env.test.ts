import { describe, expect, it } from "vitest";

import { loadServerEnv, parseCanvasWorkDirs } from "./env.js";

describe("KENFUTWORK_CANVAS_WORK_DIRS 解析", () => {
  it("空值返回 undefined", () => {
    expect(parseCanvasWorkDirs(undefined)).toBeUndefined();
    expect(parseCanvasWorkDirs("")).toBeUndefined();
    expect(parseCanvasWorkDirs("   ")).toBeUndefined();
  });

  it("合法映射逐条归一化（去空白）", () => {
    const parsed = parseCanvasWorkDirs('{" canvas-1 ":" D:/Desktop/test "}');
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
    const fromSource = loadServerEnv({}, {
      KENFUTWORK_CANVAS_WORK_DIRS: '{"c1":"D:/Desktop/test"}',
    } as NodeJS.ProcessEnv);
    expect(fromSource.canvasWorkDirs).toEqual({ c1: "D:/Desktop/test" });

    const overridden = loadServerEnv({
      canvasWorkDirs: { c2: "E:/work" },
    });
    expect(overridden.canvasWorkDirs).toEqual({ c2: "E:/work" });
  });
});

/**
 * 部署形态 → 第三方插件开关（云端默认禁止跑租户代码；要开必须显式声明）。
 * 这是安全口径，不是 UI 提示——拼错形态/开关值必须 fail loud 或落到安全默认。
 */
describe("部署形态与第三方插件开关", () => {
  it("缺省 local：允许第三方插件", () => {
    const env = loadServerEnv({}, {});
    expect(env.deployment).toBe("local");
    expect(env.allowThirdPartyPlugins).toBe(true);
  });

  it("cloud：默认禁止；显式 true 才开", () => {
    expect(
      loadServerEnv({}, { KENFUTWORK_DEPLOYMENT: "cloud" })
        .allowThirdPartyPlugins,
    ).toBe(false);
    expect(
      loadServerEnv(
        {},
        {
          KENFUTWORK_DEPLOYMENT: "cloud",
          KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS: "true",
        },
      ).allowThirdPartyPlugins,
    ).toBe(true);
  });

  it("显式 false 在 self-hosted 下同样生效（运维可手动收紧）", () => {
    expect(
      loadServerEnv(
        {},
        {
          KENFUTWORK_DEPLOYMENT: "self-hosted",
          KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS: "false",
        },
      ).allowThirdPartyPlugins,
    ).toBe(false);
  });

  it("形态值非法：fail loud（静默回落会改变安全口径）", () => {
    expect(() => loadServerEnv({}, { KENFUTWORK_DEPLOYMENT: "prd" })).toThrow(
      /KENFUTWORK_DEPLOYMENT/,
    );
  });
});
