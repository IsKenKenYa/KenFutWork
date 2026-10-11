/**
 * 动作目标解析与校验（Computer Use 插件的坐标纪律）。
 *
 * 两条硬规则（对齐 ZCode CUA 语义）：
 * - **元素索引优先**：寻址不依赖窗口几何，树里在即可用；
 * - **坐标只能引用最近一次返回的 raster**：帧过期报 `element_stale`
 *   （retry=reobserve），越出 raster 边界报 `invalid_target`——绝不猜。
 */

export type CuTarget =
  | { kind: "element"; index: number }
  | { kind: "coordinate"; x: number; y: number; frameId?: string };

export type CuAppRefInput =
  | string
  | {
      name?: string;
      bundleId?: string;
      pid?: number;
      windowId?: number;
      displayId?: string;
    };

export interface ParsedAppRef {
  name?: string;
  bundleId?: string;
  pid?: number;
  windowId?: number;
  displayId?: string;
}

export interface RasterBinding {
  frameId: string;
  width: number;
  height: number;
  /** 最新观察树里存在的元素索引集合。 */
  elementIndexes: ReadonlySet<number>;
}

export type TargetVerdict =
  | { ok: true }
  | {
      ok: false;
      code: string;
      retry: "reobserve" | "retry" | "never";
      message: string;
    };

/** 目标/引用解析失败：调用方（工具层）转成结构化工具错误。 */
export class CuTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuTargetError";
  }
}

export function parseTarget(raw: unknown): CuTarget {
  if (typeof raw !== "object" || raw === null) {
    throw new CuTargetError(
      `target 必须是 {type:"element",index} 或 {type:"coordinate",x,y} 对象`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type === "element") {
    const index = obj.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new CuTargetError("element 目标需要非负整数 index");
    }
    return { kind: "element", index };
  }
  if (obj.type === "coordinate") {
    const { x, y } = obj;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new CuTargetError("coordinate 目标需要数值 x 与 y");
    }
    if (x < 0 || y < 0) {
      throw new CuTargetError("coordinate 目标的 x/y 必须非负");
    }
    if (
      obj.frameId !== undefined &&
      (typeof obj.frameId !== "string" || !obj.frameId.length)
    )
      throw new CuTargetError("frameId 必须是非空字符串");
    return {
      kind: "coordinate",
      x: Math.floor(x),
      y: Math.floor(y),
      ...(typeof obj.frameId === "string" ? { frameId: obj.frameId } : {}),
    };
  }
  throw new CuTargetError('target.type 必须是 "element" 或 "coordinate"');
}

export function parseAppRef(raw: unknown): ParsedAppRef {
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      throw new CuTargetError("app 引用不能是空字符串");
    }
    if (raw.trimStart().startsWith("{")) {
      let object: unknown;
      try {
        object = JSON.parse(raw);
      } catch {
        throw new CuTargetError("app 对象引用不是合法JSON");
      }
      return parseAppRef(object);
    }
    // 裸字符串按 bundle_id 读（ZCode cua 同款约定）
    return { bundleId: raw };
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const ref: ParsedAppRef = {};
    if (obj.displayId !== undefined) {
      if (
        typeof obj.displayId !== "string" ||
        !obj.displayId.trim() ||
        obj.name !== undefined ||
        obj.pid !== undefined ||
        obj.bundleId !== undefined ||
        obj.windowId !== undefined
      )
        throw new CuTargetError("displayId 必须单独指定为非空字符串");
      return { displayId: obj.displayId };
    }
    if (typeof obj.name === "string" && obj.name.trim()) ref.name = obj.name;
    if (typeof obj.bundleId === "string" && obj.bundleId.trim())
      ref.bundleId = obj.bundleId;
    if (obj.pid !== undefined) {
      if (
        typeof obj.pid !== "number" ||
        !Number.isSafeInteger(obj.pid) ||
        obj.pid <= 0
      )
        throw new CuTargetError("pid 必须是正整数");
      ref.pid = obj.pid;
    }
    if (obj.windowId !== undefined) {
      if (
        typeof obj.windowId !== "number" ||
        !Number.isSafeInteger(obj.windowId) ||
        obj.windowId < 0
      )
        throw new CuTargetError("windowId 必须是非负整数");
      ref.windowId = obj.windowId;
    }
    if (
      ref.name === undefined &&
      ref.bundleId === undefined &&
      ref.pid === undefined &&
      ref.windowId === undefined
    ) {
      throw new CuTargetError("app 引用需要 name / bundleId / pid 之一");
    }
    return ref;
  }
  throw new CuTargetError(
    "app 引用必须是字符串（bundle id）或 {name|bundleId|pid}",
  );
}

/**
 * 校验目标对「最近观察」的绑定关系。
 * `claimed` 是目标声称所属的 raster（工具参数里的 frameId，缺省视为最新）。
 */
export function validateTarget(
  target: CuTarget,
  claimed: RasterBinding,
  latest: RasterBinding,
): TargetVerdict {
  if (target.kind === "element") {
    if (latest.elementIndexes.has(target.index)) {
      return { ok: true };
    }
    return {
      ok: false,
      code: "element_unavailable",
      retry: "reobserve",
      message: `元素索引 ${target.index} 不在最新观察树中（元素已消失或从未观察）。请重新观察后再寻址。`,
    };
  }
  if (claimed.frameId !== latest.frameId) {
    return {
      ok: false,
      code: "element_stale",
      retry: "reobserve",
      message:
        "坐标引用的截图帧已过期（窗口可能移动/缩放/被替换）。请重新观察获取当前帧后再用坐标。",
    };
  }
  if (target.x >= latest.width || target.y >= latest.height) {
    return {
      ok: false,
      code: "invalid_target",
      retry: "never",
      message: `坐标 (${target.x},${target.y}) 越出当前 raster 边界 ${latest.width}x${latest.height}。`,
    };
  }
  return { ok: true };
}
