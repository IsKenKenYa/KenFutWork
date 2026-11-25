// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelConfigSelect } from "@zui/ModelConfigSelect.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * 思考强度滑块的指针交互。
 *
 * ① 松手后到上游回写之间的档位显示（用户口径 2026-11-25「进度条闪烁」「按钮有概率回弹」）：
 * `effort.option.currentValue` 由上游异步回写（草稿变化 → ModelSelectionView 重新读取，
 * 实测 41–59ms）。这里让父组件只在测试明确要求时才更新它，
 * 复现「已经松手、回写还没到」的那几帧：滑块必须停在松手选的档上。
 *
 * ② 点击与拖动的过渡（用户口径 2026-11-25「加一点点过渡动画，就像下面的选择器文本一样」）：
 * 按下后带着过渡滑到按下的档位；指针拖离那一档之后改为跟手。
 *
 * ③ 按下不向祖先冒泡：模型菜单是弹层，React 事件会沿组件树冒泡到输入框表层，
 * 那里的「按住说话」满 200ms 会抢走指针捕获并开始录音，滑块就收不到松手了。
 */

const LEVELS = [
  { value: "low", name: "low" },
  { value: "high", name: "high" },
  { value: "max", name: "max" },
];
/** 轨道 198px 宽、手柄 32px：第 index 档的圆心横坐标（三档时是 16 / 99 / 182）。 */
const TRACK_WIDTH = 198;
const KNOB_WIDTH = 32;
const levelX = (index: number) =>
  KNOB_WIDTH / 2 + (index / (LEVELS.length - 1)) * (TRACK_WIDTH - KNOB_WIDTH);

/** jsdom 没有指针捕获；滑块靠它判断「还在拖」，这里按真实语义记录捕获状态。 */
const captured = new Set<number>();

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = (pointerId) => {
    captured.add(pointerId);
  };
  HTMLElement.prototype.releasePointerCapture = (pointerId) => {
    captured.delete(pointerId);
  };
  HTMLElement.prototype.hasPointerCapture = (pointerId) =>
    captured.has(pointerId);
  // jsdom 没有 Web Animations API。滑块挂载时给扫光层起一个无限循环动画，
  // 之后只改它的 playbackRate、卸载时 cancel；这里补上这三个成员。
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value: () => ({ playbackRate: 1, cancel: () => {} }),
  });
});

afterEach(() => {
  captured.clear();
  cleanup();
});

const TRACK_RECT = {
  left: 0,
  top: 0,
  right: TRACK_WIDTH,
  bottom: KNOB_WIDTH,
  width: TRACK_WIDTH,
  height: KNOB_WIDTH,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

/** jsdom 不排版，所有矩形都是 0；按真实几何给出轨道矩形。 */
function stubTrackRect(track: HTMLElement) {
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(TRACK_RECT);
}

const MODEL_GROUPS = [
  {
    key: "p",
    label: "p",
    items: [{ key: "m", value: "p/m", name: "m" }],
  },
];

function renderMenu(
  initialValue: string,
  options = LEVELS,
  onAncestorPointerDown?: () => void,
) {
  const onValueChange = vi.fn<(value: string) => void>();
  const menu = (currentValue: string, currentOptions = options) => (
    <ModelConfigSelect
      modelGroups={MODEL_GROUPS}
      normalizedValue="p/m"
      triggerLabel="m"
      showManageModelsAction={false}
      lockReasonMessage=""
      isItemLocked={() => false}
      onValueChange={() => {}}
      open
      onOpenChange={() => {}}
      effort={{
        option: { currentValue, options: currentOptions },
        onValueChange,
      }}
    />
  );
  const ui = (currentValue: string, currentOptions = options) =>
    onAncestorPointerDown ? (
      <div onPointerDown={onAncestorPointerDown}>
        {menu(currentValue, currentOptions)}
      </div>
    ) : (
      menu(currentValue, currentOptions)
    );
  const view = render(ui(initialValue));
  stubTrackRect(screen.getByRole("slider", { name: "思考强度" }));
  return {
    onValueChange,
    /** 上游回写：父组件带着新值重新渲染。 */
    writeBack: (value: string, nextOptions = options) => {
      act(() => {
        view.rerender(ui(value, nextOptions));
      });
    },
  };
}

const slider = () => screen.getByRole("slider", { name: "思考强度" });

function expectLevel(index: string, text: string) {
  expect(slider()).toHaveAttribute("aria-valuenow", index);
  expect(slider()).toHaveAttribute("aria-valuetext", text);
}

/** 填充层的过渡：拖离按下的档位后是 `none`（跟手），其余时候过渡 `clip-path`。 */
const fillTransition = () => {
  const fill = [...slider().querySelectorAll<HTMLElement>("div")].find(
    (div) => div.style.clipPath,
  );
  return fill?.style.transition ?? null;
};

/** jsdom 不加载样式表，手柄的过渡只能从类名上看。 */
const knobHasTransition = () =>
  [...slider().querySelectorAll<HTMLElement>("span")].some(
    (span) =>
      span.className.includes("size-8") &&
      span.className.includes("transition-[left]"),
  );

/** 回写还没到：让出几个事件循环，等价于真实界面里过去了几帧。 */
async function passFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/** 在某一档的圆心上点一下：`"[MouseLeft]"` 一步完成按下和松开。 */
async function clickLevel(
  user: ReturnType<typeof userEvent.setup>,
  index: number,
) {
  await user.pointer([
    {
      target: slider(),
      keys: "[MouseLeft]",
      coords: { x: levelX(index), y: 16 },
    },
  ]);
}

test("松手后回写未到时停在所选档位，且只提交一次", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  // 按住拖到最右：未松手前只预览，不提交。
  // `"[MouseLeft>]"` 是只按不放，之后用 `"[/MouseLeft]"` 松开。
  await user.pointer([
    {
      target: slider(),
      keys: "[MouseLeft>]",
      coords: { x: levelX(1), y: 16 },
    },
    { coords: { x: levelX(2), y: 16 } },
  ]);
  expectLevel("2", "最高");
  expect(onValueChange).not.toHaveBeenCalled();

  await user.pointer([{ keys: "[/MouseLeft]" }]);
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenLastCalledWith("max");
  expectLevel("2", "最高");

  // 松手了、回写还没到：不退回上游的旧档
  await passFrames();
  expectLevel("2", "最高");

  writeBack("max");
  expectLevel("2", "最高");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test("回写未到时再松手到正显示的档位：不重复提交", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  await clickLevel(user, 2);
  await clickLevel(user, 2);

  expect(onValueChange).toHaveBeenCalledTimes(1);
  expectLevel("2", "最高");
  writeBack("max");
  expectLevel("2", "最高");
});

test("回写未到时松手回上游原档位：重新提交原档位", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  await clickLevel(user, 2);
  await clickLevel(user, 1);

  // 不重发的话，上一次还在路上的回写会盖掉最后这一次选择
  expect(onValueChange.mock.calls.map(([value]) => value)).toEqual([
    "max",
    "high",
  ]);
  expectLevel("1", "高");

  writeBack("max");
  writeBack("high");
  expectLevel("1", "高");
});

