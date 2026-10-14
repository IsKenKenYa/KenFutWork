import assert from "node:assert/strict";
import test from "node:test";
import { attachPointerReveal } from "../src/pointer-reveal.mjs";

function fixture() {
  const eventTarget = new EventTarget();
  const properties = new Map();
  const element = {
    dataset: {},
    style: { setProperty: (name, value) => properties.set(name, value) },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
  const cleanup = attachPointerReveal(element, eventTarget);
  function dispatch(type, attributes = {}) {
    const event = new Event(type);
    Object.assign(event, attributes);
    eventTarget.dispatchEvent(event);
  }
  return { element, properties, cleanup, dispatch };
}

test("鼠标滑动更新局部遮罩，后续移动覆盖上次位置", () => {
  const { element, properties, dispatch, cleanup } = fixture();
  dispatch("pointermove", { pointerType: "mouse", clientX: 400, clientY: 450 });
  assert.equal(element.dataset.active, "true");
  assert.equal(properties.get("--pointer-x"), "390px");
  assert.equal(properties.get("--pointer-y"), "430px");
  dispatch("pointermove", { pointerType: "mouse", clientX: 25, clientY: 30 });
  assert.equal(properties.get("--pointer-x"), "15px");
  assert.equal(properties.get("--pointer-y"), "10px");
  cleanup();
});

test("触屏不激活遮罩，内部移动不清空，离开窗口或失焦后恢复", () => {
  const { element, properties, dispatch, cleanup } = fixture();
  dispatch("pointermove", { pointerType: "touch", clientX: 400, clientY: 450 });
  assert.equal(properties.size, 0);
  dispatch("pointermove", { pointerType: "mouse", clientX: 400, clientY: 450 });
  dispatch("pointerout", { relatedTarget: {} });
  assert.equal(element.dataset.active, "true");
  dispatch("pointerout", { relatedTarget: null });
  assert.equal(element.dataset.active, "false");
  dispatch("pointermove", { pointerType: "pen", clientX: 0, clientY: 0 });
  assert.equal(element.dataset.active, "true");
  dispatch("blur");
  assert.equal(element.dataset.active, "false");
  cleanup();
  dispatch("pointermove", { pointerType: "mouse", clientX: 100, clientY: 100 });
  assert.equal(element.dataset.active, "false");
  assert.equal(properties.get("--pointer-x"), "-10px");
});
