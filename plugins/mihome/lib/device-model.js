/**
 * 设备模型（MIoT-Spec 驱动）：把云端的设备条目 + 规格转成「面板能画、工具能读」的形状。
 *
 * 为什么走规格而不是按品类写死：米家品类上百，逐个映射既写不完也维护不动。
 * MIoT-Spec 是小米公开的规格库（匿名可读），属性类型 URN 里带语义段
 * （`urn:miot-spec-v2:property:on:00000006:…`），据此就能判定「哪个是开关、哪个是读数」。
 *
 * 取不到规格时**不猜**（不假设「开关永远是 siid 2 / piid 1」）：面板如实显示
 * 「规格解析失败，仅显示在线状态」，并把重试入口给出来。
 */

const SPEC_INSTANCES_URL =
  "https://miot-spec.org/miot-spec-v2/instances?status=all";
const SPEC_INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance";

/** 器件型号 → 规格 URN 的索引缓存时长（进程内，规格库变化很慢）。 */
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/** 常见读数属性的语义段（只读设备主要靠这些上屏）。 */
const READABLE_SLUGS = new Set([
  "temperature",
  "relative-humidity",
  "illuminance",
  "battery-level",
  "motion-detected",
  "contact-state",
  "pm2.5-density",
  "air-quality",
  "power-consumption",
  "atmospheric-pressure",
  "co2-density",
  "no-motion-duration",
]);

/** 每个器件最多展示几个属性（轮询成本与面板可读性的折中）。 */
const MAX_PROPERTIES_PER_DEVICE = 8;

/** 从属性类型 URN 取语义段：`urn:miot-spec-v2:property:on:00000006:x:1` → `on`。 */
export function propertySlug(type) {
  const segments = String(type ?? "").split(":");
  const index = segments.indexOf("property");
  return index >= 0 ? (segments[index + 1] ?? "") : "";
}

/** 属性 → 控件种类：写不了的一律降级成读数（宁可不给控件，也不给点了没用的控件）。 */
export function controlKindOf(property) {
  if (!property.writable) return "read";
  if (property.format === "bool") return "toggle";
  if (Array.isArray(property.valueRange)) return "slider";
  if (Array.isArray(property.valueList)) return "select";
  return "read";
}

/**
 * 规格 + 器件条目 → 该器件要展示的属性列表（含规格元数据，值由 `values` 合并进来）。
 */
export function selectProperties(
  spec,
  { limit = MAX_PROPERTIES_PER_DEVICE } = {},
) {
  const picked = [];
  for (const service of spec?.services ?? []) {
    for (const raw of service.properties ?? []) {
      const access = Array.isArray(raw.access) ? raw.access : [];
      if (!access.includes("read")) continue;
      const slug = propertySlug(raw.type);
      const writable = access.includes("write");
      if (!writable && !READABLE_SLUGS.has(slug)) continue;
      const valueRange = raw["value-range"];
      const valueList = raw["value-list"];
      picked.push({
        siid: service.iid,
        piid: raw.iid,
        slug,
        name: raw.description ?? slug,
        format: raw.format ?? "",
        writable,
        ...(Array.isArray(valueRange) ? { valueRange } : {}),
        ...(Array.isArray(valueList)
          ? {
              valueList: valueList.map((item) => ({
                value: item.value,
                label: item.description ?? String(item.value),
              })),
            }
          : {}),
      });
    }
  }
  // 可写的排前面（面板先给能操作的），其余保持规格里的顺序
  picked.sort((a, b) => Number(b.writable) - Number(a.writable));
  return picked.slice(0, limit).map((property) => ({
    ...property,
    kind: controlKindOf(property),
  }));
}

/** 属性键（云端读写用 `siid.piid`）。 */
export function propertyKey(siid, piid) {
  return `${siid}.${piid}`;
}

/** 把属性值列表（prop/get 响应）合并进属性定义。 */
export function mergeValues(properties, values) {
  const byKey = new Map(
    values.map((item) => [propertyKey(item.siid, item.piid), item.value]),
  );
  return properties.map((property) => {
    const key = propertyKey(property.siid, property.piid);
    return byKey.has(key) ? { ...property, value: byKey.get(key) } : property;
  });
}

/** 器件条目（云 device_list）→ 面板/工具用的基础字段。 */
export function describeDevice(raw) {
  return {
    did: String(raw.did ?? ""),
    name: String(raw.name ?? ""),
    model: String(raw.model ?? ""),
    online: raw.isOnline === true || raw.isOnline === "true",
    room: typeof raw.room_name === "string" ? raw.room_name : null,
    parentId: raw.parent_id ? String(raw.parent_id) : null,
  };
}

/**
 * 规格解析器：型号 → URN 索引（一次拉取，6 小时缓存）→ 单器件规格（按 URN 缓存）。
 * 规格库不可达时抛错，由调用方如实显示「仅在线状态」。
 */
export function createSpecResolver({ fetchImpl = fetch, logger } = {}) {
  let indexCache = { at: 0, byModel: new Map() };
  const specCache = new Map();

  async function loadIndex(now = Date.now()) {
    if (now - indexCache.at < INDEX_TTL_MS && indexCache.byModel.size > 0) {
      return indexCache.byModel;
    }
    const response = await fetchImpl(SPEC_INSTANCES_URL);
    if (!response.ok) {
      throw new Error(`规格索引拉取失败（HTTP ${response.status}）。`);
    }
    const payload = await response.json();
    const instances = Array.isArray(payload?.instances)
      ? payload.instances
      : [];
    const byModel = new Map();
    for (const item of instances) {
      if (typeof item?.model === "string" && typeof item?.type === "string") {
        byModel.set(item.model, item.type);
      }
    }
    if (byModel.size === 0) {
      throw new Error("规格索引为空（miot-spec 接口可能已变更）。");
    }
    indexCache = { at: now, byModel };
    logger?.info?.(`米家规格索引已加载：${byModel.size} 个型号`);
    return byModel;
  }

  async function loadSpec(model) {
    if (specCache.has(model)) return specCache.get(model);
    const byModel = await loadIndex();
    const type = byModel.get(model);
    if (!type) {
      throw new Error(
        `规格库里没有型号 ${model}（新器件，规格可能还没收录）。`,
      );
    }
    const response = await fetchImpl(
      `${SPEC_INSTANCE_URL}?type=${encodeURIComponent(type)}`,
    );
    if (!response.ok) {
      throw new Error(`规格拉取失败（HTTP ${response.status}）。`);
    }
    const spec = await response.json();
    specCache.set(model, spec);
    return spec;
  }

  return { loadSpec, loadIndex };
}