test("占位期间上游被改成别的档位：跟随上游", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  await clickLevel(user, 2);
  expectLevel("2", "最高");

  writeBack("low");
  expectLevel("0", "低");

  // 上游随后回到原档位：不能被残留的占位顶回「最高」
  writeBack("high");
  expectLevel("1", "高");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test("回写完成后占位撤掉，之后的上游变化不会被顶回", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  await clickLevel(user, 2);
  writeBack("max");
  expectLevel("2", "最高");

  writeBack("high");
  expectLevel("1", "高");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test("占位的档位已不在档位表里：跟随上游", async () => {
  const user = userEvent.setup();
  const { writeBack } = renderMenu("high");

  await clickLevel(user, 2);
  expectLevel("2", "最高");

  // 换成只有两档的模型：占位的「最高」没有对应档位，不能再按序号 2 去画
  writeBack(
    "high",
    LEVELS.filter((level) => level.value !== "max"),
  );
  expectLevel("1", "高");
});

test("松手位置就是当前档位：不提交也不进入占位", async () => {
  const user = userEvent.setup();
  const { onValueChange, writeBack } = renderMenu("high");

  await clickLevel(user, 1);
  expect(onValueChange).not.toHaveBeenCalled();
  expectLevel("1", "高");

  writeBack("low");
  expectLevel("0", "低");
});

test("点一下轨道：按住时与松手后手柄和填充都带着过渡", async () => {
  const user = userEvent.setup();
  const { onValueChange } = renderMenu("high");

  await user.pointer([
    {
      target: slider(),
      keys: "[MouseLeft>]",
      coords: { x: levelX(2), y: 16 },
    },
  ]);
  expectLevel("2", "最高");
  expect(knobHasTransition()).toBe(true);
  expect(fillTransition()).toContain("clip-path");

  await user.pointer([{ keys: "[/MouseLeft]" }]);
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(knobHasTransition()).toBe(true);
  expect(fillTransition()).toContain("clip-path");
});

test("拖离按下的那一档后不再带过渡，松手后恢复", async () => {
  const user = userEvent.setup();
  renderMenu("high");

  await user.pointer([
    {
      target: slider(),
      keys: "[MouseLeft>]",
      coords: { x: levelX(2), y: 16 },
    },
    // 还在「最高」这一档的范围内移动：档位没变，继续带过渡
    { coords: { x: levelX(2) - 20, y: 16 } },
  ]);
  expectLevel("2", "最高");
  expect(knobHasTransition()).toBe(true);
  expect(fillTransition()).toContain("clip-path");

  // 拖到「高」：跨档，改为跟手
  await user.pointer([{ coords: { x: levelX(1), y: 16 } }]);
  expectLevel("1", "高");
  expect(knobHasTransition()).toBe(false);
  expect(fillTransition()).toBe("none");

  // 拖回「最高」仍然是拖动
  await user.pointer([{ coords: { x: levelX(2), y: 16 } }]);
  expectLevel("2", "最高");
  expect(knobHasTransition()).toBe(false);
  expect(fillTransition()).toBe("none");

  await user.pointer([{ keys: "[/MouseLeft]" }]);
  expect(knobHasTransition()).toBe(true);
  expect(fillTransition()).toContain("clip-path");
});

test("在轨道上按下不向祖先冒泡", async () => {
  const user = userEvent.setup();
  const onAncestorPointerDown = vi.fn();
  const { onValueChange } = renderMenu("high", LEVELS, onAncestorPointerDown);

  await clickLevel(user, 2);

  expect(onAncestorPointerDown).not.toHaveBeenCalled();
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenLastCalledWith("max");
});
