import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createPluginRegistryService } from "./plugin-registry-service.js";

/**
 * 米家插件测试。分两层：
 *
 * 1. **纯函数**：nonce / signedNonce / RC4 / 签名字符串 / 规格→控件模型。
 *    这些用「资产向量（golden vector）+ 性质」锁行为，防的是**日后改坏**（协议细节本身
 *    无法在本机对着真米家云验证——没有账号，且接口是社区逆向的私有接口）。
 * 2. **全链路**：真的走门禁安装到临时目录，再用**假米家云**（服务端侧复算签名、RC4 解密
 *    请求、加密响应）跑通 登录 → 设备列表 → 控制，以及未连接 / 未登录 / 跨工作区隔离等错误面。
 *
 * 假云与客户端共用同一份 crypto 原语，因此它验证的是**收发一致性**（签名口径、参数顺序、
 * 加解密方向），不构成对真实服务的验证——这一点在插件 README 与台账里都写明了。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const MIHOME_DIR = path.join(REPO_ROOT, "plugins", "mihome");

interface MicloudModule {
  generateNonce: (now?: number) => string;
  computeSignedNonce: (ssecurity: string, nonce: string) => string;
  rc4: (key: Uint8Array, data: Uint8Array) => Uint8Array;
  rc4EncryptBase64: (keyBase64: string, plaintext: string) => string;
  buildSignature: (input: {
    method: string;
    uri: string;
    params?: Record<string, string>;
    signedNonce: string;
  }) => string;
  parseAccountPayload: (text: string) => Record<string, unknown>;
}

interface DeviceModelModule {
  propertySlug: (type: string) => string;
  controlKindOf: (property: {
    writable: boolean;
    format?: string;
    valueRange?: unknown;
    valueList?: unknown;
  }) => string;
  selectProperties: (
    spec: unknown,
    options?: { limit?: number },
  ) => Array<Record<string, unknown>>;
  mergeValues: (
    properties: Array<Record<string, unknown>>,
    values: Array<{ siid: number; piid: number; value: unknown }>,
  ) => Array<Record<string, unknown>>;
  describeDevice: (raw: Record<string, unknown>) => Record<string, unknown>;
}

async function loadPluginModule<ModuleShape>(
  relative: string,
): Promise<ModuleShape> {
  const url = pathToFileURL(path.join(MIHOME_DIR, relative)).href;
  return (await import(/* @vite-ignore */ url)) as ModuleShape;
}

function b64decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

// === 假米家云 ===

const FAKE_SSECURITY = Buffer.from(
  "fake-ssecurity-payload-32-bytes!!",
).toString("base64");

interface FakeCloudOptions {
  micloud: MicloudModule;
  /** 第一次轮询故意「未扫码」，用来覆盖 pending 分支。 */
  pollPendingFirst?: boolean;
}

