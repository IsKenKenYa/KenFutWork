import { describe, expect, it } from "vitest";

import { loadServerEnv, parseCanvasWorkDirs } from "./env.js";

describe("本地实例配置退役", () => {
  it("插件目录注入只由统一env读取，显式测试覆盖优先", () => {
    expect(
      loadServerEnv({}, { KENFUTWORK_PLUGINS_DIR: " /tmp/plugins " })
        .pluginsDir,
    ).toBe("/tmp/plugins");
    expect(
      loadServerEnv(
        { pluginsDir: "/tmp/injected" },
        { KENFUTWORK_PLUGINS_DIR: "/tmp/from-env" },
      ).pluginsDir,
    ).toBe("/tmp/injected");
  });
  it("旧账户、计费与加密配置不再进入运行时，供应商及worker配置继续读取", () => {
    const env = loadServerEnv(
      {},
      {
        KENFUTWORK_AUTH_DRIVER: "managed",
        KENFUTWORK_CREDENTIAL_SECRET: "retired-master-secret",
        LEMONSQUEEZY_API_KEY: "retired-payment-key",
        LEMONSQUEEZY_STORE_ID: "retired-store",
        LEMONSQUEEZY_WEBHOOK_SECRET: "retired-hook",
        LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY: "retired-variant",
        OPENAI_API_KEY: "provider-key",
        KENFUTWORK_SANDBOX_ROOT: "/owned/sandbox",
        KENFUTWORK_CHECKPOINT_ROOT: "/owned/checkpoints",
        WORKER_POLL_INTERVAL_MS: "750",
      },
    );
    expect(env.openAIApiKey).toBe("provider-key");
    expect(env.sandboxRoot).toBe("/owned/sandbox");
    expect(env.checkpointRoot).toBe("/owned/checkpoints");
    expect(env.workerPollIntervalMs).toBe(750);
    expect(
      Object.keys(env).some(
        (key) =>
          key === "authDriver" ||
          key === "credentialSecret" ||
          key.startsWith("lemonSqueezy"),
      ),
    ).toBe(false);
    expect(JSON.stringify(env)).not.toContain("retired-");
  });

  it("新本机接入与迁移治理从统一env解析，不创建第二套默认值", () => {
    const env = loadServerEnv(
      {},
      {
        KENFUTWORK_LOCAL_ACCESS_TICKET_TTL_MS: "5000",
        KENFUTWORK_LOCAL_ACCESS_SESSION_MAX_AGE_MS: "60000",
        KENFUTWORK_LOCAL_DATA_MIGRATION_POLL_MS: "50",
      },
    );
    expect(env.agentGovernance).toMatchObject({
      localAccessTicketTtlMs: 5000,
      localAccessSessionMaxAgeMs: 60000,
      localDataMigrationPollMs: 50,
    });
  });
});

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

/**
 * flow 前端地址（工作台 iframe src + postMessage origin 白名单）。
 * 带路径/写错协议只会在运行期暴露成「iframe 打不开 / 消息被丢」，所以启动期 fail loud。
 */
describe("KENFUTWORK_FLOW_FRONTEND_URL 解析", () => {
  it("空值返回 undefined；合法 origin 原样收下", () => {
    expect(loadServerEnv({}, {}).flowFrontendUrl).toBeUndefined();
    expect(
      loadServerEnv(
        {},
        { KENFUTWORK_FLOW_FRONTEND_URL: "http://127.0.0.1:8080" },
      ).flowFrontendUrl,
    ).toBe("http://127.0.0.1:8080");
    // 带尾斜杠归一为 origin（host:port 相同即可，避免两份写法两种白名单）
    expect(
      loadServerEnv(
        {},
        { KENFUTWORK_FLOW_FRONTEND_URL: "http://127.0.0.1:8080/" },
      ).flowFrontendUrl,
    ).toBe("http://127.0.0.1:8080");
  });

  it("带路径 / 查询 / 锚点 → fail loud（只收 origin）", () => {
    expect(() =>
      loadServerEnv(
        {},
        { KENFUTWORK_FLOW_FRONTEND_URL: "http://127.0.0.1:8080/canvas" },
      ),
    ).toThrow(/origin/);
    expect(() =>
      loadServerEnv(
        {},
        { KENFUTWORK_FLOW_FRONTEND_URL: "http://127.0.0.1:8080/?x=1" },
      ),
    ).toThrow(/origin/);
  });

  it("非 http(s) 或非法 URL → fail loud", () => {
    expect(() =>
      loadServerEnv(
        {},
        { KENFUTWORK_FLOW_FRONTEND_URL: "ftp://127.0.0.1:8080" },
      ),
    ).toThrow(/http\/https/);
    expect(() =>
      loadServerEnv({}, { KENFUTWORK_FLOW_FRONTEND_URL: "不是地址" }),
    ).toThrow(/合法 URL/);
  });
});
