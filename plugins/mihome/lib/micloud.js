/**
 * 米家云客户端（零依赖，只用 node 内置模块）。
 *
 * 米家 App 用的是一套**社区逆向**的私有云接口，没有面向个人开发者的官方开放 API
 * （官方开放平台只对硬件厂商）。本文件按 MIT 参考实现的算法复刻：
 *   - merdok/homebridge-miot `lib/protocol/MiCloud.js`（扫码登录三步与端点）
 *   - @zythum02/mijia-api `dist/utils/crypto.js`（RC4 请求体与 SHA1 签名，2026-09 在线可用）
 *
 * 请求口径（加密路径，缺一不可）：
 *   nonce        = base64(8 随机字节 ‖ 分钟数变长大端)
 *   signedNonce  = base64(sha256(b64decode(ssecurity) ‖ b64decode(nonce)))
 *   rc4_hash__   = base64(sha1(`${METHOD}&${uri}${&k=v 明文参数}&${signedNonce}`))
 *   加密          = 每个参数值（含 rc4_hash__）用 RC4(key=b64decode(signedNonce)) 加密，
 *                  **丢弃前 1024 字节密钥流**，输出 base64
 *   signature    = 同 rc4_hash__ 的算法，但参数取**密文**
 *   请求体        = 表单编码（加密后的参数 + signature + ssecurity + _nonce）
 *   响应          = 用同一个 RC4 解 base64 后得文本（若 gzip 魔数再解压）
 *
 * 插件内核约束：不能 import fs/child_process，也不能带 npm 依赖，故只依赖 `node:crypto`
 * 与 `node:zlib`，网络出口统一收在 `fetchImpl` 上（单测替换成假云服务）。
 */

import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

const ACCOUNT_HOST = "https://account.xiaomi.com";
const SERVICE_LOGIN_PATH = "/pass/serviceLogin";
const LOGIN_URL_PATH = "/longPolling/loginUrl";
/** 米家 App 的 service id（现代米家登录；旧 `xiaomiio` 会拿到云端认不出的会话）。 */
export const MIHOME_SID = "mijia";
const LOCALE = "zh_CN";
/**
 * 现代 `sid=mijia` 会话的设备 API 主机。
 *
 * 真机实测：`sid=mijia` 的 serviceToken 发到 `api.io.mi.com` 一律回 auth error，设备一条也
 * 列不出来；参考实现（Do1e/mijia-api、@zythum02/mijia-api）2025-11 起也已迁到这个主机。
 *
 * 归属证据（2026-09-19 本机可复核，改这个常量前先看《改造计划》§4.13 第十九轮（六））：
 * ① 两个主机对同一个 `/app/*` 请求返回**逐字节相同**的响应（401 + `{"code":0,"message":"auth error"}`，
 * `server: Tengine`）；② 证书同属 DigiCert 同一 DV CA 族；③ 小米官方项目 xiaomi-miloco 用同父域的
 * `mico.api.mijia.tech` 做 OAuth。证据只到这一步——它不是小米公开文档里的端点。
 */
const DEFAULT_API_HOST = "https://api.mijia.tech";
/** deviceId 的字符集（参考实现口径：16 位随机串，无固定前缀）。 */
const DEVICE_ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** 生成设备标识：登录时作为 `deviceId`，会话 cookie 里同时作为 `PassportDeviceId`。 */
export function generateDeviceId(random = Math.random, length = 16) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += DEVICE_ID_CHARS[Math.floor(random() * DEVICE_ID_CHARS.length)];
  }
  return out;
}

/** serviceLogin 需要的 `pass_o`：16 位小写十六进制。 */
export function generatePassO() {
  return randomBytes(8).toString("hex");
}

/**
 * 米家登录风控不接受普通固定 UA：参考实现首登生成并在 serviceLogin / QR / lp / callback
 * 四步复用一串 App 身份。这里生成同形态的随机值；它不是凭据，也不落库（会随 login auth 上下文传递）。
 */
export function generateAppUserAgent(locale = LOCALE, passO = generatePassO()) {
  const country = locale.split("_")[1] ?? "CN";
  const hex = (bytes) => randomBytes(bytes).toString("hex").toUpperCase();
  return `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${hex(20)}-${country}-${hex(16)}-${hex(16)}-SmartHome-MI_APP_STORE-${hex(20)}|${hex(20)}|${passO}-64`;
}

