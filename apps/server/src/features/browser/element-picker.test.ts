import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  ELEMENT_PICKER_READ_SCRIPT,
  parseElementPickerRead,
} from "./element-picker.js";

/**
 * read 脚本的**求值契约**（真机踩过的坑用测试锁死）：
 * `Runtime.evaluate` 只取最后一条语句的值——脚本若以「清空赋值」收尾，返回值是 null，
 * 调用方恒回「未点选」兜底（页面里选择器明明活着）。这里在 Node vm 里按页面的全局
 * 形状执行脚本本体，钉住：返回 JSON 串、读后即清、连续拾取（取到元素也不收选择器，
 * 退出只走 Esc / stop）。
 */
function runReadScript(page: { picked: unknown; pickerAlive: boolean }): {
  value: unknown;
  stopCalled: boolean;
} {
  const stop = vi.fn(() => {
    sandbox.window.__kfwPicker = null;
  });
  const sandbox = {
    window: {
      __kfwPickedElement: page.picked,
      __kfwPicker: page.pickerAlive ? { stop } : null,
      __kfwPickerError: null,
    },
  };
  const value = vm.runInNewContext(ELEMENT_PICKER_READ_SCRIPT, sandbox);
  return { value, stopCalled: stop.mock.calls.length > 0 };
}

describe("ELEMENT_PICKER_READ_SCRIPT（read 的求值契约）", () => {
  it("取到元素：返回 JSON 串（不是 null），读后即清，选择器保持激活（连续拾取）", () => {
    const element = { tag: "a", text: "Learn more" };
    const { value, stopCalled } = runReadScript({
      picked: element,
      pickerAlive: true,
    });
    expect(typeof value).toBe("string");
    const parsed = JSON.parse(value as string) as {
      picked: unknown;
      active: boolean;
    };
    expect(parsed.picked).toEqual(element);
    expect(parsed.active).toBe(true);
    expect(stopCalled).toBe(false);
  });

  it("没取到（点空白）：同样返回 JSON 串，但保持选择模式（不收选择器）", () => {
    const { value, stopCalled } = runReadScript({
      picked: null,
      pickerAlive: true,
    });
    const parsed = JSON.parse(value as string) as {
      picked: unknown;
      active: boolean;
    };
    expect(parsed.picked).toBeNull();
    expect(parsed.active).toBe(true);
    expect(stopCalled).toBe(false);
  });
});

describe("parseElementPickerRead", () => {
  it("页面给不出字符串（求值形态变化）→ 未点选兜底，不误报", () => {
    expect(parseElementPickerRead(undefined)).toEqual({
      picked: null,
      active: false,
      error: null,
    });
    expect(parseElementPickerRead(42)).toEqual({
      picked: null,
      active: false,
      error: null,
    });
    expect(parseElementPickerRead("{broken json")).toEqual({
      picked: null,
      active: false,
      error: null,
    });
  });

  it("合法 JSON → 映射成面板消费的形状；缺字段落安全默认", () => {
    expect(
      parseElementPickerRead(
        JSON.stringify({
          picked: {
            tag: "button",
            text: "提交",
            hint: "button#go",
            box: { x: 10, y: 20, width: 30, height: 40 },
            viewport: { width: 1280, height: 720 },
            page: "https://example.com/",
          },
          active: false,
          error: null,
        }),
      ),
    ).toEqual({
      picked: {
        tag: "button",
        text: "提交",
        hint: "button#go",
        box: { x: 10, y: 20, width: 30, height: 40 },
        viewport: { width: 1280, height: 720 },
        page: "https://example.com/",
      },
      active: false,
      error: null,
    });
    expect(
      parseElementPickerRead(
        JSON.stringify({ picked: { tag: "a" }, active: true, error: "x" }),
      ),
    ).toEqual({ picked: null, active: true, error: "x" });
  });
});