function fakeXiaomiCloud(options: FakeCloudOptions) {
  const { micloud } = options;
  const pollPendingFirst = options.pollPendingFirst ?? true;
  const state = {
    polls: 0,
    signedRequests: 0,
    badSignature: 0,
    setCalls: [] as Array<Record<string, unknown>>,
    /** 设备属性真值：`did:siid.piid` → value */
    values: new Map<string, unknown>([
      ["d1:2.1", true],
      ["d1:2.2", 60],
      ["d1:3.1", 23.5],
      ["d2:2.1", false],
    ]),
  };

  function json(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function accountJson(payload: unknown): Response {
    return json(`&&&START&&&${JSON.stringify(payload)}`);
  }

  /** 响应体与请求体用同一套 RC4 口径加密（服务端侧方向相反）。 */
  function encryptPayload(signedNonce: string, payload: unknown): string {
    return micloud.rc4EncryptBase64(signedNonce, JSON.stringify(payload));
  }

  function handleAppRequest(url: URL, init: RequestInit): Response {
    const params = new URLSearchParams(String(init.body ?? ""));
    const nonce = params.get("_nonce") ?? "";
    const signedNonce = micloud.computeSignedNonce(FAKE_SSECURITY, nonce);
    const cipher: Record<string, string> = {};
    const plain: Record<string, string> = {};
    for (const [key, value] of params) {
      if (key === "signature" || key === "ssecurity" || key === "_nonce")
        continue;
      cipher[key] = value;
      plain[key] = Buffer.from(
        micloud.rc4(b64decode(signedNonce), b64decode(value)),
      ).toString("utf8");
    }
    const uri = url.pathname.replace(/^\/app/, "");

    // 复算两个签名：rc4_hash__ 签的是明文业务参数，signature 签的是密文参数
    const hashInput: Record<string, string> = { ...plain };
    delete hashInput.rc4_hash__;
    const expectedHash = micloud.buildSignature({
      method: "POST",
      uri,
      params: hashInput,
      signedNonce,
    });
    const expectedSignature = micloud.buildSignature({
      method: "POST",
      uri,
      params: cipher,
      signedNonce,
    });
    state.signedRequests += 1;
    if (
      expectedHash !== plain.rc4_hash__ ||
      expectedSignature !== params.get("signature") ||
      params.get("ssecurity") !== FAKE_SSECURITY
    ) {
      state.badSignature += 1;
      // 真实云端在签名不符时回的是**明文** JSON（不是加密体）——解码顺序必须容得下这种响应
      return json(JSON.stringify({ code: 401, message: "签名不符" }));
    }

    if (uri === "/home/device_list") {
      return json(
        encryptPayload(signedNonce, {
          code: 0,
          result: {
            list: [
              {
                did: "d1",
                name: "客厅灯",
                model: "test.light",
                isOnline: true,
                room_name: "客厅",
              },
              {
                did: "d2",
                name: "卧室插座",
                model: "test.light",
                isOnline: false,
              },
              {
                did: "d3",
                name: "未知型号设备",
                model: "ghost.model",
                isOnline: true,
              },
            ],
          },
        }),
      );
    }

    if (uri === "/miotspec/prop/get") {
      const wanted = JSON.parse(plain.params ?? "[]") as Array<{
        did: string;
        siid: number;
        piid: number;
      }>;
      const result = wanted.map((item) => ({
        ...item,
        code: 0,
        value:
          state.values.get(`${item.did}:${item.siid}.${item.piid}`) ?? null,
      }));
      return json(encryptPayload(signedNonce, { code: 0, result }));
    }

    if (uri === "/miotspec/prop/set") {
      const wanted = JSON.parse(plain.params ?? "[]") as Array<{
        did: string;
        siid: number;
        piid: number;
        value: unknown;
      }>;
      for (const item of wanted) {
        state.setCalls.push(item);
        state.values.set(`${item.did}:${item.siid}.${item.piid}`, item.value);
      }
      return json(
        encryptPayload(signedNonce, {
          code: 0,
          result: wanted.map((item) => ({ ...item, code: 0 })),
        }),
      );
    }

    return json(encryptPayload(signedNonce, { code: -1, message: "未知端点" }));
  }

  const fetchImpl = async (
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? new URL(input, "https://fake.local") : input;
    if (url.pathname === "/longPolling/loginUrl") {
      return accountJson({
        qr: "https://account.example/qr.png",
        lp: "https://account.example/lp/abc",
        timeout: 120,
      });
    }
    if (url.pathname.startsWith("/lp/")) {
      state.polls += 1;
      if (pollPendingFirst && state.polls < 2) {
        return accountJson({ code: 0, timeInterval: 1 });
      }
      return accountJson({
        ssecurity: FAKE_SSECURITY,
        userId: "u-1",
        location: `${url.origin}/sts?sign=xyz`,
      });
    }
    if (url.pathname === "/sts") {
      const headers = new Headers();
      headers.append("set-cookie", "serviceToken=TOKEN-1; Path=/");
      headers.append("set-cookie", "cUserId=C-1; Path=/");
      headers.append("set-cookie", "passToken=P-1; Path=/");
      headers.append("set-cookie", "userId=u-1; Path=/");
      return new Response("", { status: 200, headers });
    }
    if (url.hostname === "miot-spec.org") {
      if (url.pathname === "/miot-spec-v2/instances") {
        return new Response(
          JSON.stringify({
            instances: [
              {
                model: "test.light",
                type: "urn:miot-spec-v2:device:light:0000A001:test-light:1",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          services: [
            {
              iid: 2,
              properties: [
                {
                  iid: 1,
                  type: "urn:miot-spec-v2:property:on:00000006:test-light:1",
                  description: "开关",
                  format: "bool",
                  access: ["read", "write"],
                },
                {
                  iid: 2,
                  type: "urn:miot-spec-v2:property:brightness:0000000E:test-light:1",
                  description: "亮度",
                  format: "uint8",
                  access: ["read", "write"],
                  "value-range": [1, 100, 1],
                },
              ],
            },
            {
              iid: 3,
              properties: [
                {
                  iid: 1,
                  type: "urn:miot-spec-v2:property:temperature:00000020:test-light:1",
                  description: "温度",
                  format: "float",
                  access: ["read"],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.startsWith("/app/")) {
      return handleAppRequest(url, init);
    }
    return new Response("not found", { status: 404 });
  };

  return { fetchImpl, state };
}

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

// === 1. 纯函数 ===

describe("米家插件：云客户端原语", () => {
  it("nonce = 8 随机字节 + 分钟数（变长大端），每次不同且可解回分钟", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const now = 1_700_000_000_000; // 固定时刻
    const nonce = micloud.generateNonce(now);
    const bytes = b64decode(nonce);

    expect(bytes.length).toBeGreaterThanOrEqual(12 - 4 + 4);
    // 尾段是分钟数：用大端拼回来应与 Date.now()/60000 一致（忽略随机段）
    const minutes = Math.floor(now / 60000);
    const expectedTail: number[] = [];
    for (let shift = 24; shift >= 0; shift -= 8) {
      const byte = (minutes >>> shift) & 0xff;
      if (expectedTail.length > 0 || byte !== 0) expectedTail.push(byte);
    }
    expect([...bytes.slice(8)]).toEqual(expectedTail);
    expect(micloud.generateNonce(now)).not.toBe(nonce);
  });

  it("signedNonce = base64(sha256(b64decode(ssecurity) ‖ b64decode(nonce)))", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { createHash } = await import("node:crypto");
    const ssecurity = Buffer.from("ssecurity-bytes-for-test").toString(
      "base64",
    );
    const nonce = Buffer.from("nonce-bytes-for-test").toString("base64");
    const expected = Buffer.from(
      createHash("sha256")
        .update(
          Buffer.concat([
            Buffer.from(ssecurity, "base64"),
            Buffer.from(nonce, "base64"),
          ]),
        )
        .digest(),
    ).toString("base64");

    expect(micloud.computeSignedNonce(ssecurity, nonce)).toBe(expected);
  });

  it("RC4：加解密对称，且丢弃前 1024 字节（与不丢弃的实现不同）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const key = new Uint8Array(Buffer.from("rc4-key-32-bytes-padding-xxxxxxx"));
    const payload = new Uint8Array(Buffer.from("客厅灯 on=true", "utf8"));

    const cipher = micloud.rc4(key, payload);
    expect(Buffer.from(micloud.rc4(key, cipher)).toString("utf8")).toBe(
      "客厅灯 on=true",
    );
    expect(Buffer.from(cipher).toString("base64")).not.toBe("");

    // 标准 RC4（不丢字节）的输出与会丢字节的不同——若哪天有人「顺手简化」掉丢弃逻辑，这条会红
    const standard = standardRc4(key, payload);
    expect(Buffer.from(cipher).equals(standard)).toBe(false);
  });

  it("签名字符串：METHOD&uri&k=v…&signedNonce，按插入顺序不排序，空参数只留三段", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { createHash } = await import("node:crypto");
    const sha1 = (text: string) =>
      Buffer.from(createHash("sha1").update(text, "utf8").digest()).toString(
        "base64",
      );

    expect(
      micloud.buildSignature({
        method: "post",
        uri: "/home/device_list",
        params: { getVirtualModel: "true", getHuamiDevices: "1" },
        signedNonce: "SN",
      }),
    ).toBe(
      sha1("POST&/home/device_list&getVirtualModel=true&getHuamiDevices=1&SN"),
    );

    expect(
      micloud.buildSignature({
        method: "POST",
        uri: "/miotspec/prop/get",
        signedNonce: "SN",
      }),
    ).toBe(sha1("POST&/miotspec/prop/get&SN"));

    // 顺序敏感：换序结果必须不同（服务端按收到的顺序复算）
    expect(
      micloud.buildSignature({
        method: "POST",
        uri: "/x",
        params: { b: "2", a: "1" },
        signedNonce: "SN",
      }),
    ).not.toBe(
      micloud.buildSignature({
        method: "POST",
        uri: "/x",
        params: { a: "1", b: "2" },
        signedNonce: "SN",
      }),
    );
  });

  it("账号接口响应剥掉 &&&START&&& 前缀", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    expect(
      micloud.parseAccountPayload('&&&START&&&{"code":0,"result":"ok"}'),
    ).toEqual({ code: 0, result: "ok" });
    expect(() => micloud.parseAccountPayload("&&&START&&&")).toThrow(/非 JSON/);
  });
});

/** 标准 RC4（不丢弃密钥流字节），仅用于对照「我们确实丢了 1024 字节」。 */
function standardRc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = ((j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff) | 0;
    const tmp = s[i] ?? 0;
    s[i] = s[j] ?? 0;
    s[j] = tmp;
  }
  let i = 0;
  j = 0;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    const a = s[i] ?? 0;
    j = (j + a) & 0xff;
    const b = s[j] ?? 0;
    s[i] = b;
    s[j] = a;
    out[n] = (data[n] ?? 0) ^ (s[(a + b) & 0xff] ?? 0);
  }
  return out;
}

describe("米家插件：规格 → 控件模型", () => {
  it("按属性类型 URN 识别语义段，可写的排前面，超限截断", async () => {
    const model = await loadPluginModule<DeviceModelModule>(
      "lib/device-model.js",
    );
    expect(
      model.propertySlug("urn:miot-spec-v2:property:on:00000006:x:1"),
    ).toBe("on");
    expect(model.propertySlug("not-a-urn")).toBe("");

    const spec = {
      services: [
        {
          iid: 2,
          properties: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:property:on:00000006:x:1",
              description: "开关",
              format: "bool",
              access: ["read", "write"],
            },
            {
              iid: 2,
              type: "urn:miot-spec-v2:property:mode:00000008:x:1",
              description: "模式",
              format: "uint8",
              access: ["read", "write"],
              "value-list": [
                { value: 0, description: "自动" },
                { value: 1, description: "手动" },
              ],
            },
            {
              iid: 3,
              type: "urn:miot-spec-v2:property:firmware-revision:00000011:x:1",
              description: "固件版本",
              format: "string",
              access: ["read"],
            },
          ],
        },
        {
          iid: 3,
          properties: [
            {
              iid: 1,
              type: "urn:miot-spec-v2:property:temperature:00000020:x:1",
              description: "温度",
              format: "float",
              access: ["read"],
            },
          ],
        },
      ],
    };

    const picked = model.selectProperties(spec);
    expect(picked.map((item) => item.name)).toEqual(["开关", "模式", "温度"]);
    expect(picked.map((item) => item.kind)).toEqual([
      "toggle",
      "select",
      "read",
    ]);
    // 只读的固件版本既不可写、也不在读数白名单 → 不上屏
    expect(picked.some((item) => item.name === "固件版本")).toBe(false);
    expect(model.selectProperties(spec, { limit: 1 })).toHaveLength(1);
  });

  it("写不了或格式不支持的属性降级成读数（不放点了没用的控件）", async () => {
    const model = await loadPluginModule<DeviceModelModule>(
      "lib/device-model.js",
    );
    expect(model.controlKindOf({ writable: false, format: "bool" })).toBe(
      "read",
    );
    expect(model.controlKindOf({ writable: true, format: "bool" })).toBe(
      "toggle",
    );
    expect(
      model.controlKindOf({
        writable: true,
        format: "uint8",
        valueRange: [1, 100, 1],
      }),
    ).toBe("slider");
    expect(
      model.controlKindOf({ writable: true, format: "uint8", valueList: [] }),
    ).toBe("select");
    expect(model.controlKindOf({ writable: true, format: "string" })).toBe(
      "read",
    );
  });

  it("属性值合并回定义；器件条目按云端字段收敛（离线判定含字符串 true）", async () => {
    const model = await loadPluginModule<DeviceModelModule>(
      "lib/device-model.js",
    );
    const merged = model.mergeValues(
      [
        { siid: 2, piid: 1, name: "开关" },
        { siid: 2, piid: 2, name: "亮度" },
      ],
      [{ siid: 2, piid: 1, value: true }],
    );
    expect(merged[0]).toMatchObject({ value: true });
    expect(merged[1]).not.toHaveProperty("value");

    expect(
      model.describeDevice({
        did: "d1",
        name: "灯",
        model: "m",
        isOnline: "true",
        room_name: "客厅",
      }),
    ).toMatchObject({ did: "d1", online: true, room: "客厅" });
    expect(model.describeDevice({ did: "d2", isOnline: false })).toMatchObject({
      did: "d2",
      online: false,
      room: null,
    });
  });
});

// === 2. 全链路（真门禁 + 假云） ===

let pluginsDir: string;
const kernels: Array<{ dispose(): void }> = [];
const realFetch = globalThis.fetch;

function installPlugin(micloud: MicloudModule, pollPendingFirst = true) {
  const kernel = composePlugins(makeEnv(), []);
  kernels.push(kernel);
  const cloud = fakeXiaomiCloud({ micloud, pollPendingFirst });
  globalThis.fetch = cloud.fetchImpl as typeof fetch;
  const storage = new Map<string, string>();
  const purged: string[] = [];
  const service = createPluginRegistryService({
    pluginsDir,
    tools: kernel.get("tools"),
    subscribe: () => () => {},
    hostNodeMajor: 22,
    builtinCatalog: [],
    storage: {
      async get(workspaceId, pluginId, key) {
        return (
          storage.get(JSON.stringify([workspaceId, pluginId, key])) ?? null
        );
      },
      async set(workspaceId, pluginId, key, value) {
        storage.set(JSON.stringify([workspaceId, pluginId, key]), value);
      },
      async remove(workspaceId, pluginId, key) {
        return storage.delete(JSON.stringify([workspaceId, pluginId, key]));
      },
      async keys(workspaceId, pluginId) {
        return [...storage.keys()]
          .map((raw) => JSON.parse(raw) as [string, string, string])
          .filter(([ws, id]) => ws === workspaceId && id === pluginId)
          .map(([, , key]) => key);
      },
      async purgePlugin(pluginId) {
        purged.push(pluginId);
        return 0;
      },
    },
  });
  return { kernel, service, cloud, storage, purged };
}

async function dispatch(
  service: ReturnType<typeof createPluginRegistryService>,
  pluginId: string,
  request: {
    method?: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    workspaceId?: string;
    isAuthenticated?: boolean;
  },
) {
  const result = await service.dispatchRoute({
    pluginId,
    method: request.method ?? "GET",
    path: request.path,
    query: request.query ?? {},
    body: request.body ?? null,
    headers: {},
    isAuthenticated: request.isAuthenticated ?? true,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
  });
  return result;
}

/** 取派发结果的 body（先断言 status，再取字段；避免「可选链后直接访问」）。 */
function bodyOf<T>(result: { body?: unknown } | undefined): T {
  return (result?.body ?? {}) as T;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "kenfutwork-mihome-"));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const kernel of kernels.splice(0)) {
    kernel.dispose();
  }
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("米家插件：安装与门禁", () => {
  it("通过门禁安装：能力声明含 storage，侧栏入口与工具都注册出来", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { kernel, service } = installPlugin(micloud);
    const { installed, report } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual([
      "tools",
      "routes",
      "ui",
      "storage",
    ]);
    expect(installed.name).toBe("kenfutwork-mihome");
    expect(kernel.get("tools").get("mihome_devices")).toBeDefined();
    expect(kernel.get("tools").get("mihome_control")).toBeDefined();
    expect(
      service.listUiEntries().filter((entry) => entry.slot === "sidebar"),
    ).toEqual([
      {
        pluginId: installed.id,
        id: "mihome",
        title: "米家",
        slot: "sidebar",
        url: "assets/panel.html",
      },
    ]);
  });

  it("静态资源按「bundle 根 + assets 前缀」口径托管（实测踩过的坑，锁死口径）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    // 清单 `ui.url` 里的 `assets/` 是**内核的 HTTP 路由前缀**（/api/plugins/<id>/assets/*），
    // 文件路径相对 bundle 根——面板文件必须放在插件根目录。
    const panel = await service.readAsset({
      pluginId: installed.id,
      relativePath: "panel.html",
    });
    expect(panel?.contentType).toContain("text/html");
    expect(panel?.content.toString("utf8")).toContain("米家");

    const script = await service.readAsset({
      pluginId: installed.id,
      relativePath: "panel.js",
    });
    expect(script?.contentType).toContain("text/javascript");

    // 放进 assets/ 子目录会 404（第一版就是这么写的，面板整页打不开）
    expect(
      await service.readAsset({
        pluginId: installed.id,
        relativePath: "assets/panel.html",
      }),
    ).toBeUndefined();
    // 越界路径与未知插件一律拒绝
    expect(
      await service.readAsset({
        pluginId: installed.id,
        relativePath: "../package.json",
      }),
    ).toBeUndefined();
    expect(
      await service.readAsset({
        pluginId: "ghost-plugin",
        relativePath: "panel.html",
      }),
    ).toBeUndefined();
  });

  it("私有路由：未登录一律 401（面板必须带宿主递进去的令牌）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const anonymous = await dispatch(service, installed.id, {
      path: "devices",
      workspaceId: "ws-1",
      isAuthenticated: false,
    });
    expect(anonymous).toMatchObject({ status: 401 });
  });

  it("缺工作区上下文时报错可读（插件存储按工作区隔离，不凭空兜底）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const result = await dispatch(service, installed.id, { path: "devices" });
    expect(result?.status).toBe(500);
    expect(JSON.stringify(result?.body)).toContain("缺少工作区上下文");
  });
});

