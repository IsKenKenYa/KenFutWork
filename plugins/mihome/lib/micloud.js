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
const LOGIN_URL_PATH = "/longPolling/loginUrl";
/** 米家 App 的 service id（登录授权对象）。 */
const SID = "xiaomiio";
const DEFAULT_API_HOST = "https://api.io.mi.com";
/**
 * 确诊用基址（第三方实现 @zythum02/mijia-api 的基址，2026-09 在线）。
 * 它**严格校验会话**：会话无效时明确回 `code=2 auth error`；而 `api.io.mi.com`
 * 对无效会话静默返回空列表。**不参与正常链路**，只在空结果时问一次用于读数归因。
 */
const DIAGNOSTIC_API_HOST = "https://api.mijia.tech";
/** 常见于各家实现的 UA：服务端按它判定「客户端是 App」而非浏览器。 */
const USER_AGENT =
  "Android-7.1.1-1.0.0-ONEPLUS A3010-136-6C3D5A0D1D1C APP/com.xiaomi.mihome APPV/6.0.103 ios_webview";

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
 * 会话 cookie 罐：登录时把 STS 响应的整罐 cookie 存下来，这里再补齐必需项。
 *
 * 为什么不能只挑几个字段：云端按**整罐**识别会话（`serviceToken` 之外还要
 * `PassportDeviceId`/`yetAnotherServiceToken` 等）。只送四个字段时云端不报错、
 * 只是**认不出账号**——`device_list` 稳定返回空列表（真机踩到：能通、0 设备）。
 * 老会话（只有 `serviceToken`/`userId`/`cUserId`）在这里就地补齐，免得重新扫码。
 */
export function sessionCookies(session) {
  const jar = { ...(session.cookies ?? {}) };
  if (session.userId) jar.userId = session.userId;
  if (session.serviceToken) jar.serviceToken = session.serviceToken;
  if (session.cUserId) jar.cUserId = session.cUserId;
  if (session.passToken) jar.passToken = session.passToken;
  const deviceId = session.deviceId || jar.deviceId;
  if (deviceId) {
    jar.deviceId = deviceId;
    jar.PassportDeviceId = jar.PassportDeviceId ?? deviceId;
  }
  jar.locale = jar.locale ?? "zh_CN";
  return jar;
}

export function createMihomeClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accountHost = options.accountHost ?? ACCOUNT_HOST;
  const logger = options.logger ?? { warn: () => {}, info: () => {} };

  async function request(session, uri, params, method = "POST") {
    // 存量会话里可能存着 STS 主机（登录响应给的就是它）——读取时同样归一，
    // 免得修完还要用户重新扫码。
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
        "user-agent": USER_AGENT,
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
    return Object.entries(sessionCookies(session))
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  /** 第三步：用 `location` 换 serviceToken（cookie）并确定区域 API 主机。 */
  async function completeQrLogin(payload) {
    const location = String(payload.location);
    const response = await fetchImpl(location, {
      headers: { "user-agent": USER_AGENT },
    });
    await response.text();
    const jar = collectCookies(response);
    if (!jar.serviceToken) {
      throw new Error("米家登录未返回 serviceToken（登录流程可能已变更）。");
    }
    return {
      userId: jar.userId ?? String(payload.userId ?? ""),
      cUserId: jar.cUserId ?? String(payload.cUserId ?? ""),
      // passToken 有时只出现在轮询响应里（不在 cookie 里）——两边都认，别丢
      passToken: jar.passToken ?? String(payload.passToken ?? ""),
      serviceToken: jar.serviceToken,
      ssecurity: String(payload.ssecurity),
      // 区域 API 主机（`location` 给的是 STS 主机，必须归一）
      apiHost: normalizeApiHost(location),
      // 整罐 cookie 与设备标识：云端按整罐识别会话，只挑字段会「认不出账号」
      cookies: jar,
      deviceId: generateDeviceId(),
    };
  }

  /**
   * 第二步：长轮询等待扫码确认。返回 `{ status, session?, wait }`：
   * - `pending`：还没扫/还没确认，按 `wait` 毫秒后再轮询；
   * - `ok`：拿到会话（已换到 serviceToken，落库即可跨重启复用）；
   * - `expired`：二维码超时，需要重新出码。
   */
  async function pollQrLogin(lp) {
    const response = await fetchImpl(`${lp}&_=${Date.now()}`, {
      headers: { "user-agent": USER_AGENT },
    });
    const payload = parseAccountPayload(await response.text());
    if (!payload.ssecurity || !payload.location) {
      return {
        status: payload.code === 70016 ? "expired" : "pending",
        wait: Number(payload.timeInterval ?? 2) * 1000 || 2000,
      };
    }
    return { status: "ok", session: await completeQrLogin(payload) };
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

  /**
   * 会话确诊：换一个**严格校验会话**的基址再问一次家庭列表。
   *
   * 为什么需要它：`api.io.mi.com` 对无效会话**静默返回空列表**（code 0 + 空数组），
   * 与「账号确实没有设备」长得一模一样；而第三方实现使用的 `api.mijia.tech` 会明确回
   * `code=2 auth error`（本机实测：半罐 cookie 的存量会话在这里被判无效）。
   * 只在正常链路拿到空列表时调用一次，把「静默空」翻译成人能读的原因。
   */
  async function probeSessionAuth(session) {
    const homes = await listHomes({ ...session, apiHost: DIAGNOSTIC_API_HOST });
    return homes.length;
  }

  return {
    listHomes,
    probeSessionAuth,
    /** 第一步：拿二维码与长轮询地址（`qr` 是小米托管的图片 URL，可直接 <img>）。 */
    async createQrLogin() {
      const url = `${accountHost}${LOGIN_URL_PATH}?sid=${SID}&_locale=zh_CN&_snsNone=true&_qrsize=480&callback=https%3A%2F%2Fsts.api.io.mi.com%2Fsts`;
      const response = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT },
      });
      const payload = parseAccountPayload(await response.text());
      if (!payload.qr || !payload.lp) {
        throw new Error("米家登录接口没有返回二维码地址（接口可能已变更）。");
      }
      return {
        qrUrl: String(payload.qr),
        lp: String(payload.lp),
        timeout: Number(payload.timeout ?? 120),
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
