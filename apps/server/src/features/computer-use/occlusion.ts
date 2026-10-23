/**
 * 截图前的遮挡判定（Computer Use 插件的观察可信度护栏）。
 *
 * 为什么需要：macOS A 档的截图是 `screencapture -R <窗口 bounds>`，取的是
 * **屏幕矩形**而不是窗口图层。目标窗口被别的窗口盖住时，截回来的是遮挡者——
 * 既会让模型按别人的界面推理坐标，也会把无关应用的画面带进上下文。
 *
 * ZCode 用 ScreenCaptureKit 的「verified 窗口」ABI 从根上避免这件事；
 * 我们在 A 档能做的等價约束是：截前按 WindowServer 的前后顺序（前排在前）
 * 找到目标窗口，检查它前面是否有同层不透明窗口盖住了足够比例的面积。
 *
 * 纯函数与副作用分离：`jxa.ts` 只负责把 `CGWindowListCopyWindowInfo` 的行
 * 序列化回来，判定全在本模块，便于单测。
 */

/** `CGWindowListCopyWindowInfo` 行（已由 JXA 侧 deepUnwrap + 类型归一）。 */
export interface CuWindowStackRow {
  pid: number;
  windowId: number;
  /** kCGWindowLayer：0 才是普通应用窗口；菜单/浮层/Dock 都在更高层。 */
  layer: number;
  /** kCGWindowAlpha：0 表示完全透明（隐藏窗口），不构成遮挡。 */
  alpha: number;
  bounds: [number, number, number, number];
  name?: string | null;
}

export interface CuTargetWindow {
  pid: number;
  windowId: number;
  bounds: [number, number, number, number];
}

export type CuOcclusionVerdict =
  | { occluded: false }
  | {
      occluded: true;
      /** covered=被前面的窗口盖住；not_on_screen=目标不在当前屏/已最小化。 */
      reason: "covered" | "not_on_screen";
      blocker: CuWindowStackRow | null;
    };

/** 遮挡面积达到目标面积的该比例才判遮挡——避开窗口阴影/1px 贴边的误报。 */
const MIN_COVERAGE_RATIO = 0.02;

function area(bounds: [number, number, number, number]): number {
  return bounds[2] > 0 && bounds[3] > 0 ? bounds[2] * bounds[3] : 0;
}

/** 交集面积 / 目标面积（0~1）；目标面积为 0 时返回 0。 */
export function coverageRatio(
  covering: [number, number, number, number],
  target: [number, number, number, number],
): number {
  const targetArea = area(target);
  if (targetArea === 0) return 0;
  const left = Math.max(covering[0], target[0]);
  const top = Math.max(covering[1], target[1]);
  const right = Math.min(covering[0] + covering[2], target[0] + target[2]);
  const bottom = Math.min(covering[1] + covering[3], target[1] + target[3]);
  if (right <= left || bottom <= top) return 0;
  return ((right - left) * (bottom - top)) / targetArea;
}

/**
 * 按 WindowServer 的前后排布判定目标窗口是否可被可信截取。
 *
 * `rows` 必须是 `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)`
 * 的原始顺序（前排在前）。只把目标之前的行当作遮挡候选：目标之后的窗口
 * 在物理上盖不住它。
 */
export function pickOccludingWindow(
  rows: readonly CuWindowStackRow[],
  target: CuTargetWindow,
): CuOcclusionVerdict {
  const targetIndex = rows.findIndex(
    (row) => row.pid === target.pid && row.windowId === target.windowId,
  );
  if (targetIndex < 0) {
    return { occluded: true, reason: "not_on_screen", blocker: null };
  }
  if (area(target.bounds) === 0) {
    return { occluded: true, reason: "not_on_screen", blocker: null };
  }
  for (let i = 0; i < targetIndex; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.layer !== 0 || row.alpha === 0) continue;
    if (coverageRatio(row.bounds, target.bounds) >= MIN_COVERAGE_RATIO) {
      return { occluded: true, reason: "covered", blocker: row };
    }
  }
  return { occluded: false };
}