describe("米家插件：登录 → 设备 → 控制（假云全链路）", () => {
  it("扫码登录把会话写进插件存储，重启后（新进程、无内存）仍能列设备", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const first = installPlugin(micloud);
    const { installed } = await first.service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    // 未连接时如实报错，而不是假装成功
    const before = await dispatch(first.service, installed.id, {
      path: "devices",
      workspaceId: "ws-1",
    });
    expect(before?.status).toBe(401);
    expect(before?.body).toMatchObject({ code: "not_connected" });

    const qr = await dispatch(first.service, installed.id, {
      path: "login/qr",
      workspaceId: "ws-1",
    });
    expect(qr?.status).toBe(200);
    const qrBody = bodyOf<{
      sessionId: string;
      qrUrl: string;
      timeout: number;
    }>(qr);
    expect(qrBody.qrUrl).toBe("https://account.example/qr.png");
    expect(qrBody.timeout).toBe(120);

    // 第一次轮询还没扫码 → pending
    const pending = await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId: qrBody.sessionId },
      workspaceId: "ws-1",
    });
    expect(pending?.body).toMatchObject({ status: "pending" });

    // 第二次 → ok，且会话已落存储（值里含 serviceToken，但绝不出 HTTP 面）
    const done = await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId: qrBody.sessionId },
      workspaceId: "ws-1",
    });
    expect(done?.body).toMatchObject({ status: "ok" });
    const stored = [...first.storage.values()].join("");
    expect(stored).toContain("TOKEN-1");

    const status = await dispatch(first.service, installed.id, {
      path: "status",
      workspaceId: "ws-1",
    });
    expect(status?.body).toMatchObject({ connected: true, userId: "u-1" });
    // 状态接口不得回显令牌/ssecurity
    expect(JSON.stringify(status?.body)).not.toContain("TOKEN-1");
    expect(JSON.stringify(status?.body)).not.toContain(FAKE_SSECURITY);

    // 设备列表：规格驱动的属性 + 离线置灰 + 未知型号如实报规格错误
    const devices = await dispatch(first.service, installed.id, {
      path: "devices",
      workspaceId: "ws-1",
    });
    expect(devices?.status).toBe(200);
    const view = devices?.body as {
      devices: Array<Record<string, unknown>>;
      specErrors: Array<Record<string, unknown>>;
      total: number;
    };
    expect(view.total).toBe(3);
    const light = view.devices.find((item) => item.did === "d1");
    expect(light).toMatchObject({
      name: "客厅灯",
      online: true,
      hasSpec: true,
    });
    expect(
      (light as { properties: Array<Record<string, unknown>> }).properties.map(
        (property) => [property.kind, property.value],
      ),
    ).toEqual([
      ["toggle", true],
      ["slider", 60],
      ["read", 23.5],
    ]);
    // 离线设备不读值（省云端心跳），但保留在列表里
    expect(view.devices.find((item) => item.did === "d2")).toMatchObject({
      online: false,
    });
    expect(
      view.specErrors.some((item) =>
        String(item.name).includes("未知型号设备"),
      ),
    ).toBe(true);

    // 模拟服务端重启：全新注册表实例 + 全新内存，但插件存储同一个 → 免扫码
    globalThis.fetch = realFetch;
    const second = installPlugin(micloud);
    for (const [key, value] of first.storage) second.storage.set(key, value);
    await second.service.restore();
    const afterRestart = await dispatch(second.service, installed.id, {
      path: "status",
      workspaceId: "ws-1",
    });
    expect(afterRestart?.body).toMatchObject({ connected: true });
    const devicesAgain = await dispatch(second.service, installed.id, {
      path: "devices",
      workspaceId: "ws-1",
    });
    expect(devicesAgain?.status).toBe(200);
  });

  it("云端回明文错误体时错误原因仍可读（真机实测：坏凭证下云端回明文 JSON）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const first = installPlugin(micloud);
    const { installed } = await first.service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(first.service, installed.id, {
      path: "login/qr",
      workspaceId: "ws-1",
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-1",
    });
    await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-1",
    });

    // 篡改落库的 ssecurity（模拟坏凭证），并换一个新实例从存储读回（等同于服务端重启）
    for (const [key, raw] of first.storage) {
      if (!raw.includes("serviceToken")) continue;
      const session = JSON.parse(raw) as Record<string, unknown>;
      session.ssecurity = Buffer.from("wrong-ssecurity-bytes").toString(
        "base64",
      );
      first.storage.set(key, JSON.stringify(session));
    }
    globalThis.fetch = realFetch;
    const second = installPlugin(micloud);
    for (const [key, value] of first.storage) second.storage.set(key, value);
    await second.service.restore();

    const devices = await dispatch(second.service, installed.id, {
      path: "devices",
      workspaceId: "ws-1",
    });
    expect(devices?.status).toBe(500);
    const message = JSON.stringify(devices?.body);
    expect(message).toContain("code=401");
    expect(message).toContain("签名不符");
  });

  it("控制写入把值传给云端并读回真值（离线/跨工作区另有隔离）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service, cloud } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      workspaceId: "ws-A",
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-A",
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-A",
    });

    const controlled = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      workspaceId: "ws-A",
      body: { did: "d1", siid: 2, piid: 1, value: false },
    });
    expect(controlled?.status).toBe(200);
    expect(controlled?.body).toMatchObject({ ok: true, value: false });
    expect(cloud.state.setCalls).toEqual([
      { did: "d1", siid: 2, piid: 1, value: false },
    ]);
    // 云端收到的每个 /app/ 请求签名都复算通过（收发一致性）
    expect(cloud.state.signedRequests).toBeGreaterThan(0);
    expect(cloud.state.badSignature).toBe(0);

    // 另一个工作区没登录过 → 各自隔离
    const other = await dispatch(service, installed.id, {
      path: "devices",
      workspaceId: "ws-B",
    });
    expect(other?.status).toBe(401);
    expect(other?.body).toMatchObject({ code: "not_connected" });

    // 控制参数不完整 → 400（而不是把 undefined 发给云端）
    const bad = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      workspaceId: "ws-A",
      body: { did: "d1" },
    });
    expect(bad?.status).toBe(400);

    // 断开后连接状态归零，且存储里的会话被清掉
    await dispatch(service, installed.id, {
      method: "POST",
      path: "disconnect",
      workspaceId: "ws-A",
    });
    const afterDisconnect = await dispatch(service, installed.id, {
      path: "status",
      workspaceId: "ws-A",
    });
    expect(afterDisconnect?.body).toMatchObject({ connected: false });
  });

  it("agent 工具：未连接时报可读错误；已连接时列出设备并可写入", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { kernel, service } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });
    const devicesTool = kernel.get("tools").require("mihome_devices");
    const controlTool = kernel.get("tools").require("mihome_control");

    await expect(
      devicesTool.execute({}, { workspaceId: "ws-1" }),
    ).rejects.toThrow(/尚未连接米家账号/);

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      workspaceId: "ws-1",
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-1",
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      workspaceId: "ws-1",
    });

    const listed = (await devicesTool.execute({}, { workspaceId: "ws-1" })) as {
      devices: Array<Record<string, unknown>>;
    };
    const light = listed.devices.find((item) => item.did === "d1");
    expect(light).toMatchObject({ name: "客厅灯", online: true });
    expect(
      (light as { properties: Array<Record<string, unknown>> }).properties.map(
        (property) => [property.siid, property.piid, property.writable],
      ),
    ).toContainEqual([2, 1, true]);

    const written = (await controlTool.execute(
      { did: "d1", siid: 2, piid: 2, value: 80 },
      { workspaceId: "ws-1" },
    )) as Record<string, unknown>;
    expect(written).toMatchObject({ ok: true, key: "2.2", value: 80 });
  });
});
