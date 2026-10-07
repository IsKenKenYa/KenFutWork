import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import { buildBundleManifest } from "./bundle-manifest.js";
import { validateBundleFiles } from "./compat-validator.js";
import {
  type BundledBundle,
  createPluginRegistryService,
} from "./plugin-registry-service.js";

/**
 * 米家插件测试。分两层：
 *
 * 1. **纯函数**：nonce / signedNonce / RC4 / 签名字符串 / 规格→控件模型。
 *    这些用「资产向量（golden vector）+ 性质」锁行为，防的是**日后改坏**（协议细节本身
 *    无法在本机对着真米家云验证——没有账号，且接口是社区逆向的私有接口）。
 * 2. **全链路**：真的走门禁安装到临时目录，再用**假米家云**（服务端侧复算签名、RC4 解密
 *    请求、加密响应）跑通 登录 → 设备列表 → 控制，以及未连接 / 未登录 / 跨实例隔离等错误面。
 *
 * 假云与客户端共用同一份 crypto 原语，因此它验证的是**收发一致性**（签名口径、参数顺序、
 * 加解密方向），不构成对真实服务的验证——这一点在插件 README 与台账里都写明了。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const MIHOME_DIR = path.join(REPO_ROOT, "plugins", "mihome");
const INSTANCE_ID = "b0ad3f92-036b-43d2-a3f4-9142c7ad48e1";
const INSTANCE_A = "68759604-4d15-45d7-80ba-e2909c06b2f6";
const INSTANCE_B = "288b9396-4bcf-4e57-8d74-ce05fa09c88d";

interface MicloudModule {
  MIHOME_SID: string;
  MIHOME_AUTH_VERSION: string;
  generateDeviceId: (random?: () => number, length?: number) => string;
  generatePassO: () => string;
  sessionCookies: (session: Record<string, unknown>) => Record<string, string>;
  apiCookieJar: (session: Record<string, unknown>) => Record<string, string>;
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
  /** 区域主机归一：STS 主机要去掉 `sts.` 前缀（不然 /app/ 稳定 404）。 */
  normalizeApiHost: (host: string) => string;
}

interface QrRefreshModule {
  MAX_AUTO_REFRESHES: number;
  decideQrAction: (input: {
    now: number;
    deadline: number;
    status: "pending" | "expired" | "ok";
    autoRefreshes: number;
  }) => "scanned" | "poll" | "refresh" | "give-up";
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
  createSpecResolver: (options?: {
    fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
    failureTtlMs?: number;
  }) => {
    loadSpec: (
      model: string,
      options?: { force?: boolean },
    ) => Promise<{ services?: unknown[] }>;
  };
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
  /** 家庭列表（空数组 = 模拟「没有家庭模型的老账号」，走经典接口兜底）。 */
  homes?: Array<Record<string, unknown>>;
  /** 空账号：新接口与经典接口都返回 0 台（覆盖「空列表确诊」分支）。 */
  emptyAccount?: boolean;
  /** 长轮询直接抛错（真机口径：120s 没人扫时 AbortSignal 到期）。 */
  pollThrows?: boolean;
}

