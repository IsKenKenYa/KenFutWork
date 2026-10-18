/**
 * HA 实体 → 面板控件模型的纯函数（不碰网络，可独立单测）。
 *
 * 口径（《米家和HA插件规划》HA-3）：**直接用 HA 的实体模型**，不给米家/华为写任何按厂商
 * 的分支——可写性由「域 + 属性」推导，不在我们侧区分生态。
 *
 * 面板与工具都只拿到渲染描述（`controls`），**参数换算留在服务端**（`toServiceData`）：
 * 前端回传 `{service, key, value}`，由这里决定它变成 HA 的哪个 data 字段、量程是多少。
 * 这样面板改不动服务契约，脏值也进不了 HA 的服务调用。
 */

/** 读起来「没有真值」的状态：置灰，不给控件。 */
const UNAVAILABLE_STATES = new Set(["unavailable", "unknown"]);
/** 二值状态显示成中文标签（HA 的 on/off 对传感器类含义不同，读数仍按原值）。 */
const STATE_LABELS = {
  on: "开",
  off: "关",
  unknown: "未知",
  unavailable: "离线",
};
/** 注册表里没有归属时的组名。 */
export const AREA_FALLBACK = "未分区";

/**
 * 一次渲染的实体上限（HA 实例常有上千条；面板不做分页，超出如实标「只显示前 N 条」）。
 * 治理数值属主是 `packages/shared/src/governance.ts`，但插件 bundle 独立于 workspace、
 * 不能 import 它，故在本文件内命名并注释。
 */
export const MAX_ENTITIES_PER_VIEW = 500;

/** 控件与参数判定的错误：带 `code`，路由据此回 400 + 原话。 */
class ControlError extends Error {
  constructor(message) {
    super(message);
    this.name = "ControlError";
    this.code = "bad_service";
  }
}

