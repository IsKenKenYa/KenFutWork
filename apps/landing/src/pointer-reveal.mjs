/** @param {number} value @param {number} limit */
function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * 原生指针只更新装饰层的 CSS 变量；磁吸不锁定系统光标，不影响链接。
 * @param {HTMLElement} element
 * @param {Window} eventTarget
 */
export function attachPointerReveal(element, eventTarget) {
  const logo = element.querySelector("[data-logo-zone]");
  const motion = eventTarget.matchMedia("(prefers-reduced-motion: reduce)");
  let rotation = -15;

  function resetLogo() {
    element.dataset.logoActive = "false";
    element.style.setProperty("--logo-x", "0px");
    element.style.setProperty("--logo-y", "0px");
  }
  function leave() {
    element.dataset.active = "false";
    resetLogo();
  }
  /** @param {PointerEvent} event */
  function move(event) {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      leave();
      return;
    }
    const rect = element.getBoundingClientRect();
    element.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
    element.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
    element.dataset.active = "true";
    const bounds = logo?.getBoundingClientRect();
    if (
      !bounds ||
      motion.matches ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      resetLogo();
      return;
    }
    element.dataset.logoActive = "true";
    const x = (event.clientX - bounds.left - bounds.width / 2) * 0.06;
    const y = (event.clientY - bounds.top - bounds.height / 2) * 0.06;
    element.style.setProperty("--logo-x", `${clamp(x, 24)}px`);
    element.style.setProperty("--logo-y", `${clamp(y, 24)}px`);
  }
  /** @param {PointerEvent} event */
  function leaveViewport(event) {
    if (!event.relatedTarget) leave();
  }
  /** @param {WheelEvent} event */
  function rotate(event) {
    if (motion.matches || event.ctrlKey || event.metaKey) return;
    rotation = clamp(rotation + clamp(event.deltaY, 180) * 0.07, 65);
    element.style.setProperty("--type-rotation", `${rotation}deg`);
  }
  function scroll() {
    if (motion.matches) return;
    rotation = clamp(-15 + eventTarget.scrollY * 0.12, 65);
    element.style.setProperty("--type-rotation", `${rotation}deg`);
  }
  function motionChanged() {
    if (!motion.matches) return;
    resetLogo();
    rotation = -15;
    element.style.setProperty("--type-rotation", "-15deg");
  }

  eventTarget.addEventListener("pointermove", move, { passive: true });
  eventTarget.addEventListener("pointerout", leaveViewport);
  eventTarget.addEventListener("blur", leave);
  eventTarget.addEventListener("wheel", rotate, { passive: true });
  eventTarget.addEventListener("scroll", scroll, { passive: true });
  motion.addEventListener("change", motionChanged);
  return () => {
    eventTarget.removeEventListener("pointermove", move);
    eventTarget.removeEventListener("pointerout", leaveViewport);
    eventTarget.removeEventListener("blur", leave);
    eventTarget.removeEventListener("wheel", rotate);
    eventTarget.removeEventListener("scroll", scroll);
    motion.removeEventListener("change", motionChanged);
    leave();
  };
}
