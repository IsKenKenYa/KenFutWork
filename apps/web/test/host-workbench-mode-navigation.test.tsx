import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostWorkbenchModeNavigation } from "@/components/workbench/zcode/host/WorkbenchModeNavigation";

const hostState = vi.hoisted(() => ({
  snapshot: {
    mode: "code" as "code" | "design" | "flow",
    availableModes: ["code", "design", "flow"] as const,
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