function accountHeaders(userAgent) {
  return {
    "user-agent": userAgent,
    "accept-encoding": "gzip",
    "content-type": "application/x-www-form-urlencoded",
    connection: "keep-alive",
  };
}

function serviceLoginCookie(auth) {
  return [
    `deviceId=${auth.deviceId ?? ""}`,
    `pass_o=${auth.passO ?? ""}`,
    `passToken=${auth.passToken ?? ""}`,
    `userId=${auth.userId ?? ""}`,
    `cUserId=${auth.cUserId ?? ""}`,
    `uLocale=${auth.locale ?? LOCALE}`,
  ].join("; ");
}

function timezoneCookies(now = new Date()) {
  const timezoneId =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const currentOffset = -now.getTimezoneOffset();
  const sign = currentOffset >= 0 ? "+" : "-";
  const abs = Math.abs(currentOffset);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  const year = now.getFullYear();
  const january = new Date(year, 0, 1).getTimezoneOffset();
  const july = new Date(year, 6, 1).getTimezoneOffset();
  const standardOffset = Math.max(january, july);
  return {
    timezone_id: timezoneId,
    timezone: `GMT${sign}${hours}:${minutes}`,
    is_daylight: String(now.getTimezoneOffset() < standardOffset),
    dst_offset: String(Math.abs(january - july) * 60_000),
  };
}

function b64encode(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(text) {
  return Buffer.from(text, "base64");
}

/** 12 字节 nonce：前 8 随机 + 后 4 为「分钟数」（变长大端，去掉前导零字节）。 */
export function generateNonce(now = Date.now()) {
  const minutes = Math.floor(now / 60000);
  const tail = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (minutes >>> shift) & 0xff;
    if (tail.length > 0 || byte !== 0) tail.push(byte);
  }
  return b64encode(Buffer.concat([randomBytes(8), Buffer.from(tail)]));
}

export function computeSignedNonce(ssecurity, nonce) {
  const digest = createHash("sha256")
    .update(Buffer.concat([b64decode(ssecurity), b64decode(nonce)]))
    .digest();
  return b64encode(digest);
}

/**
 * 标准 RC4，但**先丢弃 1024 字节密钥流**（米家云协议口径，加解密两侧都要做）。
 * Node 的 crypto 在 OpenSSL 3 下不再提供 rc4，故这里自实现（约 20 行，无依赖）。
 */
export function rc4(keyBytes, dataBytes) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  let i = 0;
  j = 0;
  const nextByte = () => {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    return s[(s[i] + s[j]) & 0xff];
  };
  for (let drop = 0; drop < 1024; drop += 1) nextByte();
  const out = new Uint8Array(dataBytes.length);
  for (let n = 0; n < dataBytes.length; n += 1) {
    out[n] = dataBytes[n] ^ nextByte();
  }
  return out;
}

export function rc4EncryptBase64(keyBase64, plaintext) {
  return b64encode(rc4(b64decode(keyBase64), Buffer.from(plaintext, "utf8")));
}

/**
 * 签名字符串：`METHOD&uri[&k=v…]&signedNonce`（参数按**插入顺序**，不排序）。
 * 服务端按收到的表单顺序复算，故只要发送顺序与签名顺序一致即可对上。
 */
export function buildSignature({ method, uri, params, signedNonce }) {
  const segments = [method.toUpperCase(), uri];
  for (const [key, value] of Object.entries(params ?? {})) {
    segments.push(`${key}=${value}`);
  }
  segments.push(signedNonce);
  return b64encode(
    createHash("sha1").update(segments.join("&"), "utf8").digest(),
  );
}

