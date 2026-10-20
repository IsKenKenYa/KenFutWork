import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(
  "src/components/workbench/zcode/v4/ConversationDraftEmptyState.tsx",
  "utf8",
);

/**
 * 空态标题的字号 = f(容器可用宽 / 文案自然宽)，而「自然宽」必须是 **36px 基准**下量出来的。
 * 测量用的隐形 <span> 是 <p> 的子节点，会继承 <p> 当前字号：一旦不钉住基准，
 * 量到的就是「当前字号下的宽度」，于是 字号→自然宽→字号 自激振荡
 * （2026-10-20 实测：容器 247px / 自然宽 423px 时，标题在 36px↔21px 之间每帧来回，
 * 屏幕上就是「Design with KenFutWork」左右跳动）。
 */
test("空态标题的测量基准固定在字号上限，不继承当前字号", () => {
  const measurement = source.slice(
    source.indexOf("ref={greetingMeasurementRef}"),
    source.indexOf("</span>", source.indexOf("ref={greetingMeasurementRef}")),
  );
  expect(measurement).toContain(
    "style={{ fontSize: GREETING_MAX_FONT_SIZE_PX }}",
  );
});

test("ResizeObserver 只观察容器，不观察随字号变化的测量节点", () => {
  expect(source).toContain("observer.observe(container)");
  expect(source).not.toContain("observer.observe(measurement)");
});

/**
 * 只按文字宽判「放得下」会让整行（图标 + 间距 + 文字）顶出内容区：
 * 实测 456px 内容区里塞进 40 + 12 + 423 = 475px，左右各溢出 9.5px——
 * 左边吃掉 padding 看着贴边，右边因滚动条留白显得更宽，用户读作「没居中」。
 */
test("可用宽度扣掉了图标与间距，不只看文字", () => {
  const measure = source.slice(
    source.indexOf("const measure = () =>"),
    source.indexOf("const scheduleMeasure"),
  );
  expect(measure).toContain("GREETING_ICON_MAX_PX");
  expect(measure).toContain("rowGapPx");
  expect(measure).toContain("horizontalPaddingPx -");
});

test("标题图标随字号等比缩放，不是死尺寸", () => {
  expect(source).toContain("const greetingIconPx = Math.round(");
  expect(source).toContain("GREETING_ICON_MAX_PX * greetingFontSizePx");
  expect(source).not.toContain("size-10 shrink-0");
});