export function entityDomain(entityId) {
  const text = String(entityId ?? "");
  const dot = text.indexOf(".");
  return dot > 0 ? text.slice(0, dot) : "";
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 注册表能给名字与归属；缺注册表（WS 未就绪）时退回 REST 属性里的 friendly_name。 */
export function displayName(entity, registryEntry) {
  return (
    registryEntry?.name ||
    registryEntry?.original_name ||
    entity?.attributes?.friendly_name ||
    entity?.entity_id ||
    ""
  );
}

/**
 * 域 + 属性 → 控件列表。
 *
 * 只给「现在真能生效」的控件：属性里没有量程就不放（放了点了没用的控件比不放更糟），
 * 其余域一律只读读数（v1 控制面口径，规划 §8-6）。
 */
export function buildControls(entity) {
  const domain = entityDomain(entity?.entity_id);
  const attributes = entity?.attributes ?? {};
  const available = !UNAVAILABLE_STATES.has(entity?.state);
  if (!available) return [];

  const toggle = (onService, offService, isOn) => ({
    key: "power",
    label: "开关",
    kind: "toggle",
    isOn: Boolean(isOn),
    onService,
    offService,
  });

  switch (domain) {
    case "light": {
      const controls = [toggle("turn_on", "turn_off", entity.state === "on")];
      const brightness = toNumber(attributes.brightness);
      if (brightness !== null) {
        controls.push({
          key: "brightness",
          label: "亮度",
          kind: "slider",
          service: "turn_on",
          value: Math.round((brightness / 255) * 100),
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
        });
      }
      const colorTemp = toNumber(attributes.color_temp);
      const minMireds = toNumber(attributes.min_mireds);
      const maxMireds = toNumber(attributes.max_mireds);
      if (colorTemp !== null && minMireds !== null && maxMireds !== null) {
        controls.push({
          key: "color_temp",
          label: "色温",
          kind: "slider",
          service: "turn_on",
          value: colorTemp,
          min: minMireds,
          max: maxMireds,
          step: 1,
          unit: "mired",
        });
      }
      return controls;
    }
    case "switch":
    case "input_boolean":
      return [toggle("turn_on", "turn_off", entity.state === "on")];
    case "cover": {
      const controls = [
        {
          key: "commands",
          label: "开合",
          kind: "buttons",
          buttons: [
            { key: "open", label: "开", service: "open_cover" },
            { key: "close", label: "合", service: "close_cover" },
            { key: "stop", label: "停", service: "stop_cover" },
          ],
        },
      ];
      const position = toNumber(attributes.current_position);
      if (position !== null) {
        controls.push({
          key: "position",
          label: "位置",
          kind: "slider",
          service: "set_cover_position",
          value: position,
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
        });
      }
      return controls;
    }
    case "climate": {
      const controls = [];
      const target = toNumber(attributes.temperature);
      const minTemp = toNumber(attributes.min_temp);
      const maxTemp = toNumber(attributes.max_temp);
      if (target !== null && minTemp !== null && maxTemp !== null) {
        controls.push({
          key: "temperature",
          label: "目标温度",
          kind: "slider",
          service: "set_temperature",
          value: target,
          min: minTemp,
          max: maxTemp,
          step: 0.5,
        });
      }
      const modes = Array.isArray(attributes.hvac_modes)
        ? attributes.hvac_modes.filter((mode) => typeof mode === "string")
        : [];
      if (modes.length > 0) {
        controls.push({
          key: "hvac_mode",
          label: "模式",
          kind: "select",
          service: "set_hvac_mode",
          value: attributes.hvac_mode ?? null,
          options: modes.map((mode) => ({ value: mode, label: mode })),
        });
      }
      return controls;
    }
    case "fan": {
      const controls = [toggle("turn_on", "turn_off", entity.state === "on")];
      const percentage = toNumber(attributes.percentage);
      if (percentage !== null) {
        controls.push({
          key: "percentage",
          label: "风量",
          kind: "slider",
          service: "set_percentage",
          value: percentage,
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
        });
      }
      return controls;
    }
    case "media_player": {
      const controls = [toggle("turn_on", "turn_off", entity.state !== "off")];
      const volume = toNumber(attributes.volume_level);
      if (volume !== null) {
        controls.push({
          key: "volume",
          label: "音量",
          kind: "slider",
          service: "volume_set",
          value: Math.round(volume * 100),
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
        });
      }
      return controls;
    }
    default:
      return [];
  }
}

/** 只读读数：传感器类给数值 + 单位 + 类别，其它域给状态原文。 */
export function readDisplay(entity) {
  const attributes = entity?.attributes ?? {};
  const unit =
    typeof attributes.unit_of_measurement === "string"
      ? attributes.unit_of_measurement
      : null;
  const numeric = toNumber(
    typeof entity.state === "string" && entity.state !== ""
      ? Number(entity.state)
      : Number.NaN,
  );
  if (unit !== null && numeric !== null) return { text: String(numeric), unit };
  return {
    text: STATE_LABELS[entity?.state] ?? String(entity?.state ?? ""),
    unit: null,
  };
}

/**
 * 控件 → HA 服务参数。量程在这里复核（越界直接拒），换算也只有这里一处。
 *
 * @param {object} entity 当前状态（用来复核控件是否存在）
 * @param {string} key 控件 key
 * @param {string} service 控件声明的服务名
 * @param {unknown} value 面板/工具给的值
 * @returns {{domain: string, service: string, data: object}}
 */
export function toServiceCall(entity, key, service, value) {
  const domain = entityDomain(entity?.entity_id);
  if (!domain) {
    throw new ControlError(`实体 id 不合法（${String(entity?.entity_id)}）。`);
  }
  if (key === undefined || key === null || key === "") {
    throw new ControlError("缺少控件标识（key）。");
  }
  const controls = buildControls(entity);
  const found = findControl(controls, key);
  if (!found) {
    throw new ControlError(
      `这个实体没有「${String(key)}」控件：可能它离线了，或该品类只读。`,
    );
  }
  const serviceName = String(service ?? "");
  const allowed =
    found.kind === "toggle"
      ? [found.onService, found.offService]
      : [found.service];
  if (!allowed.includes(serviceName)) {
    throw new ControlError(
      `控件「${String(key)}」不支持服务 ${serviceName || "（空）"}。`,
    );
  }
  const data = {};
  switch (`${domain}.${key}`) {
    case "light.brightness":
      data.brightness_pct = requireInRange(value, 0, 100, "亮度");
      break;
    case "light.color_temp":
      data.color_temp = requireInRange(
        value,
        toNumber(entity.attributes?.min_mireds) ?? 0,
        toNumber(entity.attributes?.max_mireds) ?? 600,
        "色温",
      );
      break;
    case "cover.position":
      data.position = requireInRange(value, 0, 100, "位置");
      break;
    case "climate.temperature":
      data.temperature = requireInRange(
        value,
        toNumber(entity.attributes?.min_temp) ?? -100,
        toNumber(entity.attributes?.max_temp) ?? 100,
        "目标温度",
      );
      break;
    case "climate.hvac_mode":
      data.hvac_mode = requireOption(found, value, "模式");
      break;
    case "fan.percentage":
      data.percentage = requireInRange(value, 0, 100, "风量");
      break;
    case "media_player.volume":
      // 面板与工具都说百分比，HA 要 0~1
      data.volume_level = requireInRange(value, 0, 100, "音量") / 100;
      break;
    case "light.power":
    case "switch.power":
    case "input_boolean.power":
    case "fan.power":
    case "media_player.power":
      break;
    default:
      if (found.kind !== "button") {
        throw new ControlError(`控件「${String(key)}」没有可写的参数口径。`);
      }
  }
  // HA 的服务目标是 data 里的 entity_id：漏了它，这次调用会打给**该域的全部实体**
  return {
    domain,
    service: serviceName,
    data: { ...data, entity_id: entity.entity_id },
  };
}

/** 按 key 找控件；按钮组（`kind: "buttons"`）把每个按钮摊平成独立控件。 */
export function findControl(controls, key) {
  for (const control of controls) {
    if (control.key === key) return control;
    if (control.kind === "buttons") {
      const button = control.buttons.find((item) => item.key === key);
      if (button) return { ...button, kind: "button" };
    }
  }
  return null;
}

function requireInRange(value, min, max, label) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ControlError(`${label}要一个数字（收到 ${String(value)}）。`);
  }
  if (numeric < min || numeric > max) {
    throw new ControlError(
      `${label}超出量程：需要 ${min}~${max}（收到 ${numeric}）。`,
    );
  }
  return numeric;
}

