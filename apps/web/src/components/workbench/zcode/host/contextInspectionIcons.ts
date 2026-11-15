// 改编自 DeepSeek Harness ui-theme/icon-sprite.ts（MIT）；来源见 UI 包来源清单。
import { ICON_SYMBOLS } from "@kenfutwork/context-insights-ui";

const namespace = "http://www.w3.org/2000/svg";
export function mountContextInspectionIcons() {
  const sprite = document.createElementNS(namespace, "svg");
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("data-context-inspection-icons", "");
  sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const dropped = new Set(["width", "height", "xmlns", "class", "aria-hidden"]);
  for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
    const root = new DOMParser().parseFromString(
      markup,
      "image/svg+xml",
    ).documentElement;
    const symbol = document.createElementNS(namespace, "symbol");
    for (const { name, value } of root.attributes)
      if (!dropped.has(name)) symbol.setAttribute(name, value);
    symbol.id = id;
    symbol.append(
      ...[...root.childNodes].map((node) => document.importNode(node, true)),
    );
    sprite.append(symbol);
  }
  document.body.prepend(sprite);
  return () => sprite.remove();
}