/** 账号接口的响应带 `&&&START&&&` 前缀，取其中的 JSON 体。 */
export function parseAccountPayload(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`米家账号接口返回了非 JSON 内容：${text.slice(0, 80)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function collectCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const jar = {};
  for (const line of raw) {
    const [pair] = String(line).split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return jar;
}

/** 把参数值规整成「可加密的字符串」：对象/数组走 JSON，其余 String()。 */
function encodeParamValue(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 区域 API 主机归一：登录响应给的 `location` 是 **STS** 主机
 * （`https://sts.api.io.mi.com/sts?...`），而 `/app/*` 只在区域 API 主机上存在
 * （CN = `https://api.io.mi.com`，其它区 = `de.`/`i2.`/`ru.`/`sg.`/`us.` 前缀）。
 * 不去掉 `sts.` 会**稳定 404**（真机实测：面板报「米家云响应无法解密（HTTP 404…）」）。
 * 解析不出主机时回落到默认 CN 入口，不把坏地址带进后续请求。
 */
export function normalizeApiHost(host) {
  try {
    const url = new URL(host);
    if (!url.hostname) return DEFAULT_API_HOST;
    url.hostname = url.hostname.replace(/^sts\./, "");
    return url.origin;
  } catch {
    return DEFAULT_API_HOST;
  }
}

/**
 * 设备 API 的 CookieJar：优先用 `sid=xiaomiio` 的 STS 会话（`apiCookies`），
 * 否则退回登录时直接带来的字段（老测试/老会话）。
 *
 * 为什么这样设计：二维码走现代 `sid=mijia` 登录（App 扫码的口径），但设备 API 认的是
 * `sid=xiaomiio` 的 serviceToken；账号级的 `passToken` 可以经 `serviceLogin?sid=xiaomiio`
 * 兑换一次（`refreshApiSession`），兑换链全程只在 account.xiaomi.com 与 sts.api.io.mi.com 上。
 */
export function apiCookieJar(session) {
  const locale = session.locale ?? LOCALE;
  const jar = {
    ...(session.apiCookies ?? {}),
    ...timezoneCookies(),
    channel: "MI_APP_STORE",
    countryCode: locale.split("_")[1] ?? "CN",
    locale,
  };
  if (session.deviceId) jar.PassportDeviceId = session.deviceId;
  if (!session.apiCookies) {
    // 回退：登录 callback 直接给的 serviceToken（老流程/老测试）
    if (session.cUserId) jar.cUserId = session.cUserId;
    if (session.serviceToken) {
      jar.serviceToken = session.serviceToken;
      jar.yetAnotherServiceToken = session.serviceToken;
    }
  }
  return jar;
}

/**
 * 现代米家登录会话版本，读取时不匹配就清库并让用户重扫。
 *
 * `mijia-v1` → `mijia-v2`：设备 API 主机从 `api.io.mi.com` 改到 `api.mijia.tech`（见
 * `DEFAULT_API_HOST`）。存量会话里存着旧主机，改口径只发生在**新登录**上，所以旧会话必须作废——
 * 与其在读取时悄悄把凭据改道到另一个主机，不如让用户明确重扫一次。
 */
export const MIHOME_AUTH_VERSION = "mijia-v2";
/** 设备 API 的 service id（兑换用；`sid=mijia` 的令牌设备 API 不认）。 */
export const API_SID = "xiaomiio";

export function createMihomeClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accountHost = options.accountHost ?? ACCOUNT_HOST;
  const logger = options.logger ?? { warn: () => {}, info: () => {} };

  async function request(session, uri, params, method = "POST") {
    if (session.authVersion !== MIHOME_AUTH_VERSION) {
      throw new Error(
        "米家会话版本过旧（本轮换了设备 API 主机）：请断开后重新扫码。",
      );
    }
    if (!session.passToken || !session.ssecurity) {
      throw new Error("米家会话不完整：缺 passToken/ssecurity，请重新扫码。");
    }
    if (!apiCookieJar(session).serviceToken) {
      throw new Error(
        "米家会话还没有设备 API 令牌（serviceToken=xiaomiio）：请重新扫码一次完成兑换。",
      );
    }
    const apiHost = normalizeApiHost(session.apiHost ?? DEFAULT_API_HOST);
    const nonce = generateNonce();
    const signedNonce = computeSignedNonce(session.ssecurity, nonce);

    // 1) 明文业务参数 → rc4_hash__ → 2) **连同 rc4_hash__ 一起**加密每个值
    //    → 3) 用密文参数算 signature（顺序自始至终为 rc4_hash__ 在前）
    const plainParams = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      plainParams[key] = encodeParamValue(value);
    }
    const rc4Hash = buildSignature({
      method,
      uri,
      params: plainParams,
      signedNonce,
    });
    const withHash = { rc4_hash__: rc4Hash, ...plainParams };
    const encrypted = {};
    for (const [key, value] of Object.entries(withHash)) {
      encrypted[key] = rc4EncryptBase64(signedNonce, value);
    }
    const signature = buildSignature({
      method,
      uri,
      params: encrypted,
      signedNonce,
    });

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(encrypted)) body.set(key, value);
    body.set("signature", signature);
    body.set("ssecurity", session.ssecurity);
    body.set("_nonce", nonce);

    const response = await fetchImpl(`${apiHost}/app${uri}`, {
      method,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept-encoding": "gzip",
        "user-agent":
          session.userAgent ??
          generateAppUserAgent(
            session.locale ?? LOCALE,
            session.passO ?? generatePassO(),
          ),
        "x-xiaomi-protocal-flag-cli": "1",
        "miot-accept-encoding": "gzip",
        "miot-encrypt-algorithm": "ENCRYPT-RC4",
        cookie: cookieHeader(session),
      },
      body: body.toString(),
    });

    const raw = await response.text();
    const text = decodeResponse(raw, signedNonce);
    if (!text) {
      throw new Error(
        `米家云响应无法解密（HTTP ${response.status}，可能区域主机或签名口径不匹配）。`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`米家云返回了非 JSON 内容：${text.slice(0, 120)}`);
    }
    if (payload.code !== 0) {
      throw new Error(
        `米家云接口 ${uri} 返回 code=${payload.code}：${payload.message ?? ""} ${payload.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  /**
   * 响应解码：**成功体**是 RC4 加密的；**错误体可能是明文 JSON**（实测：用坏凭证打 /app/ 时，
   * 云端直接回明文 `{"code":…}`）。因此先按明文 JSON 试（base64 字母表里没有 `{`，不会误判），
   * 再按 RC4 解；两者都不像 JSON 时返回空串，由调用方给出可读错误。
   */
  function decodeResponse(raw, signedNonce) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
    try {
      const plain = Buffer.from(
        rc4(b64decode(signedNonce), b64decode(trimmed)),
      );
      const bytes =
        plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b
          ? gunzipSync(plain)
          : plain;
      const text = bytes.toString("utf8");
      return text.startsWith("{") || text.startsWith("[") ? text : "";
    } catch (error) {
      logger.warn("米家云响应解密失败：", error);
      return "";
    }
  }

  function cookieHeader(session) {
    return Object.entries(apiCookieJar(session))
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  /**
   * 用账号级 passToken 兑换设备 API（sid=xiaomiio）的 serviceToken。
   *
   * 二维码走 sid=mijia（App 扫码口径），但设备 API 认的是 `sid=xiaomiio` 的 serviceToken。
   * 账号级 passToken 可以经官方 passport 流程 `serviceLogin?sid=xiaomiio` → STS 兑换一次——
   * 这条兑换链只在 account.xiaomi.com 与 sts.api.io.mi.com 上，不碰设备 API 主机。
   */
  async function refreshApiSession(session) {
    const auth = {
      deviceId: session.deviceId,
      passO: session.passO,
      passToken: session.passToken,
      userId: session.userId,
      cUserId: session.cUserId,
      locale: session.locale ?? LOCALE,
    };
    if (!auth.passToken) {
      throw new Error(
        "米家会话缺 passToken，无法兑换设备 API 令牌：请重新扫码。",
      );
    }
    const serviceUrl = new URL(SERVICE_LOGIN_PATH, accountHost);
    serviceUrl.searchParams.set("_json", "true");
    serviceUrl.searchParams.set("sid", API_SID);
    serviceUrl.searchParams.set("_locale", auth.locale);
    const serviceResponse = await fetchImpl(serviceUrl, {
      headers: {
        ...accountHeaders(auth.userAgent),
        cookie: serviceLoginCookie(auth),
      },
    });
    const serviceData = parseAccountPayload(await serviceResponse.text());
    if (Number(serviceData.code) !== 0 || !serviceData.location) {
      throw new Error(
        `米家登录已失效（serviceLogin code=${serviceData.code ?? "?"}）——请点「断开」后重新扫码。`,
      );
    }
    // 参考实现的刷新口径：location 请求 redirect: manual，200 + 正文 ok 才算换到
    const stsResponse = await fetchImpl(serviceData.location, {
      headers: accountHeaders(auth.userAgent),
      redirect: "manual",
    });
    const body = (await stsResponse.text()).trim();
    if (stsResponse.status !== 200 || body !== "ok") {
      throw new Error(
        `米家令牌兑换失败（HTTP ${stsResponse.status}）：${body.slice(0, 60) || "响应为空"}`,
      );
    }
    const cookies = collectCookies(stsResponse);
    // `yetAnotherServiceToken` 是参考实现 API CookieJar 的必需键，与 serviceToken 同值。
    if (cookies.serviceToken)
      cookies.yetAnotherServiceToken = cookies.serviceToken;
    return cookies;
  }

  /** 第三步：二维码轮询成功后，用 callback location 换 `serviceToken`。 */
  async function completeQrLogin(payload, auth) {
    const location = String(payload.location ?? "");
    if (!location) {
      throw new Error("米家扫码响应缺少 location（登录流程可能已变更）。");
    }
    // 参考实现：二维码成功后的 callback **不手工拼 Cookie**，默认跟随跳转；
    // serviceToken 来自最终响应的 Set-Cookie。
    const response = await fetchImpl(location, {
      headers: accountHeaders(auth.userAgent),
    });
    await response.text();
    const jar = collectCookies(response);
    if (!jar.serviceToken) {
      throw new Error("米家登录未返回 serviceToken（回调 Cookie 不完整）。");
    }
    const locale = auth.locale ?? LOCALE;
    return {
      authVersion: MIHOME_AUTH_VERSION,
      sid: MIHOME_SID,
      userAgent: auth.userAgent,
      passO: auth.passO,
      locale,
      psecurity: String(payload.psecurity ?? ""),
      nonce: String(payload.nonce ?? ""),
      ssecurity: String(payload.ssecurity ?? ""),
      passToken: String(payload.passToken ?? jar.passToken ?? ""),
      userId: String(payload.userId ?? jar.userId ?? ""),
      cUserId: String(payload.cUserId ?? jar.cUserId ?? ""),
      serviceToken: jar.serviceToken,
      // 设备 API 只打 DEFAULT_API_HOST（`sid=mijia` 令牌在别的区域主机上会被拒，见该常量注释）。
      apiHost: DEFAULT_API_HOST,
      cookies: jar,
      deviceId: auth.deviceId,
      expireTime: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
  }

  /**
   * 第二步：对 loginUrl 返回的 lp 做长轮询。lp 自带完整 query，不能自行拼旧版 `_` 参数。
   * 超时/断线不算失败——面板收到 expired 会自动换新码（用户不需要手点）。
   */
  async function pollQrLogin(lp, auth) {
    let response;
    try {
      response = await fetchImpl(lp, {
        headers: accountHeaders(auth.userAgent),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      // 120s 内没人扫（AbortSignal 到期）或网络瞬断 → 换新码，不卡死面板
      return { status: "expired", wait: 2000 };
    }
    const payload = parseAccountPayload(await response.text());
    if (!payload.ssecurity || !payload.location) {
      return {
        status: Number(payload.code) === 0 ? "pending" : "expired",
        wait: 2000,
      };
    }
    return {
      status: "ok",
      session: await completeQrLogin(payload, auth),
    };
  }

  /** 单个家庭下的设备（分页，最多 5 页，够日常家庭规模）。 */
  async function listHomeDevices(session, home) {
    const devices = [];
    let startDid = "";
    for (let page = 0; page < 5; page += 1) {
      const result = await request(session, "/home/home_device_list", {
        home_owner: Number(home?.uid ?? 0),
        home_id: Number(home?.id ?? 0),
        limit: 200,
        start_did: startDid,
        get_split_device: true,
        support_smart_home: true,
        get_cariot_device: true,
        get_third_device: true,
      });
      const list = Array.isArray(result?.device_info) ? result.device_info : [];
      for (const item of list) {
        devices.push({ ...item, home_id: home?.id, home_name: home?.name });
      }
      if (!result?.has_more || !result?.max_did) break;
      startDid = String(result.max_did);
    }
    return devices;
  }

  /** 家庭列表（新接口的先导调用）。 */
  async function listHomes(session) {
    const result = await request(session, "/v2/homeroom/gethome_merged", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
    });
    return Array.isArray(result?.homelist) ? result.homelist : [];
  }

  return {
    listHomes,
    refreshApiSession,
    /**
     * 第一步：现代米家登录必须先 `serviceLogin?sid=mijia`，再把它返回的 location query
     * 带进 longPolling/loginUrl。旧版直接 `sid=xiaomiio` 出码会扫出「云端不认」的半会话。
     */
    async createQrLogin() {
      const passO = generatePassO();
      const auth = {
        deviceId: generateDeviceId(),
        passO,
        locale: LOCALE,
        userAgent: generateAppUserAgent(LOCALE, passO),
      };
      const serviceUrl = new URL(SERVICE_LOGIN_PATH, accountHost);
      serviceUrl.searchParams.set("_json", "true");
      serviceUrl.searchParams.set("sid", MIHOME_SID);
      serviceUrl.searchParams.set("_locale", LOCALE);
      const serviceResponse = await fetchImpl(serviceUrl, {
        headers: {
          ...accountHeaders(auth.userAgent),
          cookie: serviceLoginCookie(auth),
        },
      });
      const serviceData = parseAccountPayload(await serviceResponse.text());
      if (!serviceData.location) {
        throw new Error(
          `米家 serviceLogin 没有返回 location（code=${serviceData.code ?? "?"}）。`,
        );
      }

      const query = new URL(String(serviceData.location)).searchParams;
      query.set("theme", "");
      query.set("bizDeviceType", "");
      query.set("_hasLogo", "false");
      query.set("_qrsize", "480");
      query.set("_dc", String(Date.now()));
      const url = `${accountHost}${LOGIN_URL_PATH}?${query.toString()}`;
      const response = await fetchImpl(url, {
        headers: accountHeaders(auth.userAgent),
      });
      const payload = parseAccountPayload(await response.text());
      if (Number(payload.code) !== 0 || !payload.qr || !payload.lp) {
        throw new Error(
          `米家登录接口没有返回二维码（code=${payload.code ?? "?"}）：${payload.description ?? payload.message ?? "接口可能已变更"}`,
        );
      }
      return {
        qrUrl: String(payload.qr),
        loginUrl: String(payload.loginUrl ?? ""),
        lp: String(payload.lp),
        timeout: 120,
        auth,
      };
    },

    pollQrLogin,
    completeQrLogin,

    /**
     * 设备列表：走**家庭维度**的新接口（米家 App 现用的口径）。
     *
     * 先去家庭列表（`/v2/homeroom/gethome_merged`）拿 home_id/home_owner，再逐家庭
     * `/home/home_device_list`（带 `home_owner`/`home_id` 等参数，分页靠 `max_did`/`has_more`）。
     * 老账号（没有「家庭」模型）在新接口下会拿到 0 台，此时**兜底**用经典
     * `/home/device_list` 再拉一次——两条路都失败才如实报错。
     */
    async listDevices(session) {
      const homes = await listHomes(session);
      const devices = [];
      for (const home of homes) {
        devices.push(...(await listHomeDevices(session, home)));
      }
      if (devices.length > 0) return { devices, homeCount: homes.length };

      const classic = await request(session, "/home/device_list", {
        getVirtualModel: true,
        getHuamiDevices: 1,
      });
      return {
        devices: Array.isArray(classic?.list) ? classic.list : [],
        homeCount: homes.length,
      };
    },

    /** 读属性（MIoT-Spec 的 siid/piid）。 */
    async getProps(session, params) {
      const result = await request(session, "/miotspec/prop/get", { params });
      return Array.isArray(result) ? result : [];
    },

    /** 写属性。 */
    async setProp(session, param) {
      const result = await request(session, "/miotspec/prop/set", {
        params: [param],
      });
      return Array.isArray(result) ? result : [];
    },

    /** 调动作（如空调模式、扫地机开始清扫）。 */
    async callAction(session, param) {
      const result = await request(session, "/miotspec/action", {
        params: [param],
      });
      return Array.isArray(result) ? result : [];
    },

    logger,
  };
}
