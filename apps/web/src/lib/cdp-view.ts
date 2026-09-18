/**
 * 右栏浏览器面板「实时画面」的纯逻辑（可单测的那一半）。
 *
 * 面板显示的是**受控浏览器的画面**（MJPEG 流）——不是 iframe。为什么非要这样：
 * iframe 是跨源的，读不到 DOM、挂不上调试工具、也注不进任何脚本；用户口径
 * 「调试面板要在内嵌页面里出来」在 iframe 上无解。画面由服务端从 CDP 取来推给面板，
 * 交互（鼠标/键盘/滚轮）按**视口 CSS 坐标**回填给服务端。
 */

/** 画面流的 `<img>` 地址（票据在 query 里——`<img>` 发不了登录头）。 */
export function streamSrc(serverBase: string, ticket: string): string {
  const base = serverBase.replace(/\/+$/, "");
  return `${base}/api/browser/cdp/stream?ticket=${encodeURIComponent(ticket)}`;
}

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 面板里的显示坐标 → **视口 CSS 坐标**。
 *
 * 两者的关系只是缩放（画面按比例铺满显示盒；自由尺寸/窗口比例都体现在显示盒的尺寸上），
 * 所以用显示盒的矩形做线性映射即可。落在盒外的点夹到边界内——CDP 收到越界坐标会直接丢掉，
 * 夹一下至少让「贴着边点」有反应。
 */
export function toViewportPoint(
  rect: ViewRect,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? viewport.width / rect.width : 1;
  const scaleY = rect.height > 0 ? viewport.height / rect.height : 1;
  return {
    x: clamp((point.x - rect.left) * scaleX, 0, viewport.width),
    y: clamp((point.y - rect.top) * scaleY, 0, viewport.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** CDP 的修饰键位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8。 */
export function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) +
    (event.ctrlKey ? 2 : 0) +
    (event.metaKey ? 4 : 0) +
    (event.shiftKey ? 8 : 0)
  );
}

/** 输入法合成状态下的中间态键（`Process` / `Unidentified` / `Dead`）不要转发。 */
const IME_NOISE = new Set(["Process", "Unidentified", "Dead"]);

/**
 * 这个按键该作为**按键**转发，还是交给输入框走文本（`insertText`）？
 *
 * 判据很窄：只有**有名字的键**（`Enter` / `ArrowUp` / `Backspace` / `Tab`…，`key` 长度大于 1）
 * 走按键；单个可打印字符走文本——那条路能带上输入法合成的结果（中文就是从那里进去的）。
 *
 * **单字符组合键（Ctrl+C / Ctrl+V / Ctrl+A）故意不转发**：剪贴板跨不到那个浏览器，
 * 转发成按键只会让 CDP 收到一个虚拟键码 0 的怪事件；最坏的结果是往页面里打字（真机想象一下
 * Ctrl+V 粘出个 "v"）。宁可什么都不做。
 */
export function isRemoteKeyEvent(event: {
  key: string;
  /** 输入法合成中：什么都不转发（等 `input` 里的最终结果）。 */
  composing?: boolean;
}): boolean {
  if (event.composing) return false;
  if (event.key.length <= 1) return false;
  return !IME_NOISE.has(event.key);
}

/**
 * 输入框里这次输入要转发的文本；合成中或空输入返回 null。
 *
 * `InputEvent.data` 在合成期间是**中间态**（拼音串），只有 `compositionend` 之后才是最终结果。
 */
export function textToForward(event: {
  data: string | null;
  isComposing: boolean;
}): string | null {
  if (event.isComposing) return null;
  if (!event.data) return null;
  return event.data;
}
