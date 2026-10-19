/**
 * 启动加载层交接：预渲染层常驻在 `#root` 之外，React 挂载不会替换它，旋转因此不会归零重播；
 * 应用提交到 DOM 后再摘掉它，并通知父页撤下同一形态的加载屏——整条启动链路只有一屏动画。
 */
export function dismissStartupOverlay(): void {
  document.getElementById("zcode-boot")?.remove();
  if (window.parent !== window) {
    window.parent.postMessage(
      { type: "kenfutwork:code-mounted" },
      window.location.origin,
    );
  }
}