function requireOption(control, value, label) {
  const option = String(value ?? "");
  const allowed = (control.options ?? []).map((item) => String(item.value));
  if (!allowed.includes(option)) {
    throw new ControlError(
      `${label}没有「${option}」这个取值：可选 ${allowed.join(" / ")}。`,
    );
  }
  return option;
}

/**
 * 状态列表 → 分组视图。
 *
 * 有注册表时按**区域**分组（规划 §4.3），没有注册表（WS 未就绪）时退回按**域**分组——
 * 两种都只依赖 HA 自己的模型，不引入任何厂商概念。
 */
export function buildEntityView(states, registries = {}) {
  const entityEntries = registries.entities ?? [];
  const areaEntries = registries.areas ?? [];
  const deviceEntries = registries.devices ?? [];
  const registryByEntityId = new Map(
    entityEntries.map((entry) => [entry.entity_id, entry]),
  );
  const areaById = new Map(
    areaEntries.map((area) => [area.area_id, area.name]),
  );
  const deviceById = new Map(
    deviceEntries.map((device) => [device.id, device]),
  );
  const useAreas = areaEntries.length > 0 || entityEntries.length > 0;

  const described = [];
  for (const entity of states ?? []) {
    const registryEntry = registryByEntityId.get(entity.entity_id) ?? null;
    const device = registryEntry?.device_id
      ? (deviceById.get(registryEntry.device_id) ?? null)
      : null;
    const areaId = registryEntry?.area_id ?? device?.area_id ?? null;
    const controls = buildControls(entity);
    const display = readDisplay(entity);
    described.push({
      entityId: entity.entity_id,
      domain: entityDomain(entity.entity_id),
      name: displayName(entity, registryEntry),
      area: areaId ? (areaById.get(areaId) ?? AREA_FALLBACK) : AREA_FALLBACK,
      state: String(entity.state ?? ""),
      unavailable: UNAVAILABLE_STATES.has(entity.state),
      // 无可写控件的品类给一个只读读数控件（`readout` 不在 toServiceCall 的校验面里）
      controls:
        controls.length > 0
          ? controls
          : [
              {
                key: "readout",
                label: "状态",
                kind: "read",
                value: display.text,
                unit: display.unit,
              },
            ],
    });
  }

  const limited = described.slice(0, MAX_ENTITIES_PER_VIEW);
  const buckets = new Map();
  for (const item of limited) {
    const groupName = useAreas ? item.area : item.domain;
    const bucket = buckets.get(groupName) ?? [];
    bucket.push(item);
    buckets.set(groupName, bucket);
  }
  const groups = [...buckets.entries()]
    .map(([name, items]) => ({
      name,
      // 未分区/未归类永远排最后，其余按名称稳定排序
      fallback: name === AREA_FALLBACK || name === "",
      items: items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    }))
    .sort((a, b) => {
      if (a.fallback !== b.fallback) return a.fallback ? 1 : -1;
      return a.name.localeCompare(b.name, "zh-CN");
    });

  return {
    grouping: useAreas ? "area" : "domain",
    groups,
    total: described.length,
    truncated: described.length > limited.length,
  };
}

/**
 * 控件当前读数（控制前后用它对比「到底变了没有」）：开关取布尔、滑杆/下拉取数值，
 * 按钮与查不到的控件退回实体状态原文。
 */
export function controlValue(entity, key) {
  const found = findControl(buildControls(entity), String(key ?? ""));
  if (!found) return entity?.state ?? null;
  if (found.kind === "toggle") return found.isOn;
  if (found.kind === "buttons" || found.kind === "button") {
    return entity?.state ?? null;
  }
  return found.value ?? null;
}
