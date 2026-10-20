import { CdpError } from "./cdp-client.js";

/**
 * 「选择网页元素加入对话」的**页面内元素选择器**（DevTools 拾取器同款交互）。
 *
 * 为什么高亮要在**页面里**画，而不是面板拉一份元素快照在外面叠框（上一版的错法）：
 * - 快照是「某一时刻、某一份清单」——页面一滚动/一变化框就错位，清单外的元素（动态渲染、
 *   非链接按钮）永远选不到（用户拿百度页实测：框错位 + 元素不全）；
 * - 页面内用 `elementFromPoint` 跟鼠标实时走：坐标永远精确、**所有**元素都能选，
 *   这才是参考实现（Edge「将元素添加到对话」/ DevTools 拾取器）的做法。
 *
 * 脚本由 `Runtime.evaluate` 整段注入（与 debug-console 同一结论：插 script 标签会把成败
 * 交给页面的 CSP 与网络，直投运行代码没有那类失败）。交互约定：
 * - `mousemove`（capture）：`elementFromPoint` → 画高亮框 + 标签（tag#id.class + 尺寸）；
 * - `mousedown`（capture，preventDefault + stopPropagation）：记录元素到
 *   `window.__kfwPickedElement` 并收起高亮——页面不会真的被点下去；
 * - 点选后同一次手势的 `mouseup`/`click`（capture）一并拦截：浏览器会为「按下→抬起」
 *   合成 click，不拦的话点选 `<a>` 会把页面导航走；拦截完**复位继续拾取**（用户口径：
 *   连续添加多个元素），只有 `Escape` 或面板的 stop 才退出；
 * - 面板在每次「按下→抬起」之后来 `/api/browser/cdp/picker` action=read 把结果取走。
 */

/** 进入选择模式：幂等（重复进入先卸旧的再装新的）。 */
export const ELEMENT_PICKER_START_SCRIPT = `
;(function () {
  window.__kfwPickerError = null;
  try {
    if (window.__kfwPicker && typeof window.__kfwPicker.stop === "function") {
      window.__kfwPicker.stop();
    }
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;z-index:2147483645;pointer-events:none;display:none;box-sizing:border-box;" +
      "border:2px solid #1a73e8;background:rgba(26,115,232,.18);border-radius:2px;";
    var label = document.createElement("div");
    label.style.cssText =
      "position:fixed;z-index:2147483646;pointer-events:none;display:none;" +
      "max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font:11px/18px system-ui,-apple-system,sans-serif;padding:0 6px;border-radius:3px;" +
      "background:#1a73e8;color:#fff;";
    var tip = document.createElement("div");
    tip.textContent = "悬停选择元素 · 点击加入对话 · Esc 取消";
    tip.style.cssText =
      "position:fixed;z-index:2147483646;pointer-events:none;display:none;" +
      "left:50%;bottom:14px;transform:translateX(-50%);padding:2px 10px;border-radius:4px;" +
      "font:12px/20px system-ui,-apple-system,sans-serif;background:rgba(0,0,0,.72);color:#fff;";
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(label);
    document.documentElement.appendChild(tip);

    function isOwn(node) {
      return node === overlay || node === label || node === tip;
    }

    function describe(el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : "node";
      var hint = tag;
      if (el.id) hint += "#" + el.id;
      var cls = typeof el.className === "string" ? el.className.trim() : "";
      if (cls) {
        hint += "." + cls.split(/\\s+/).slice(0, 2).join(".");
      }
      var box = el.getBoundingClientRect();
      return {
        tag: tag,
        text: String(el.innerText || el.textContent || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 80),
        hint: hint,
        box: { x: box.left, y: box.top, width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        page: location.href
      };
    }

    function onMove(event) {
      if (picked) return;
      var el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || isOwn(el)) {
        overlay.style.display = "none";
        label.style.display = "none";
        return;
      }
      var box = el.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = box.left + "px";
      overlay.style.top = box.top + "px";
      overlay.style.width = box.width + "px";
      overlay.style.height = box.height + "px";
      label.style.display = "block";
      var size = Math.round(box.width) + " × " + Math.round(box.height);
      var text = String(el.innerText || "").replace(/\\s+/g, " ").trim();
      label.textContent = describe(el).hint + "  " + size + (text ? "  " + text.slice(0, 24) : "");
      var lx = Math.min(Math.max(4, event.clientX + 12), window.innerWidth - label.offsetWidth - 8);
      var ly = box.top - 22 > 0 ? box.top - 22 : box.bottom + 6;
      label.style.left = lx + "px";
      label.style.top = ly + "px";
      tip.style.display = "block";
    }

    function hideVisuals() {
      overlay.style.display = "none";
      label.style.display = "none";
      tip.style.display = "none";
    }

    var picked = false;

    function teardown() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      label.remove();
      tip.remove();
      window.__kfwPicker = null;
    }

    function onDown(event) {
      if (event.button !== 0) return;
      var el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || isOwn(el)) return;
      event.preventDefault();
      event.stopPropagation();
      window.__kfwPickedElement = describe(el);
      hideVisuals();
      picked = true;
    }

    // 点选后同一次手势还有 mouseup 与合成的 click：一并拦截，别让「选一下」
    // 变成页面上的真实点击（点链接导航走、点按钮提交表单都是这个坑）。拦截完复位——
    // 连续拾取模式下选择器不卸载，下一次 hover 继续跟手。
    function onUp(event) {
      if (!picked) return;
      event.preventDefault();
      event.stopPropagation();
    }

    function onClick(event) {
      if (!picked) return;
      event.preventDefault();
      event.stopPropagation();
      picked = false;
    }

    function onKey(event) {
      if (event.key === "Escape") teardown();
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.__kfwPicker = { stop: teardown };
  } catch (error) {
    window.__kfwPickerError = String(
      (error && (error.stack || error.message)) || error
    );
  }
})();`;

