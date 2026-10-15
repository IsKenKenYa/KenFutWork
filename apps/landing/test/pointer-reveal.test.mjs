import assert from "node:assert/strict";
import test from "node:test";
import { attachPointerReveal } from "../src/pointer-reveal.mjs";

function fixture({ reducedMotion = false } = {}) {
  const eventTarget = new EventTarget();
  const motion = new EventTarget();
  motion.matches = reducedMotion;
  eventTarget.matchMedia = () => motion;
  eventTarget.scrollY = 0;
  const properties = new Map();
  const logo = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 900,
      bottom: 900,
      width: 800,
      height: 800,
    }),
  };
  const element = {
    dataset: {},
    style: { setProperty: (name, value) => properties.set(name, value) },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    querySelector: () => logo,
  };
  const cleanup = attachPointerReveal(element, eventTarget);
  function dispatch(type, attributes = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, attributes);
    eventTarget.dispatchEvent(event);
    return event;
  }
  return { element, properties, cleanup, dispatch, eventTarget, motion };
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
  assert.equal(properties.has("--pointer-x"), false);
  assert.equal(element.dataset.active, "false");
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

test("Logo 区域内磁吸有位移上限，退出区域归位且探照灯继续响应", () => {
  const { element, properties, dispatch, cleanup } = fixture();
  dispatch("pointermove", { pointerType: "mouse", clientX: 900, clientY: 100 });
  assert.equal(element.dataset.logoActive, "true");
  assert.equal(properties.get("--logo-x"), "24px");
  assert.equal(properties.get("--logo-y"), "-24px");
  dispatch("pointermove", { pointerType: "mouse", clientX: 950, clientY: 500 });
  assert.equal(element.dataset.logoActive, "false");
  assert.equal(properties.get("--logo-x"), "0px");
  assert.equal(properties.get("--logo-y"), "0px");
  assert.equal(element.dataset.active, "true");
  assert.equal(properties.get("--pointer-x"), "940px");
  cleanup();
});

test("背景文字随滚轮与页面滚动旋转，不吞掉滚动或缩放手势", () => {
  const { properties, dispatch, eventTarget, cleanup } = fixture();
  const event = dispatch("wheel", { deltaY: 100 });
  assert.ok(
    Math.abs(Number.parseFloat(properties.get("--type-rotation")) + 8) <
      0.000001,
  );
  assert.equal(event.defaultPrevented, false);
  dispatch("wheel", { deltaY: 100, ctrlKey: true });
  assert.ok(
    Math.abs(Number.parseFloat(properties.get("--type-rotation")) + 8) <
      0.000001,
  );
  for (let count = 0; count < 20; count++) dispatch("wheel", { deltaY: 10000 });
  assert.equal(properties.get("--type-rotation"), "65deg");
  eventTarget.scrollY = 300;
  dispatch("scroll");
  assert.equal(properties.get("--type-rotation"), "21deg");
  cleanup();
  dispatch("wheel", { deltaY: -100 });
  assert.equal(properties.get("--type-rotation"), "21deg");
});

test("减少动态效果初始生效，运行中开启也会停止位移并归位", () => {
  const first = fixture({ reducedMotion: true });
  first.dispatch("pointermove", {
    pointerType: "mouse",
    clientX: 900,
    clientY: 100,
  });
  first.dispatch("wheel", { deltaY: 100 });
  assert.equal(first.properties.get("--logo-x"), "0px");
  assert.equal(first.properties.has("--type-rotation"), false);
  first.cleanup();
  const current = fixture();
  current.dispatch("pointermove", {
    pointerType: "mouse",
    clientX: 900,
    clientY: 100,
  });
  current.dispatch("wheel", { deltaY: 100 });
  current.motion.matches = true;
  current.motion.dispatchEvent(new Event("change"));
  assert.equal(current.element.dataset.logoActive, "false");
  assert.equal(current.properties.get("--logo-x"), "0px");
  assert.equal(current.properties.get("--type-rotation"), "-15deg");
  current.cleanup();
});
