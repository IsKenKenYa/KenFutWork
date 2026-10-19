import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@zui/components/ui/resizable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAnimatedResizablePanel } from "../src/components/workbench/zcode/app-shell/useAnimatedResizablePanel";

const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 0;

beforeEach(() => {
  // JSDOM 不执行 flex 布局；给真实 Panel 注册提供 1000px 的纵向工作区。
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.id === "content" ? 700 : this.id === "terminal" ? 300 : 1000;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextAnimationFrameId;
    animationFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    animationFrames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  animationFrames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function flushAnimationFrame() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  act(() => {
    for (const callback of callbacks) callback(performance.now());
  });
}

function AnimatedPanelFixture({
  mounted,
  open = false,
  panelKey = "terminal",
  expandedSize,
  resizeOnInitialVisibleMount = true,
}: {
  mounted: boolean;
  open?: boolean;
  panelKey?: string;
  expandedSize?: string;
  resizeOnInitialVisibleMount?: boolean;
}) {
  const { panelRef, panelElementRef } = useAnimatedResizablePanel({
    open,
    alwaysMounted: true,
    ...(expandedSize ? { expandedSize } : {}),
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount,
  });

  return (
    <>
      <button type="button" onClick={() => panelRef.current?.resize("42%")}>
        调整面板尺寸
      </button>
      <ResizablePanelGroup
        id="animated-panel-lifecycle"
        layoutId="animated-panel-lifecycle"
        orientation="vertical"
      >
        <ResizablePanel id="content" defaultSize="70%" />
        {mounted ? (
          <ResizablePanel
            key={panelKey}
            id="terminal"
            panelRef={panelRef}
            elementRef={panelElementRef}
            defaultSize="30%"
            collapsible
          />
        ) : null}
      </ResizablePanelGroup>
    </>
  );
}

it("Panel 在动画帧前卸载后，迟到的收起命令不会再读取已注销布局", () => {
  const view = render(<AnimatedPanelFixture mounted />);
  view.rerender(<AnimatedPanelFixture mounted={false} />);

  expect(flushAnimationFrame).not.toThrow();
});

it("相同 id 的 Panel 被替换后，旧动画帧不会收起新实例", () => {
  const view = render(<AnimatedPanelFixture mounted />);
  const previousPanel = screen.getByTestId("terminal");
  view.rerender(<AnimatedPanelFixture mounted panelKey="replacement" />);
  const replacementPanel = screen.getByTestId("terminal");

  expect(replacementPanel).not.toBe(previousPanel);
  flushAnimationFrame();
  expect(replacementPanel.style.flexGrow).toBe("30");
});

it("展开使用目标尺寸，收起再展开保留用户调整的尺寸", () => {
  const view = render(<AnimatedPanelFixture mounted open expandedSize="35%" />);
  flushAnimationFrame();
  expect(screen.getByTestId("terminal").style.flexGrow).toBe("35");

  fireEvent.click(screen.getByRole("button", { name: "调整面板尺寸" }));
  expect(screen.getByTestId("terminal").style.flexGrow).toBe("42");
  view.rerender(
    <AnimatedPanelFixture mounted open={false} expandedSize="35%" />,
  );
  flushAnimationFrame();
  expect(screen.getByTestId("terminal").style.flexGrow).toBe("0");

  view.rerender(<AnimatedPanelFixture mounted open expandedSize="35%" />);
  flushAnimationFrame();
  expect(screen.getByTestId("terminal").style.flexGrow).toBe("42");
});

it("首次可见挂载可保留 PanelGroup 的已有尺寸", () => {
  render(
    <AnimatedPanelFixture
      mounted
      open
      expandedSize="35%"
      resizeOnInitialVisibleMount={false}
    />,
  );
  flushAnimationFrame();

  expect(screen.getByTestId("terminal").style.flexGrow).toBe("30");
});