/**
 * 读取并清空已点选的元素（read 与清理一次往返完成）。
 *
 * **必须是单个表达式**：`Runtime.evaluate` 只取最后一条语句的值——先 stringify 再
 * 赋值清空的话，返回值是清空赋值的 `null`，调用方永远读到「未点选」的兜底
 * （真机实测踩过：页面里选择器活着，read 恒回 picked:null）。
 *
 * 连续拾取：取到元素**不收选择器**（用户口径「可以添加多个」），面板靠 Esc / stop
 * 退出；`active` 如实反映页面选择器是否还在。
 */
export const ELEMENT_PICKER_READ_SCRIPT = `(() => {
  var snapshot = JSON.stringify({
    picked: window.__kfwPickedElement || null,
    active: Boolean(window.__kfwPicker),
    error: window.__kfwPickerError || null
  });
  window.__kfwPickedElement = null;
  return snapshot;
})();`;

/** 退出选择模式（幂等；面板 Esc / 再点按钮都走这里）。 */
export const ELEMENT_PICKER_STOP_SCRIPT = `;
;(function () {
  if (window.__kfwPicker && typeof window.__kfwPicker.stop === "function") {
    window.__kfwPicker.stop();
  }
  window.__kfwPickedElement = null;
})();`;

/** 面板消费的元素形状（与旧 snapshot 的 pickable 对齐，多出 page 与 viewport）。 */
export interface PickedElementWire {
  tag: string;
  text: string;
  hint: string;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  page: string;
}

export interface ElementPickerReadResult {
  picked: PickedElementWire | null;
  active: boolean;
  error: string | null;
}

/** 解析 read 探针的返回（页面给 JSON 串；拿不到按「未点选」处理）。 */
export function parseElementPickerRead(
  value: unknown,
): ElementPickerReadResult {
  const fallback: ElementPickerReadResult = {
    picked: null,
    active: false,
    error: null,
  };
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value) as {
      picked?: Partial<PickedElementWire> | null;
      active?: boolean;
      error?: string | null;
    };
    const box = parsed.picked?.box;
    const viewport = parsed.picked?.viewport;
    const picked =
      parsed.picked && typeof parsed.picked.tag === "string" && box && viewport
        ? {
            tag: parsed.picked.tag,
            text:
              typeof parsed.picked.text === "string" ? parsed.picked.text : "",
            hint:
              typeof parsed.picked.hint === "string" ? parsed.picked.hint : "",
            box: {
              x: Number(box.x) || 0,
              y: Number(box.y) || 0,
              width: Number(box.width) || 0,
              height: Number(box.height) || 0,
            },
            viewport: {
              width: Number(viewport.width) || 0,
              height: Number(viewport.height) || 0,
            },
            page:
              typeof parsed.picked.page === "string" ? parsed.picked.page : "",
          }
        : null;
    return {
      picked,
      active: parsed.active === true,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
  } catch {
    return fallback;
  }
}

/** start 注入失败时给可读错误（页面侧自报的 `__kfwPickerError` 由 read 带回）。 */
export function throwPickerStartError(exception: {
  text?: string;
  exception?: { description?: string };
}): never {
  throw new CdpError(
    "command_failed",
    `注入元素选择器时页面报错：${
      exception.exception?.description ?? exception.text ?? "未知错误"
    }`,
  );
}
