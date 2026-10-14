/**
 * 遮罩只改变鼠标附近的点阵层，不触发 React 每帧重渲染。
 * @param {HTMLElement} element
 * @param {Window} eventTarget
 */
export function attachPointerReveal(element, eventTarget) {
  /** @param {PointerEvent} event */
  function move(event) {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
    element.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
    element.dataset.active = "true";
  }
  function leave() {
    element.dataset.active = "false";
  }
  eventTarget.addEventListener("pointermove", move, { passive: true });
  eventTarget.addEventListener("pointerout", leaveViewport);
  eventTarget.addEventListener("blur", leave);
  /** @param {PointerEvent} event */
  function leaveViewport(event) {
    if (!event.relatedTarget) leave();
  }
  return () => {
    eventTarget.removeEventListener("pointermove", move);
    eventTarget.removeEventListener("pointerout", leaveViewport);
    eventTarget.removeEventListener("blur", leave);
    leave();
  };
}
