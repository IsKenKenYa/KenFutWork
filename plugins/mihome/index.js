/**
 * 米家插件：把米家设备接进工作台——侧栏面板可看可控制，agent 也能直接操作。
 *
 * 能力面：`tools`（agent 工具）+ `routes`（面板用的 HTTP 面）+ `ui`（侧栏入口）
 * + `storage`（米家会话加密落库，服务端重启后免扫码）。
 *
 * 与内核的约定：
 * - 路由**默认私有**（要求登录）：面板是同源 iframe，宿主会经 `postMessage` 把令牌递进来
 *   （`apps/web/src/lib/plugin-panels.tsx` 的握手），面板带 `Authorization` 调这里的路由；
 * - 工作区由调用方显式传入：路由取 `request.workspaceId`、工具取执行上下文 `exec.workspaceId`，
 *   插件存储按工作区隔离（多用户自托管时各连各的米家账号）；
 * - 米家会话只落在插件存储里（值加密落库、HTTP 永不回显），进程内另存一份内存副本省往返。
 */

import {
  createSpecResolver,
  describeDevice,
  mergeValues,
  propertyKey,
  selectProperties,
} from "./lib/device-model.js";
import { createMihomeClient, generateDeviceId } from "./lib/micloud.js";

export const name = "kenfutwork-mihome";

export const inject = ["tools", "routes", "ui", "storage"];

/** 设备列表缓存：米家云按天不变，5 分钟内不重复拉。 */
const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;
/** 二维码会话有效期（米家侧 timeout 通常 2 分钟，留点余量）。 */
const QR_SESSION_TTL_MS = 3 * 60 * 1000;
/** 单次批量读属性上限（云端按条计费心跳，别把一次面板刷新拆成 N 个请求）。 */
const PROP_BATCH_SIZE = 100;
/** 一次最多读多少个器件的属性（器件多时先保证面板能动，不追求一次全刷）。 */
const MAX_DEVICES_PER_REFRESH = 40;
const SESSION_KEY = "session";

function notConnectedError() {
  return {
    status: 401,
    body: {
      error:
        "尚未连接米家账号：请在工作台侧栏打开「米家」面板扫码连接（一次即可，之后服务端重启也无需重扫）。",
      code: "not_connected",
    },
  };
}

