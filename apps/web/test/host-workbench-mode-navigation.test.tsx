import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostWorkbenchModeNavigation,
  WorkbenchModeNavigation,
} from "@/components/workbench/zcode/host/WorkbenchModeNavigation";

/** 从组件 props 提取模式联合（跟随 @zcode/shared 的 HostWorkbenchMode，不复制字面量）。 */
type HostWorkbenchMode = React.ComponentProps<
  typeof WorkbenchModeNavigation
>["mode"];

const hostState = vi.hoisted(() => ({
  snapshot: {
    mode: "code" as HostWorkbenchMode,
    availableModes: ["code", "design", "flow"] as readonly HostWorkbenchMode[],
  },
  listeners: new Set<() => void>(),
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    workbenchNavigation: {
      subscribe: (listener: () => void) => {
        hostState.listeners.add(listener);
        return () => hostState.listeners.delete(listener);
      },
      getSnapshot: () => hostState.snapshot,
      open: vi.fn(),
    },
  }),
}));
vi.mock(
  "@/components/workbench/zcode/host/ProjectDirectoryRecovery.js",
  () => ({
    ProjectDirectoryRecovery: () => (
      <div data-testid="code-directory-recovery" />
    ),
  }),
);

describe("HostWorkbenchModeNavigation directory recovery", () => {
  afterEach(() => {
    cleanup();
    hostState.snapshot = {
      mode: "code",
      availableModes: ["code", "design", "flow"],
    };
    hostState.listeners.clear();
  });

  it("renders recovery only while Code mode is active", () => {
    const view = render(<HostWorkbenchModeNavigation />);
    expect(screen.getByTestId("code-directory-recovery")).toBeTruthy();
    hostState.snapshot = { ...hostState.snapshot, mode: "design" };
    hostState.listeners.forEach((listener) => {
      listener();
    });
    view.rerender(<HostWorkbenchModeNavigation />);
    expect(screen.queryByTestId("code-directory-recovery")).toBeNull();
    hostState.snapshot = { ...hostState.snapshot, mode: "flow" };
    hostState.listeners.forEach((listener) => {
      listener();
    });
    view.rerender(<HostWorkbenchModeNavigation />);
    expect(screen.queryByTestId("code-directory-recovery")).toBeNull();
  });
});

describe("HostWorkbenchModeNavigation 四模式", () => {
  afterEach(() => {
    cleanup();
    hostState.listeners.clear();
  });

  it("availableModes 含 work 时渲染第四档 Flow，选中态跟随快照", () => {
    hostState.snapshot = {
      mode: "work",
      availableModes: ["code", "design", "flow", "work"],
    };
    render(<HostWorkbenchModeNavigation />);
    const group = screen.getByRole("radiogroup", { name: "模式切换" });
    const radios = group.querySelectorAll<HTMLButtonElement>("[role='radio']");
    expect(radios).toHaveLength(4);
    expect(
      Array.from(radios).map((radio) => radio.textContent),
    ).toEqual(["Code", "Design", "Work", "Flow"]);
    expect(
      Array.from(radios).map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "true", "false"]);
    expect(screen.getByRole("radio", { name: "Work" })).toBeTruthy();
  });

  it("展开态只留文字分档，不放图标（用户口径）", () => {
    render(
      <WorkbenchModeNavigation
        mode="code"
        availableModes={["code", "design", "work", "flow"]}
        onModeChange={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "模式切换" });
    for (const radio of group.querySelectorAll<HTMLButtonElement>(
      "[role='radio']",
    )) {
      expect(radio.querySelector("svg")).toBeNull();
    }
  });

  it("work 不可用时只有三档（入口纪律：不摆空壳入口）", () => {
    hostState.snapshot = {
      mode: "code",
      availableModes: ["code", "design", "flow"],
    };
    render(<HostWorkbenchModeNavigation />);
    const group = screen.getByRole("radiogroup", { name: "模式切换" });
    expect(
      group.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ).toHaveLength(3);
    expect(screen.queryByRole("radio", { name: "Work" })).toBeNull();
  });

  it("收起态同样渲染四档图标", () => {
    render(
      <WorkbenchModeNavigation
        mode="code"
        availableModes={["code", "design", "flow", "work"]}
        onModeChange={() => {}}
        collapsed
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "模式切换" });
    expect(
      group.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    ).toHaveLength(4);
  });
});
