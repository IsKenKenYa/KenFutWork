import { workspaceActivitySchema } from "@kenfutwork/shared";

/** 宿主只收束人机输入；数据订阅、后台工作及转录继续运行。 */
export function installHostWorkspaceActivity(parent: Window) {
  const root = document.documentElement;
  const previousInert = root.inert;
  const frame = window.frameElement;
  // frame 属于父文档的 Realm，不能用子文档的构造器判断。
  let active = !frame?.hasAttribute("inert");
  root.inert = !active;
  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== window.location.origin)
      return;
    const parsed = workspaceActivitySchema.safeParse(event.data);
    if (!parsed.success) return;
    active = parsed.data.active;
    root.inert = !active;
    if (!active && document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  };
  const stopInactiveInput = (event: Event) => {
    if (active) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
  };
  const inputs = [
    "keydown",
    "keyup",
    "keypress",
    "beforeinput",
    "focus",
    "focusin",
  ] as const;
  window.addEventListener("message", receive);
  for (const type of inputs)
    window.addEventListener(type, stopInactiveInput, true);
  return () => {
    window.removeEventListener("message", receive);
    for (const type of inputs)
      window.removeEventListener(type, stopInactiveInput, true);
    root.inert = previousInert;
  };
}