function fakeXiaomiCloud(options: FakeCloudOptions) {
  const { micloud } = options;
  const pollPendingFirst = options.pollPendingFirst ?? true;
  /** 家庭维度接口返回的设备（真实云端现用的口径）。 */
  const homeDevices = [
    {
      did: "d1",
      name: "客厅灯",
      model: "test.light",
      isOnline: true,
      room_name: "客厅",
    },
    { did: "d2", name: "卧室插座", model: "test.light", isOnline: false },
    { did: "d3", name: "未知型号设备", model: "ghost.model", isOnline: true },
  ];
  const state = {
    polls: 0,
    signedRequests: 0,
    badSignature: 0,
    serviceSid: null as string | null,
    serviceCookie: "",
    serviceUserAgent: "",
    callbackCookie: "",
    callbackUserAgent: "",
    loginSid: null as string | null,
    loginUserAgent: "",
    loginHasLogo: null as string | null,
    loginQrSize: null as string | null,
    pollUserAgent: "",
    /** API CookieJar 缺关键项的请求数——应恒为 0。 */
    missingSessionCookie: 0,
    /** 最近一次 /app/ 请求实际使用的 cookie（锁兑换后的 jar）。 */
    lastApiCookie: "",
    /** 设备 API 请求实际打到的主机（锁「sid=mijia 会话只打 mijia 主机」这条口径）。 */
    apiHosts: [] as string[],
    /** 最近一次 /home/home_device_list 的参数（锁家庭维度口径）。 */
    lastHomeListParams: null as Record<string, string> | null,
    homes: options.homes ?? [{ id: 123, uid: 456, name: "我的家" }],
    emptyAccount: options.emptyAccount ?? false,
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
    // API CookieJar 必须匹配参考实现的完整键集，且用的是**扫码登录 callback 的那枚
    // serviceToken**（mijia）——兑换来的其他 sid 令牌云端不认（真机 code=2 auth error）。
    const headers = (init.headers ?? {}) as Record<string, string>;
    const cookie = headers.cookie ?? "";
    state.lastApiCookie = cookie;
    if (
      !cookie.includes("PassportDeviceId=") ||
      !cookie.includes("yetAnotherServiceToken=TOKEN-1") ||
      !cookie.includes("serviceToken=TOKEN-1") ||
      !cookie.includes("cUserId=C-1") ||
      !cookie.includes("channel=MI_APP_STORE") ||
      !cookie.includes("countryCode=CN") ||
      !cookie.includes("locale=zh_CN")
    ) {
      state.missingSessionCookie += 1;
    }
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

    if (uri === "/v2/homeroom/gethome_merged") {
      return json(
        encryptPayload(signedNonce, {
          code: 0,
          result: { homelist: state.homes },
        }),
      );
    }

    if (uri === "/home/home_device_list") {
      // 参考实现把整包业务参数放在**单个 `data` 字段**（JSON 字符串）里加密上传
      state.lastHomeListParams = JSON.parse(plain.data ?? "{}") as Record<
        string,
        string
      >;
      return json(
        encryptPayload(signedNonce, {
          code: 0,
          result: {
            device_info: state.emptyAccount
              ? []
              : state.homes.length > 0
                ? homeDevices
                : [],
            has_more: false,
            max_did: "",
          },
        }),
      );
    }

    // 经典接口：只有「没有家庭模型的老账号」才会走到（新流程拿不到设备时的兜底）
    if (uri === "/home/device_list") {
      return json(
        encryptPayload(signedNonce, {
          code: 0,
          result: {
            list: state.emptyAccount
              ? []
              : [
                  {
                    did: "c1",
                    name: "老账号设备",
                    model: "test.light",
                    isOnline: true,
                  },
                ],
          },
        }),
      );
    }

    if (uri === "/miotspec/prop/get") {
      const payload = JSON.parse(plain.data ?? "{}") as {
        params?: Array<{ did: string; siid: number; piid: number }>;
      };
      const wanted = payload.params ?? [];
      const result = wanted.map((item) => ({
        ...item,
        code: 0,
        value:
          state.values.get(`${item.did}:${item.siid}.${item.piid}`) ?? null,
      }));
      return json(encryptPayload(signedNonce, { code: 0, result }));
    }

    if (uri === "/miotspec/prop/set") {
      const payload = JSON.parse(plain.data ?? "{}") as {
        params?: Array<{
          did: string;
          siid: number;
          piid: number;
          value: unknown;
        }>;
      };
      const wanted = payload.params ?? [];
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
    if (url.pathname === "/pass/serviceLogin") {
      const headers = (init.headers ?? {}) as Record<string, string>;
      state.serviceSid = url.searchParams.get("sid");
      state.serviceCookie = headers.cookie ?? "";
      state.serviceUserAgent = headers["user-agent"] ?? "";
      // 出码（sid=mijia）：未扫码 → 引导二维码（拿 location 里的 query 拼 loginUrl）
      return accountJson({
        code: 70016,
        location:
          "https://account.example/sts?sid=mijia&callback=https%3A%2F%2Fsts.api.io.mi.com%2Fsts&_locale=zh_CN",
      });
    }
    if (url.pathname === "/longPolling/loginUrl") {
      const loginHeaders = (init.headers ?? {}) as Record<string, string>;
      state.loginSid = url.searchParams.get("sid");
      state.loginUserAgent = loginHeaders["user-agent"] ?? "";
      state.loginHasLogo = url.searchParams.get("_hasLogo");
      state.loginQrSize = url.searchParams.get("_qrsize");
      return accountJson({
        code: 0,
        qr: "https://account.example/qr.png",
        loginUrl: "https://account.example/login/abc",
        lp: "https://account.example/lp/abc",
      });
    }
    if (url.pathname.startsWith("/lp/")) {
      const pollHeaders = (init.headers ?? {}) as Record<string, string>;
      state.pollUserAgent = pollHeaders["user-agent"] ?? "";
      state.polls += 1;
      if (options.pollThrows) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (pollPendingFirst && state.polls < 2) {
        return accountJson({ code: 0 });
      }
      return accountJson({
        code: 0,
        psecurity: "psecurity-1",
        nonce: "nonce-1",
        ssecurity: FAKE_SSECURITY,
        passToken: "P-1",
        userId: "u-1",
        cUserId: "C-1",
        location: "https://account.example/sts?sign=xyz",
      });
    }
    if (url.hostname === "account.example" && url.pathname === "/sts") {
      // 二维码 callback（mijia 登录换 serviceToken）：参考实现不手工带旧 Cookie
      const requestHeaders = (init.headers ?? {}) as Record<string, string>;
      state.callbackCookie = requestHeaders.cookie ?? "";
      state.callbackUserAgent = requestHeaders["user-agent"] ?? "";
      const headers = new Headers();
      headers.append("set-cookie", "serviceToken=TOKEN-1; Path=/");
      headers.append("set-cookie", "auxiliaryToken=AUX-1; Path=/");
      return new Response("ok", { status: 200, headers });
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
      state.apiHosts.push(url.origin);
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

  it("区域主机归一：STS 主机去掉 sts. 前缀，其它区与坏地址各有去处", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    // 真机踩到：登录响应给的 location 是 https://sts.api.io.mi.com/sts?...，
    // 直接拿它当 API 主机 → /app/* 稳定 404
    expect(
      micloud.normalizeApiHost("https://sts.api.io.mi.com/sts?sign=x"),
    ).toBe("https://api.io.mi.com");
    // 其它区域本来就带区域前缀（没有 sts.）→ 原样
    expect(
      micloud.normalizeApiHost("https://de.api.io.mi.com/sts?sign=x"),
    ).toBe("https://de.api.io.mi.com");
    expect(micloud.normalizeApiHost("https://i2.api.io.mi.com/sts")).toBe(
      "https://i2.api.io.mi.com",
    );
    // 空/坏地址回落默认 CN 入口（不把坏地址带进后续请求）
    expect(micloud.normalizeApiHost("")).toBe("https://api.mijia.tech");
    expect(micloud.normalizeApiHost("不是地址")).toBe("https://api.mijia.tech");
  });

  it("现代米家登录与 API CookieJar：sid=mijia、设备身份稳定、两个 token cookie 同值", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    expect(micloud.MIHOME_SID).toBe("mijia");
    expect(micloud.MIHOME_AUTH_VERSION).toBe("mijia-v2");
    expect(micloud.generateDeviceId(() => 0)).toBe("A".repeat(16));
    expect(micloud.generatePassO()).toMatch(/^[a-f0-9]{16}$/);

    const cookies = micloud.apiCookieJar({
      cUserId: "C-1",
      serviceToken: "TOKEN-1",
      deviceId: "D123456789012345",
      locale: "zh_CN",
    });
    expect(cookies).toMatchObject({
      cUserId: "C-1",
      serviceToken: "TOKEN-1",
      yetAnotherServiceToken: "TOKEN-1",
      PassportDeviceId: "D123456789012345",
      channel: "MI_APP_STORE",
      countryCode: "CN",
      locale: "zh_CN",
    });
    expect(cookies.timezone_id).toEqual(expect.any(String));
    expect(cookies.timezone).toMatch(/^GMT[+-]\d{2}:\d{2}$/);
    expect(cookies).not.toHaveProperty("passToken");
    expect(cookies).not.toHaveProperty("userId");
    expect(cookies).not.toHaveProperty("deviceId");
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

describe("米家插件：二维码过期自动换码的判定", () => {
  it("未过期继续轮询；过期自动刷新；扫到就停；连换到上限才交回用户", async () => {
    const qr = await loadPluginModule<QrRefreshModule>("lib/qr-refresh.js");
    const base = {
      now: 1_000_000,
      deadline: 1_000_000 + 120_000,
      status: "pending" as const,
      autoRefreshes: 0,
    };

    // 还没过期：继续轮询
    expect(qr.decideQrAction(base)).toBe("poll");
    // 服务端说这码失效了（或本地过了截止时刻）→ 自动换新码
    expect(qr.decideQrAction({ ...base, status: "expired" })).toBe("refresh");
    expect(qr.decideQrAction({ ...base, now: 1_000_000 + 120_001 })).toBe(
      "refresh",
    );
    // 扫到了：停
    expect(qr.decideQrAction({ ...base, status: "ok" })).toBe("scanned");
    // 换到上限：停手，把决定权交回用户（不给无限循环）
    expect(
      qr.decideQrAction({
        ...base,
        status: "expired",
        autoRefreshes: qr.MAX_AUTO_REFRESHES,
      }),
    ).toBe("give-up");
    // 上限内还能接着换
    expect(
      qr.decideQrAction({
        ...base,
        status: "expired",
        autoRefreshes: qr.MAX_AUTO_REFRESHES - 1,
      }),
    ).toBe("refresh");
  });
});

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

  it("规格解析失败负缓存：TTL 内不重复试、force 强制重试、成功后才更新", async () => {
    const model = await loadPluginModule<DeviceModelModule>(
      "lib/device-model.js",
    );
    let instanceCalls = 0;
    let instanceStatus = 500;
    const resolver = model.createSpecResolver({
      failureTtlMs: 60_000,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/instances")) {
          return new Response(
            JSON.stringify({
              instances: [{ model: "m.fail", type: "urn:test:fail" }],
            }),
            { status: 200 },
          );
        }
        instanceCalls += 1;
        if (instanceStatus !== 200) {
          return new Response("boom", { status: instanceStatus });
        }
        return new Response(JSON.stringify({ services: [] }), { status: 200 });
      },
    });

    // 第一次失败 → 记住失败；第二次（面板每 5 秒轮询）不再打上游、错误文案照旧
    await expect(resolver.loadSpec("m.fail")).rejects.toThrow(/规格拉取失败/);
    expect(instanceCalls).toBe(1);
    await expect(resolver.loadSpec("m.fail")).rejects.toThrow(/规格拉取失败/);
    expect(instanceCalls).toBe(1);

    // 用户点「刷新」→ force 强制重试一次（失败则继续沿用负缓存）
    await expect(
      resolver.loadSpec("m.fail", { force: true }),
    ).rejects.toThrow();
    expect(instanceCalls).toBe(2);

    // 上游恢复：force 重试成功后清掉负缓存，后续走成功缓存（不再打上游）
    instanceStatus = 200;
    await expect(
      resolver.loadSpec("m.fail", { force: true }),
    ).resolves.toMatchObject({ services: [] });
    expect(instanceCalls).toBe(3);
    await expect(resolver.loadSpec("m.fail")).resolves.toMatchObject({
      services: [],
    });
    expect(instanceCalls).toBe(3);
  });
});