export function apply(ctx) {
  const client = createMihomeClient({ logger: ctx.logger });
  const specs = createSpecResolver({ logger: ctx.logger });

  /** 会话内存副本（键=工作区）：省掉每次面板轮询的存储解密。 */
  const sessions = new Map();
  /** 设备列表缓存（键=工作区）。 */
  const deviceCache = new Map();
  /** 二维码登录会话（键=随机 id）。 */
  const qrSessions = new Map();

  function requireWorkspace(workspaceId, where) {
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      throw new Error(
        `${where}缺少工作区上下文（路由需登录态、工具需 agent 运行上下文）——插件存储按工作区隔离，不能凭空取一个。`,
      );
    }
    return workspaceId;
  }

  async function readSession(workspaceId) {
    const cached = sessions.get(workspaceId);
    if (cached) return cached;
    const raw = await ctx.storage.get(workspaceId, SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // 存量会话（本次修复前扫的码）没有设备标识：就地补一个并落库——云端按整罐 cookie
    // 认账号，缺它会「认不出」，不能让用户为此重扫一次。
    if (!session.deviceId) {
      session.deviceId = generateDeviceId();
      await ctx.storage.set(workspaceId, SESSION_KEY, JSON.stringify(session));
    }
    sessions.set(workspaceId, session);
    return session;
  }

  async function writeSession(workspaceId, session) {
    sessions.set(workspaceId, session);
    await ctx.storage.set(
      workspaceId,
      SESSION_KEY,
      JSON.stringify({ ...session, savedAt: new Date().toISOString() }),
    );
    deviceCache.delete(workspaceId);
  }

  async function clearSession(workspaceId) {
    sessions.delete(workspaceId);
    deviceCache.delete(workspaceId);
    await ctx.storage.remove(workspaceId, SESSION_KEY);
  }

  async function loadDevices(workspaceId, session, { refresh = false } = {}) {
    const cached = deviceCache.get(workspaceId);
    if (!refresh && cached && Date.now() - cached.at < DEVICE_CACHE_TTL_MS) {
      return cached;
    }
    const { devices, homeCount } = await client.listDevices(session);
    const entry = { at: Date.now(), list: devices, homeCount };
    deviceCache.set(workspaceId, entry);
    return entry;
  }

  /**
   * 空设备列表时的确诊：是「真的没有设备」，还是「会话没被云端认出来」。
   *
   * 两种情形在正常基址上长得一模一样（`api.io.mi.com` 对无效会话静默回空列表），
   * 所以换一个严格校验会话的基址问一次，把「静默空」翻译成用户能照着做的一句话。
   */
  async function diagnoseEmptySession(session) {
    try {
      const homes = await client.probeSessionAuth(session);
      return homes > 0 ? "云端认得这次会话，但该账号下没有设备。" : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 确诊本身不可用（网络/DNS）时不误导用户
      if (/fetch failed|ENOTFOUND|EAI_AGAIN|timeout/i.test(message))
        return null;
      return `云端没有认出这次会话（${message}）——请点「断开」后重新扫码，让整段会话重新落库。`;
    }
  }

  /**
   * 器件视图：[{...基础字段, properties:[…], specError?}]。
   * 逐器件解析规格（有缓存），再批量读一次属性值；某个器件规格解析失败不影响其它器件。
   */
  async function buildDeviceView(session, rawList) {
    const targets = rawList
      .map(describeDevice)
      .filter((device) => device.did)
      .slice(0, MAX_DEVICES_PER_REFRESH);

    const specErrors = [];
    const planned = [];
    for (const device of targets) {
      try {
        const spec = await specs.loadSpec(device.model);
        planned.push({ device, properties: selectProperties(spec) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        specErrors.push({ did: device.did, name: device.name, error: message });
        planned.push({ device, properties: [] });
      }
    }

    // 离线器件不读值（读了也是旧值），但保留在列表里如实显示离线
    const online = planned.filter((item) => item.device.online);
    const params = [];
    for (const item of online) {
      for (const property of item.properties) {
        params.push({
          did: item.device.did,
          siid: property.siid,
          piid: property.piid,
        });
      }
    }

    const values = [];
    for (let index = 0; index < params.length; index += PROP_BATCH_SIZE) {
      const chunk = params.slice(index, index + PROP_BATCH_SIZE);
      if (chunk.length === 0) continue;
      try {
        values.push(...(await client.getProps(session, chunk)));
      } catch (error) {
        specErrors.push({
          did: "",
          name: "属性读取",
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    const valuesByDid = new Map();
    for (const item of values) {
      const key = String(item.did);
      const bucket = valuesByDid.get(key) ?? [];
      bucket.push(item);
      valuesByDid.set(key, bucket);
    }

    return {
      devices: planned.map((item) => ({
        ...item.device,
        properties: mergeValues(
          item.properties,
          valuesByDid.get(item.device.did) ?? [],
        ),
        hasSpec: item.properties.length > 0,
      })),
      specErrors,
      total: rawList.length,
    };
  }

  // === 路由（私有：面板经宿主握手拿到令牌后带 Authorization 调用）===

  ctx.routes.register({
    path: "login/qr",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "获取二维码");
      const { qrUrl, lp, timeout } = await client.createQrLogin();
      const sessionId = `qr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      for (const [id, item] of qrSessions) {
        if (Date.now() - item.at > QR_SESSION_TTL_MS) qrSessions.delete(id);
      }
      qrSessions.set(sessionId, { lp, workspaceId, at: Date.now() });
      return { status: 200, body: { sessionId, qrUrl, timeout } };
    },
  });

  ctx.routes.register({
    path: "login/poll",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "轮询扫码结果");
      const sessionId = request.query.sessionId ?? "";
      const entry = qrSessions.get(sessionId);
      if (!entry || entry.workspaceId !== workspaceId) {
        return {
          status: 410,
          body: { error: "二维码会话已失效，请重新获取。", code: "qr_expired" },
        };
      }
      const result = await client.pollQrLogin(entry.lp);
      if (result.status !== "ok") {
        if (result.status === "expired") qrSessions.delete(sessionId);
        return {
          status: 200,
          body: { status: result.status, wait: result.wait },
        };
      }
      await writeSession(workspaceId, result.session);
      qrSessions.delete(sessionId);
      return { status: 200, body: { status: "ok" } };
    },
  });

  ctx.routes.register({
    path: "status",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "读取连接状态");
      const session = await readSession(workspaceId);
      return {
        status: 200,
        body: {
          connected: Boolean(session),
          // 只回可展示的元信息：令牌与 ssecurity 绝不出插件（BYOK 同一条红线）
          userId: session?.userId ?? null,
          apiHost: session?.apiHost ?? null,
          savedAt: session?.savedAt ?? null,
        },
      };
    },
  });

  ctx.routes.register({
    path: "devices",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "列设备");
      const session = await readSession(workspaceId);
      if (!session) return notConnectedError();
      const { list, homeCount } = await loadDevices(workspaceId, session, {
        refresh: request.query.refresh === "1",
      });
      const view = await buildDeviceView(session, list);
      const authHint =
        view.devices.length === 0 ? await diagnoseEmptySession(session) : null;
      return {
        status: 200,
        body: {
          ...view,
          homeCount,
          authHint,
          updatedAt: new Date().toISOString(),
        },
      };
    },
  });

  ctx.routes.register({
    path: "control",
    method: "POST",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "控制设备");
      const session = await readSession(workspaceId);
      if (!session) return notConnectedError();
      const body = request.body ?? {} ?? {};
      const did = typeof body.did === "string" ? body.did : "";
      const siid = Number(body.siid);
      const piid = Number(body.piid);
      if (!did || !Number.isInteger(siid) || !Number.isInteger(piid)) {
        return {
          status: 400,
          body: { error: "控制参数不完整：需要 did / siid / piid。" },
        };
      }
      const written = await client.setProp(session, {
        did,
        siid,
        piid,
        value: body.value,
      });
      const code = written[0]?.code ?? null;
      // 读回真值：米家云会「接受指令但器件不响应」，只报成功是假成功
      let value = null;
      try {
        const read = await client.getProps(session, [{ did, siid, piid }]);
        value = read[0]?.value ?? null;
      } catch (error) {
        ctx.logger.warn("米家控制后读回失败：", error);
      }
      return {
        status: code === 0 ? 200 : 502,
        body: {
          ok: code === 0,
          code,
          value,
          message: code === 0 ? "已下发" : `米家云返回 code=${code}`,
        },
      };
    },
  });

  ctx.routes.register({
    path: "disconnect",
    method: "POST",
    handler: async (request) => {
      const workspaceId = requireWorkspace(request.workspaceId, "断开连接");
      await clearSession(workspaceId);
      return { status: 200, body: { ok: true } };
    },
  });

  // === UI：侧栏入口（面板页由本插件自带，见 assets/panel.html）===
  ctx.ui.register({
    id: "mihome",
    title: "米家",
    slot: "sidebar",
    url: "assets/panel.html",
  });

  // === agent 工具：与面板共用同一份会话与规格解析 ===

  ctx.tools.register({
    name: "mihome_devices",
    description:
      "列出米家设备：名称、在线状态、房间，以及每台设备可读写的属性（含 siid/piid 与当前值）。控制设备前先用本工具拿到目标属性的 siid/piid。",
    parameters: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "true 时忽略 5 分钟缓存强制刷新",
        },
      },
    },
    execute: async (args, exec) => {
      const workspaceId = requireWorkspace(exec?.workspaceId, "工具调用");
      const session = await readSession(workspaceId);
      if (!session) {
        throw new Error(
          "尚未连接米家账号：请在工作台侧栏打开「米家」面板扫码连接一次（之后服务端重启也无需重扫）。",
        );
      }
      const { list, homeCount } = await loadDevices(workspaceId, session, {
        refresh: args?.refresh === true,
      });
      const view = await buildDeviceView(session, list);
      return {
        devices: view.devices.map((device) => ({
          did: device.did,
          name: device.name,
          online: device.online,
          room: device.room,
          model: device.model,
          properties: device.properties.map((property) => ({
            siid: property.siid,
            piid: property.piid,
            name: property.name,
            writable: property.writable,
            value: property.value ?? null,
            ...(property.valueList ? { options: property.valueList } : {}),
          })),
        })),
        specErrors: view.specErrors,
        total: view.total,
        homeCount,
        // 空列表时把「是真的没设备，还是会话没被认出来」这条信息一并给模型
        ...(view.devices.length === 0
          ? { note: await diagnoseEmptySession(session) }
          : {}),
      };
    },
  });

  ctx.tools.register({
    name: "mihome_control",
    description:
      "写米家设备的某个属性（开关、亮度、模式等）。siid/piid 与可用取值先用 mihome_devices 查；返回里带读回的真值，便于确认是否真的生效。",
    parameters: {
      type: "object",
      properties: {
        did: {
          type: "string",
          description: "设备 id（mihome_devices 返回的 did）",
        },
        siid: { type: "number", description: "服务实例 id" },
        piid: { type: "number", description: "属性实例 id" },
        value: {
          description:
            "目标值：开关类用 true/false；数值类用数字；枚举类用 valueList 里的 value",
        },
      },
      required: ["did", "siid", "piid", "value"],
    },
    execute: async (args, exec) => {
      const workspaceId = requireWorkspace(exec?.workspaceId, "工具调用");
      const session = await readSession(workspaceId);
      if (!session) {
        throw new Error(
          "尚未连接米家账号：请在工作台侧栏打开「米家」面板扫码连接一次（之后服务端重启也无需重扫）。",
        );
      }
      const did = String(args?.did ?? "");
      const siid = Number(args?.siid);
      const piid = Number(args?.piid);
      if (!did || !Number.isInteger(siid) || !Number.isInteger(piid)) {
        throw new Error("控制参数不完整：需要 did / siid / piid。");
      }
      const written = await client.setProp(session, {
        did,
        siid,
        piid,
        value: args?.value,
      });
      const code = written[0]?.code ?? null;
      if (code !== 0) {
        throw new Error(`米家云拒绝了这次写入（code=${code}）。`);
      }
      const read = await client.getProps(session, [{ did, siid, piid }]);
      return {
        ok: true,
        did,
        key: propertyKey(siid, piid),
        value: read[0]?.value ?? null,
      };
    },
  });
}
