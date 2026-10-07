import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { CuOperationContext } from "./executor.js";
import { runJxa } from "./jxa.js";

type MouseInput =
  | { kind: "move"; x: number; y: number }
  | {
      kind: "click";
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      count: 1 | 2;
    }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | {
      kind: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount: number;
      x?: number;
      y?: number;
    };

/** CoreGraphics接受全局逻辑坐标（主屏左上为原点），不经过nut的AppKit鼠标坐标转换。 */
export async function macosMouse(
  input: MouseInput,
  context: CuOperationContext,
  timeoutMs: number,
): Promise<{ x: number; y: number }> {
  context.signal.throwIfAborted();
  const script = `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const input = ${JSON.stringify({ ...input, inputDelayMs: context.inputDelayMs ?? AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs })};
function post(type, x, y, button, count) {
  const event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  if (!event) throw new Error('无法创建系统输入事件');
  if (count) $.CGEventSetIntegerValueField(event, 1, count);
  $.CGEventPost(0, event);
  if (input.inputDelayMs > 0) $.NSThread.sleepForTimeInterval(input.inputDelayMs / 1000);
}
if (input.x !== undefined) post(5, input.x, input.y, 0, 0);
if (input.kind === 'click') {
  const button = input.button === 'right' ? 1 : input.button === 'middle' ? 2 : 0;
  const down = button === 0 ? 1 : button === 1 ? 3 : 25;
  const up = button === 0 ? 2 : button === 1 ? 4 : 26;
  for (let count = 1; count <= input.count; count++) {
    post(down, input.x, input.y, button, count);
    post(up, input.x, input.y, button, count);
  }
} else if (input.kind === 'drag') {
  post(1, input.x, input.y, 0, 1);
  post(6, input.toX, input.toY, 0, 1);
  post(2, input.toX, input.toY, 0, 1);
} else if (input.kind === 'scroll') {
  const vertical = input.direction === 'up' ? input.amount : input.direction === 'down' ? -input.amount : 0;
  const horizontal = input.direction === 'left' ? input.amount : input.direction === 'right' ? -input.amount : 0;
  const event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, vertical, horizontal, 0);
  if (!event) throw new Error('无法创建系统滚轮事件');
  $.CGEventPost(0, event);
}
const event = $.CGEventCreate(null), position = $.CGEventGetLocation(event);
const result = { x: position.x, y: position.y };
JSON.stringify(result);`;
  try {
    return (await runJxa(
      script,
      context.timeoutMs ?? timeoutMs,
      context.signal,
      context.maxOutputBytes,
    )) as { x: number; y: number };
  } catch (error) {
    // down之后进程被取消时，补发up；不能撤销已经送到OS的输入，调用方必须重观察。
    if (input.kind === "drag" || input.kind === "click") {
      const button =
        input.kind === "click" && input.button === "right"
          ? 1
          : input.kind === "click" && input.button === "middle"
            ? 2
            : 0;
      const type = button === 0 ? 2 : button === 1 ? 4 : 26;
      await runJxa(
        `ObjC.import('CoreGraphics'); const e=$.CGEventCreate(null), p=$.CGEventGetLocation(e);
const up=$.CGEventCreateMouseEvent(null,${type},p,${button}); $.CGEventPost(0,up); JSON.stringify({ok:true});`,
        context.timeoutMs ?? timeoutMs,
        undefined,
        context.maxOutputBytes,
      ).catch(() => {});
    }
    throw error;
  }
}
