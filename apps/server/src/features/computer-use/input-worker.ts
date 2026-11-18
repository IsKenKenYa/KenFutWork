/** 隔离原生输入库：取消时释放本次持有的键/按钮，父进程等待退出后才能让出控制权。 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Button, Key, keyboard, mouse, Point } from "@computer-use/nut-js";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";

type Input = (
  | {
      kind: "click";
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      count: 1 | 2;
    }
  | { kind: "move"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | {
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount: number;
      x?: number;
      y?: number;
    }
  | { kind: "keys"; keys: string[] }
  | { kind: "releaseKeys"; keys: Key[] }
  | { kind: "text"; text: string }
) & { inputDelayMs?: number; timeoutMs?: number };

let cancelled = false;
let heldButton: Button | undefined;
const heldKeys: Key[] = [];
const pressedKeys = new Set<Key>();
let freshCleanup = false;
// Apple SDK虚拟键码与CGEventFlags；它们是硬件常量，不是运行时治理值。
const macosModifiers = new Map<Key, [number, number]>([
  [Key.LeftCmd, [55, 1 << 20]],
  [Key.RightCmd, [54, 1 << 20]],
  [Key.LeftShift, [56, 1 << 17]],
  [Key.RightShift, [60, 1 << 17]],
  [Key.LeftControl, [59, 1 << 18]],
  [Key.RightControl, [62, 1 << 18]],
  [Key.LeftAlt, [58, 1 << 19]],
  [Key.RightAlt, [61, 1 << 19]],
  [Key.Fn, [63, 1 << 23]],
]);
let cleanupTimeoutMs: number =
  AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs;
async function releaseFreshMacosModifiers() {
  const modifiers = heldKeys.flatMap((key) => {
    const modifier = macosModifiers.get(key);
    return modifier ? [modifier] : [];
  });
  if (!modifiers.length) return;
  await promisify(execFile)(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `
ObjC.import('CoreGraphics'); ObjC.import('Foundation');
const modifiers=${JSON.stringify(modifiers)};
const mask=modifiers.reduce((value,entry)=>value|entry[1],0);
const flags=Number($.CGEventSourceFlagsState(0)) & ~mask;
for (const entry of modifiers) {
  const event=$.CGEventCreateKeyboardEvent(null,entry[0],false);
  $.CGEventSetFlags(event,flags); $.CGEventPost(0,event);
}
const deadline=Date.now()+${cleanupTimeoutMs};
while (Number($.CGEventSourceFlagsState(0)) & mask) {
  if (Date.now()>=deadline) throw new Error('修饰键释放未被系统确认');
  $.NSThread.sleepForTimeInterval(${AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs} / 1000);
}
JSON.stringify({ok:true});`,
    ],
    { timeout: cleanupTimeoutMs },
  );
}
const reportHeldKeys = () => {
  if (process.connected) process.send?.({ heldKeys: [...heldKeys] }, () => {});
};
const platformMetaKey = process.platform === "darwin" ? "LeftCmd" : "LeftWin";
const aliases: Record<string, keyof typeof Key> = {
  cmd: platformMetaKey,
  command: platformMetaKey,
  super: platformMetaKey,
  meta: platformMetaKey,
  ctrl: "LeftControl",
  control: "LeftControl",
  alt: "LeftAlt",
  option: "LeftAlt",
  shift: "LeftShift",
  enter: "Return",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};
function check() {
  if (cancelled) throw new Error("输入已取消");
}
async function release(immediate = false) {
  if (immediate) {
    keyboard.config.autoDelayMs = 0;
    mouse.config.autoDelayMs = 0;
  }
  const button = heldButton;
  heldButton = undefined;
  if (button !== undefined) await mouse.releaseButton(button);
  if (freshCleanup && process.platform === "darwin")
    await releaseFreshMacosModifiers();
  for (const key of [...heldKeys].reverse()) {
    // SIGTERM可在SDK的press延迟期间到达；未发down的预留键不能反而制造modifier flags。
    if (!immediate || pressedKeys.has(key) || freshCleanup) {
      // fresh libnut的flagBuffer没有原进程的down；其modifier up会反而置位。
      if (
        !(
          freshCleanup &&
          process.platform === "darwin" &&
          macosModifiers.has(key)
        )
      )
        await keyboard.releaseKey(key);
    }
    pressedKeys.delete(key);
    const index = heldKeys.indexOf(key);
    if (index >= 0) heldKeys.splice(index, 1);
    reportHeldKeys();
  }
}
let closing = false;
const cancelAndExit = () => {
  if (closing) return;
  closing = true;
  cancelled = true;
  void release(true).then(
    () => {
      if (!process.connected) process.exit(0);
      else
        process.send?.({ ok: false, error: "输入已取消并释放持有按键" }, () =>
          process.exit(0),
        );
    },
    () => process.exit(1),
  );
};
process.on("SIGTERM", cancelAndExit);
process.on("disconnect", cancelAndExit);
process.once("message", async (input: Input) => {
  cleanupTimeoutMs =
    input.timeoutMs ?? AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs;
  keyboard.config.autoDelayMs =
    input.inputDelayMs ?? AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs;
  mouse.config.autoDelayMs =
    input.inputDelayMs ?? AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs;
  try {
    check();
    if ("x" in input && input.x !== undefined && input.y !== undefined)
      await mouse.setPosition(new Point(input.x, input.y));
    check();
    switch (input.kind) {
      case "move":
        break;
      case "click": {
        const button = {
          left: Button.LEFT,
          right: Button.RIGHT,
          middle: Button.MIDDLE,
        }[input.button];
        if (input.count === 2) await mouse.doubleClick(button);
        else await mouse.click(button);
        break;
      }
      case "drag":
        heldButton = Button.LEFT;
        await mouse.pressButton(heldButton);
        check();
        await mouse.setPosition(new Point(input.toX, input.toY));
        break;
      case "scroll":
        await {
          up: mouse.scrollUp,
          down: mouse.scrollDown,
          left: mouse.scrollLeft,
          right: mouse.scrollRight,
        }[input.direction].call(mouse, input.amount);
        break;
      case "keys": {
        const keys = input.keys.map((raw) => {
          const name = aliases[raw.toLowerCase()] ?? raw.toUpperCase();
          const key = Key[name as keyof typeof Key];
          if (typeof key !== "number") throw new Error(`不支持的按键：${raw}`);
          return key;
        });
        if (new Set(keys).size !== keys.length)
          throw new Error("组合键不能重复同一按键");
        for (const key of keys) {
          check();
          heldKeys.push(key);
          reportHeldKeys();
          await keyboard.pressKey(key);
          pressedKeys.add(key);
        }
        break;
      }
      case "releaseKeys":
        freshCleanup = true;
        heldKeys.push(...input.keys);
        await release(true);
        break;
      case "text":
        await keyboard.type(input.text);
        break;
    }
    check();
    await release();
    process.send?.({ ok: true, position: await mouse.getPosition() });
  } catch (error) {
    await release(true).catch(() => {});
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    process.disconnect?.();
  }
});