// === 2. 全链路（真门禁 + 假云） ===

class PersistentTestStorage extends Map<string, string> {
  constructor(private readonly file: string) {
    super();
    if (!existsSync(file)) return;
    const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) throw new Error("持久插件夹具格式无效。");
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string"
      ) {
        throw new Error("持久插件夹具条目无效。");
      }
      super.set(entry[0], entry[1]);
    }
  }

  private persist() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  override set(key: string, value: string): this {
    super.set(key, value);
    this.persist();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.persist();
    return removed;
  }
}

let pluginsDir: string;
let localInstances: Map<string, LocalInstanceService>;

async function fixtureActor(instanceId: string): Promise<LocalActor> {
  const service = localInstances.get(instanceId);
  if (!service) throw new Error("夹具未定义该本地实例。");
  return service.serviceActor();
}

const kernels: Array<{ dispose(): void }> = [];
const realFetch = globalThis.fetch;

function installPlugin(
  micloud: MicloudModule,
  options: {
    pollPendingFirst?: boolean;
    homes?: Array<Record<string, unknown>>;
    emptyAccount?: boolean;
    pollThrows?: boolean;
    /** 随应用自带的 bundle（市场直接列出未装条目，一键安装）。 */
    bundledBundles?: BundledBundle[];
  } = {},
) {
  const kernel = composePlugins(makeEnv(), []);
  kernels.push(kernel);
  const cloud = fakeXiaomiCloud({
    micloud,
    pollPendingFirst: options.pollPendingFirst ?? true,
    ...(options.homes ? { homes: options.homes } : {}),
    ...(options.emptyAccount ? { emptyAccount: options.emptyAccount } : {}),
    ...(options.pollThrows ? { pollThrows: options.pollThrows } : {}),
  });
  globalThis.fetch = cloud.fetchImpl as typeof fetch;
  const storage = new PersistentTestStorage(
    path.join(pluginsDir, "test-session-storage.json"),
  );
  const purged: string[] = [];
  const service = createPluginRegistryService({
    pluginsDir,
    tools: kernel.get("tools"),
    subscribe: () => () => {},
    hostNodeMajor: 22,
    builtinCatalog: [],
    ...(options.bundledBundles
      ? { bundledBundles: options.bundledBundles }
      : {}),
    storage: {
      async get(instanceId, pluginId, key) {
        return storage.get(JSON.stringify([instanceId, pluginId, key])) ?? null;
      },
      async set(instanceId, pluginId, key, value) {
        storage.set(JSON.stringify([instanceId, pluginId, key]), value);
      },
      async remove(instanceId, pluginId, key) {
        return storage.delete(JSON.stringify([instanceId, pluginId, key]));
      },
      async keys(instanceId, pluginId) {
        return [...storage.keys()]
          .map((raw) => JSON.parse(raw) as [string, string, string])
          .filter(([ws, id]) => ws === instanceId && id === pluginId)
          .map(([, , key]) => key);
      },
      async purgePlugin(pluginId) {
        purged.push(pluginId);
        let removed = 0;
        for (const key of [...storage.keys()]) {
          const identity: unknown = JSON.parse(key);
          if (
            Array.isArray(identity) &&
            identity[1] === pluginId &&
            storage.delete(key)
          )
            removed += 1;
        }
        return removed;
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
    instanceId?: string;
    isAuthenticated?: boolean;
  },
) {
  const instance = request.instanceId
    ? localInstances.get(request.instanceId)
    : undefined;
  if (request.instanceId && !instance) {
    throw new Error("夹具未定义该本地实例。");
  }
  const actor = instance ? await instance.serviceActor() : null;
  const context = actor && instance ? await instance.resolve(actor) : null;
  const result = await service.dispatchRoute({
    pluginId,
    method: request.method ?? "GET",
    path: request.path,
    query: request.query ?? {},
    body: request.body ?? null,
    headers: {},
    isAuthenticated: request.isAuthenticated ?? true,
    ...(context ? { instanceId: context.instanceId } : {}),
  });
  return result;
}

/** 取派发结果的 body（先断言 status，再取字段；避免「可选链后直接访问」）。 */
function bodyOf<T>(result: { body?: unknown } | undefined): T {
  return (result?.body ?? {}) as T;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "kenfutwork-mihome-"));
  localInstances = new Map();
  for (const instanceId of [INSTANCE_ID, INSTANCE_A, INSTANCE_B]) {
    localInstances.set(
      instanceId,
      createLocalInstanceService({
        repository: { ensure: async () => instanceId },
        dataDir: path.join(pluginsDir, "instances", instanceId),
      }),
    );
  }
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
        icon: "assets/icon.svg",
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
      instanceId: INSTANCE_ID,
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
    expect(JSON.stringify(result?.body)).toContain("缺少实例上下文");
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
      instanceId: INSTANCE_ID,
    });
    expect(before?.status).toBe(401);
    expect(before?.body).toMatchObject({ code: "not_connected" });

    const qr = await dispatch(first.service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
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
      instanceId: INSTANCE_ID,
    });
    expect(pending?.body).toMatchObject({ status: "pending" });

    // 第二次 → ok，且会话已落存储（值里含 serviceToken，但绝不出 HTTP 面）
    const done = await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId: qrBody.sessionId },
      instanceId: INSTANCE_ID,
    });
    expect(done?.body).toMatchObject({ status: "ok" });
    const stored = [...first.storage.values()].join("");
    expect(stored).toContain("TOKEN-1");
    expect(
      readFileSync(path.join(pluginsDir, "test-session-storage.json"), "utf8"),
    ).toContain("TOKEN-1");

    const status = await dispatch(first.service, installed.id, {
      path: "status",
      instanceId: INSTANCE_ID,
    });
    expect(status?.body).toMatchObject({ connected: true, userId: "u-1" });
    // 状态接口不得回显令牌/ssecurity
    expect(JSON.stringify(status?.body)).not.toContain("TOKEN-1");
    expect(JSON.stringify(status?.body)).not.toContain(FAKE_SSECURITY);

    // 设备列表：规格驱动的属性 + 离线置灰 + 未知型号如实报规格错误
    const devices = await dispatch(first.service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
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
    await second.service.restore();
    const afterRestart = await dispatch(second.service, installed.id, {
      path: "status",
      instanceId: INSTANCE_ID,
    });
    expect(afterRestart?.body).toMatchObject({ connected: true });
    const devicesAgain = await dispatch(second.service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
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
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    await dispatch(first.service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
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
    await second.service.restore();

    const devices = await dispatch(second.service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(500);
    const message = JSON.stringify(devices?.body);
    expect(message).toContain("code=401");
    expect(message).toContain("签名不符");
  });

  it("现代 mijia 登录 + 家庭维度设备接口 + 完整 API CookieJar", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service, cloud, storage } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });

    // serviceLogin → longPolling 的现代米家登录口径（旧 xiaomiio 码不再允许）
    expect(cloud.state.serviceSid).toBe("mijia");
    expect(cloud.state.serviceCookie).toMatch(/deviceId=[A-Za-z0-9_-]{16}/);
    expect(cloud.state.serviceCookie).toMatch(/pass_o=[a-f0-9]{16}/);
    expect(cloud.state.serviceCookie).toContain("uLocale=zh_CN");
    expect(cloud.state.loginSid).toBe("mijia");
    expect(cloud.state.loginHasLogo).toBe("false");
    expect(cloud.state.loginQrSize).toBe("480");
    // 四步登录复用同一个动态 App UA；callback 不手工带旧 Cookie
    expect(cloud.state.serviceUserAgent).toContain("SmartHome-MI_APP_STORE");
    expect(cloud.state.serviceUserAgent).toBe(cloud.state.loginUserAgent);
    expect(cloud.state.loginUserAgent).toBe(cloud.state.pollUserAgent);
    expect(cloud.state.pollUserAgent).toBe(cloud.state.callbackUserAgent);
    expect(cloud.state.callbackCookie).toBe("");

    const storedRaw = [...storage.values()].find((value) =>
      value.includes("serviceToken"),
    );
    const stored = JSON.parse(storedRaw ?? "{}") as Record<string, unknown>;
    expect(stored).toMatchObject({
      authVersion: "mijia-v2",
      sid: "mijia",
      userId: "u-1",
      cUserId: "C-1",
      passToken: "P-1",
      serviceToken: "TOKEN-1",
      psecurity: "psecurity-1",
      nonce: "nonce-1",
    });
    expect(stored.deviceId).toEqual(expect.any(String));

    const devices = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(200);
    const view = devices?.body as { devices: Array<Record<string, unknown>> };
    expect(view.devices.map((item) => item.did)).toEqual(["d1", "d2", "d3"]);

    // 家庭维度参数取自 gethome_merged（home_owner/home_id 不能是 0/空）；
    // `data` 包装里保留原始类型（数字/布尔），不再逐字段字符串化
    expect(cloud.state.lastHomeListParams).toMatchObject({
      home_owner: 456,
      home_id: 123,
      limit: 200,
      support_smart_home: true,
    });
    // API CookieJar 用的就是**扫码登录 callback 的那枚 serviceToken**（mijia），按白名单齐全；
    // 兑换出来的其他 sid 令牌云端不认（真机 code=2 auth error，第十九轮（七））
    expect(cloud.state.lastApiCookie).toContain("serviceToken=TOKEN-1");
    expect(cloud.state.lastApiCookie).toContain("cUserId=C-1");
    expect(cloud.state.lastApiCookie).toContain("PassportDeviceId=");
    expect(cloud.state.lastApiCookie).toContain("channel=MI_APP_STORE");
    expect(cloud.state.lastApiCookie).toContain(
      "yetAnotherServiceToken=TOKEN-1",
    );
    expect(cloud.state.missingSessionCookie).toBe(0);
    // 设备 API 只打 mijia 主机：`sid=mijia` 的令牌发到 api.io.mi.com 一律 auth error（真机实测）
    expect(new Set(cloud.state.apiHosts)).toEqual(
      new Set(["https://api.mijia.tech"]),
    );
    // 会话里没有也不需要任何「兑换产物」
    const storedApi = JSON.parse(
      storage.get(JSON.stringify([INSTANCE_ID, installed.id, "session"])) ??
        "{}",
    ) as Record<string, unknown>;
    expect(storedApi.apiCookies).toBeUndefined();
  });

  it("新接口拿不到设备时兜底走经典接口（没有家庭模型的老账号）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud, { homes: [] });
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });

    const devices = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(200);
    const view = devices?.body as { devices: Array<Record<string, unknown>> };
    expect(view.devices.map((item) => item.did)).toEqual(["c1"]);
    expect(view.devices[0]).toMatchObject({ name: "老账号设备" });
  });

  it("旧 xiaomiio 会话读取时自动失效并清库（不能伪装成已连接 + 0 设备）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service, storage } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const key = JSON.stringify([INSTANCE_ID, installed.id, "session"]);
    storage.set(
      key,
      JSON.stringify({
        userId: "u-legacy",
        cUserId: "c-legacy",
        serviceToken: "st-legacy",
        ssecurity: FAKE_SSECURITY,
        apiHost: "https://sts.api.io.mi.com",
        // 没有 authVersion：这是旧 sid=xiaomiio 会话，不能迁移。
      }),
    );

    const devices = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(401);
    expect(devices?.body).toMatchObject({ code: "not_connected" });
    expect(storage.has(key)).toBe(false);
  });

  it("mijia-v1 会话同样失效清库（设备 API 主机已从 api.io.mi.com 改到 api.mijia.tech）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service, storage } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const key = JSON.stringify([INSTANCE_ID, installed.id, "session"]);
    storage.set(
      key,
      JSON.stringify({
        authVersion: "mijia-v1",
        sid: "mijia",
        passToken: "P-1",
        ssecurity: FAKE_SSECURITY,
        apiHost: "https://api.io.mi.com",
        // 存量会话里存着旧主机——改口径只发生在新登录上，所以这里必须作废而不是就地改道。
      }),
    );

    const devices = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(401);
    expect(devices?.body).toMatchObject({ code: "not_connected" });
    expect(storage.has(key)).toBe(false);
  });

  it("长轮询超时/断线不算失败：回 expired 让面板自动换码（用户不用手点）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud, { pollThrows: true });
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    const poll = await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    // 不抛 500、也不把面板卡在轮询上：状态是 expired，面板据此换新码
    expect(poll?.status).toBe(200);
    expect(poll?.body).toMatchObject({ status: "expired" });
    // 该二维码会话已被丢弃：同一个 sessionId 再问一次是 410（面板不会复用过期码）
    const again = await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    expect(again?.status).toBe(410);
  });

  it("自带 bundle：未安装时市场直接列出，一键安装即生效（无需来源链接）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    // 把插件源目录整体读成「自带 bundle」的文件集合
    const files: Record<string, string> = {};
    const walk = (rel: string): void => {
      for (const item of readdirSync(path.join(MIHOME_DIR, rel), {
        withFileTypes: true,
      })) {
        const child = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) walk(child);
        else files[child] = readFileSync(path.join(MIHOME_DIR, child), "utf8");
      }
    };
    walk("");

    const bundled: BundledBundle = {
      id: "local__kenfutwork-mihome",
      name: "kenfutwork-mihome",
      files,
      manifest: buildBundleManifest(files).manifest,
      report: validateBundleFiles(files, {
        hostNodeMajor: 22,
        allowLifecycleScripts: false,
        fallbackName: "kenfutwork-mihome",
      }),
    };
    const { service } = installPlugin(micloud, {
      bundledBundles: [bundled],
    });

    // 未安装：市场按 builtin 来源列出（installed=false、带 ui 与图标、标题用展示名）
    const listed = (await service.list()).find(
      (entry) => entry.source === "builtin",
    );
    expect(listed).toMatchObject({
      id: "local__kenfutwork-mihome",
      name: "kenfutwork-mihome",
      title: "米家",
      installed: false,
    });
    expect(listed?.ui?.[0]?.icon).toBe("assets/icon.svg");
    // 未安装也能读自带资产（市场卡片图标的来源）
    const icon = await service.readAsset({
      pluginId: "local__kenfutwork-mihome",
      relativePath: "icon.svg",
    });
    expect(icon?.contentType).toBe("image/svg+xml");

    // 一键安装：无 url、直接按包名装；装完即装载（ui 入口带 icon），市场不再重复列出
    const result = await service.install({
      builtin: "kenfutwork-mihome",
      allowLifecycleScripts: false,
    });
    expect(result.installed.source).toBe("builtin");
    expect(
      service
        .listUiEntries()
        .find((entry) => entry.pluginId === "local__kenfutwork-mihome"),
    ).toMatchObject({ icon: "assets/icon.svg", slot: "sidebar" });
    // 安装后：市场不再出现「未安装」的自带条目（已安装的那条来自安装记录本身）
    expect(
      (await service.list()).filter(
        (entry) => entry.source === "builtin" && !entry.installed,
      ),
    ).toEqual([]);
  });
  it("空设备列表如实解释（家庭在、设备为零，不猜设备也不假装已连接）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service } = installPlugin(micloud, { emptyAccount: true });
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });

    const devices = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_ID,
    });
    expect(devices?.status).toBe(200);
    const view = devices?.body as {
      devices: unknown[];
      homeCount: number;
      authHint: string | null;
    };
    expect(view.devices).toEqual([]);
    expect(view.homeCount).toBe(1);
    expect(view.authHint).toBe("该米家账号的家庭下没有设备。");
  });

  it("控制写入把值传给云端并读回真值（离线/跨实例另有隔离）", async () => {
    const micloud = await loadPluginModule<MicloudModule>("lib/micloud.js");
    const { service, cloud } = installPlugin(micloud);
    const { installed } = await service.install({
      url: path.join(MIHOME_DIR),
      allowLifecycleScripts: false,
    });

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_A,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_A,
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_A,
    });

    const controlled = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      instanceId: INSTANCE_A,
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

    // 另一个实例没登录过 → 各自隔离
    const other = await dispatch(service, installed.id, {
      path: "devices",
      instanceId: INSTANCE_B,
    });
    expect(other?.status).toBe(401);
    expect(other?.body).toMatchObject({ code: "not_connected" });

    // 控制参数不完整 → 400（而不是把 undefined 发给云端）
    const bad = await dispatch(service, installed.id, {
      method: "POST",
      path: "control",
      instanceId: INSTANCE_A,
      body: { did: "d1" },
    });
    expect(bad?.status).toBe(400);

    // 断开后连接状态归零，且存储里的会话被清掉
    await dispatch(service, installed.id, {
      method: "POST",
      path: "disconnect",
      instanceId: INSTANCE_A,
    });
    const afterDisconnect = await dispatch(service, installed.id, {
      path: "status",
      instanceId: INSTANCE_A,
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
      devicesTool.execute(
        {},
        {
          actor: await fixtureActor(INSTANCE_ID),
          instanceId: INSTANCE_B,
        },
      ),
    ).rejects.toThrow("不属于同一本地实例");

    await expect(
      devicesTool.execute(
        {},
        { actor: await fixtureActor(INSTANCE_ID), instanceId: INSTANCE_ID },
      ),
    ).rejects.toThrow(/尚未连接米家账号/);

    const qr = await dispatch(service, installed.id, {
      path: "login/qr",
      instanceId: INSTANCE_ID,
    });
    const sessionId = bodyOf<{ sessionId: string }>(qr).sessionId;
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });
    await dispatch(service, installed.id, {
      path: "login/poll",
      query: { sessionId },
      instanceId: INSTANCE_ID,
    });

    const listed = (await devicesTool.execute(
      {},
      { actor: await fixtureActor(INSTANCE_ID) },
    )) as {
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
      { actor: await fixtureActor(INSTANCE_ID), instanceId: INSTANCE_ID },
    )) as Record<string, unknown>;
    expect(written).toMatchObject({ ok: true, key: "2.2", value: 80 });
  });
});
