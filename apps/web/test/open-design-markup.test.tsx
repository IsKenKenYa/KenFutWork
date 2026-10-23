import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DesignReviewAnnotation } from "@kenfutwork/shared";
import { OpenDesignMarkup } from "../src/components/workbench/zcode/host/OpenDesignMarkup.js";
import type { OpenDesignHit } from "../src/components/workbench/zcode/host/openDesignRuntime.js";

/**
 * 标注层的三套指针语义（直接渲染组件，box/metrics 显式给值——
 * jsdom 没有布局，整页测试里拖拽位移会恒为 0）。
 */
const BOX = { left: 0, top: 0, width: 400, height: 300 };
const METRICS = { w: 400, h: 300, vw: 400, vh: 300, sx: 0, sy: 0 };

const RECT_ANNOTATION: DesignReviewAnnotation = {
  id: "a-1",
  projectId: "p-1",
  file: "index.html",
  kind: "rect",
  color: "#e11d48",
  strokeWidth: 3,
  points: [
    [0.25, 0.25],
    [0.5, 0.5],
  ],
  createdAt: 1,
  updatedAt: 1,
};

function renderMarkup(overrides: Partial<Parameters<typeof OpenDesignMarkup>[0]> = {}) {
  const props = {
    comments: [],
    annotations: [RECT_ANNOTATION],
    rects: {},
    box: BOX,
    metrics: METRICS,
    drawing: false,
    annotationKind: "pen" as const,
    color: "#e11d48",
    onPickComment: vi.fn(),
    onCreateAnnotation: vi.fn(),
    onDeleteAnnotation: vi.fn(),
    onUpdateAnnotation: vi.fn(),
    onMoveElement: vi.fn(),
    ...overrides,
  };
  const view = render(<OpenDesignMarkup {...props} />);
  return { ...props, view };
}

afterEach(() => {
  cleanup();
});

describe("批注选择与橡皮擦", () => {
  test("拖动已画矩形：点集整体位移并经 PATCH 回调落库", async () => {
    const onUpdateAnnotation = vi.fn();
    renderMarkup({ adjusting: true, onUpdateAnnotation });
    const hit = await screen.findByTestId("open-design-markup");
    const shape = hit.querySelector('[data-annotation-hit="a-1"]');
    expect(shape).toBeTruthy();
    const svg = hit.querySelector("svg") as SVGSVGElement;
    fireEvent.pointerDown(shape as Element, {
      pointerId: 1,
      clientX: 150,
      clientY: 120,
    });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 190, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 190, clientY: 150 });
    await waitFor(() => expect(onUpdateAnnotation).toHaveBeenCalled());
    const [id, points] = onUpdateAnnotation.mock.calls[0] as [
      string,
      [number, number][],
    ];
    expect(id).toBe("a-1");
    // 位移 (40,30)px / 画布 (400,300) = (0.1,0.1)
    expect(points[0]?.[0]).toBeCloseTo(0.35, 5);
    expect(points[0]?.[1]).toBeCloseTo(0.35, 5);
    expect(points[1]?.[0]).toBeCloseTo(0.6, 5);
    expect(points[1]?.[1]).toBeCloseTo(0.6, 5);
  });

  test("橡皮擦：点已有笔迹立即删除", async () => {
    const onDeleteAnnotation = vi.fn();
    renderMarkup({ erasing: true, onDeleteAnnotation });
    const shape = (
      await screen.findByTestId("open-design-markup")
    ).querySelector('[data-annotation-hit="a-1"]');
    fireEvent.pointerDown(shape as Element, { pointerId: 1 });
    expect(onDeleteAnnotation).toHaveBeenCalledWith("a-1");
  });

  test("普通标注态不误删：笔迹不接点击", async () => {
    const onDeleteAnnotation = vi.fn();
    renderMarkup({ drawing: true, onDeleteAnnotation });
    const shape = (
      await screen.findByTestId("open-design-markup")
    ).querySelector('[data-annotation-hit="a-1"]');
    expect(shape?.getAttribute("pointer-events")).toBe("none");
  });
});

describe("元素选择", () => {
  function hit(path: string, tag: string, x = 0): OpenDesignHit {
    return {
      path,
      tag,
      text: "",
      html: "",
      rect: { x, y: 0, w: 100, h: 60 },
      color: "",
      backgroundColor: "",
      fontSize: "",
      fontWeight: "",
      textAlign: "",
      padding: "",
      margin: "",
      borderRadius: "",
    };
  }

  test("点选元素→拖到另一个容器→以 inside 落位", async () => {
    const onMoveElement = vi.fn();
    const hitTest = vi
      .fn()
      .mockResolvedValueOnce(hit("#app > h1", "h1"))
      .mockResolvedValueOnce(hit("#app > section", "section"));
    renderMarkup({ elementSelecting: true, hitTest, onMoveElement });
    const svg = (
      await screen.findByTestId("open-design-markup")
    ).querySelector("svg") as SVGSVGElement;
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 120, clientY: 90 });
    await screen.findByTestId("open-design-element-selection");
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 220, clientY: 150 });
    await waitFor(() =>
      expect(screen.queryByTestId("open-design-element-target")).not.toBeNull(),
    );
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 220, clientY: 150 });
    await waitFor(() => expect(onMoveElement).toHaveBeenCalled());
    expect(onMoveElement).toHaveBeenCalledWith(
      "#app > h1",
      "#app > section",
      "inside",
    );
  });

  test("拖到非容器上：按落点在目标左/右插到前/后", async () => {
    const onMoveElement = vi.fn();
    const hitTest = vi
      .fn()
      .mockResolvedValueOnce(hit("#app > h1", "h1"))
      // 目标在 x=300 处，宽 100：落点 320 在左半 → before
      .mockResolvedValueOnce(hit("#app > p", "p", 300));
    renderMarkup({ elementSelecting: true, hitTest, onMoveElement });
    const svg = (
      await screen.findByTestId("open-design-markup")
    ).querySelector("svg") as SVGSVGElement;
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 50, clientY: 50 });
    await screen.findByTestId("open-design-element-selection");
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 320, clientY: 60 });
    await waitFor(() =>
      expect(screen.queryByTestId("open-design-element-target")).not.toBeNull(),
    );
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 320, clientY: 60 });
    await waitFor(() => expect(onMoveElement).toHaveBeenCalled());
    expect(onMoveElement).toHaveBeenCalledWith("#app > h1", "#app > p", "before");
  });
});
