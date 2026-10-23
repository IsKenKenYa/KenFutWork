import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Blocks } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { SidebarNavButton } from "../src/components/workbench/zcode/host/SidebarNavButton.js";
import { HostSidebarRail } from "../src/components/workbench/zcode/host/WorkbenchModeNavigation.js";

/**
 * 侧栏收起态必须还承载得住入口（用户 2026-10-19：「侧边栏按钮缺失（插件市场技能等等任务、
 * 搜索等等）」）。rail 与展开态共用同一份 `SidebarNavButton` 定义，形态差异只体现在这里。
 */
const icon = <Blocks className="size-4" />;

afterEach(cleanup);

test("rail 形态：只剩图标，标签进 aria-label 与 title，点击照旧生效", () => {
  const onClick = vi.fn();
  const view = render(
    <SidebarNavButton
      collapsed
      icon={icon}
      label="插件市场"
      onClick={onClick}
    />,
  );
  const button = view.getByRole("button", { name: "插件市场" });
  expect(button.textContent).toBe("");
  expect(button.getAttribute("title")).toBe("插件市场");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test("展开形态：标签与次要读数都在，未选中不冒充切换按钮", () => {
  const view = render(
    <SidebarNavButton
      icon={icon}
      label="搜索"
      trailing="Ctrl+K"
      onClick={() => {}}
    />,
  );
  const button = view.getByRole("button", { name: /搜索/ });
  expect(button.textContent).toContain("搜索");
  expect(button.textContent).toContain("Ctrl+K");
  expect(button.hasAttribute("aria-pressed")).toBe(false);
});

test("选中态才声明 aria-pressed，报错原因走 title 不进标签", () => {
  const view = render(
    <SidebarNavButton
      collapsed
      icon={icon}
      label="重试插件入口"
      hint="插件入口读取失败"
      active
      onClick={() => {}}
    />,
  );
  const button = view.getByRole("button", { name: "重试插件入口" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("title")).toBe("插件入口读取失败");
});

test("禁用项不触发点击，rail 仍把它摆在原位", () => {
  const onClick = vi.fn();
  const view = render(
    <SidebarNavButton
      collapsed
      disabled
      icon={icon}
      label="新建任务"
      hint="当前项目只读"
      onClick={onClick}
    />,
  );
  const button = view.getByRole("button", { name: "新建任务" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test("rail 在展开按钮与模式之下渲染入口列，入口缺失时不留空轨道", () => {
  const onExpand = vi.fn();
  const view = render(
    <HostSidebarRail
      onExpand={onExpand}
      actions={
        <>
          <SidebarNavButton
            collapsed
            icon={icon}
            label="新建任务"
            onClick={() => {}}
          />
          <SidebarNavButton
            collapsed
            icon={icon}
            label="插件市场"
            onClick={() => {}}
          />
        </>
      }
    />,
  );
  expect(view.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  expect(view.getByRole("button", { name: "新建任务" })).toBeTruthy();
  expect(view.getByRole("button", { name: "插件市场" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "展开侧栏" }));
  expect(onExpand).toHaveBeenCalledOnce();
  view.unmount();
  const bare = render(<HostSidebarRail onExpand={onExpand} />);
  expect(bare.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
});

/**
 * 接线守卫：侧栏的 rail 分支必须把入口列交给 rail（曾经只传 onExpand，
 * 收起后插件市场·技能·MCP·插件面板·新建任务·搜索整个消失）。
 * WorkspaceSidebar 是千行组件、无法在此渲染，用源码断言把这条线钉住。
 */
test("侧栏 rail 分支承载入口列，且与展开态共用同一份定义", () => {
  // jsdom 环境下 import.meta.url 不是 file: URL，用相对 cwd（= 包目录）的路径读源码，
  // 与 settings-copy-guard 等源码守卫同一种写法。
  const source = readFileSync(
    "src/components/workbench/zcode/WorkspaceSidebar.tsx",
    "utf8",
  );
  expect(source).toContain("actions={railNavigation}");
  expect(source).toContain("{sharedNavigation(true)}");
  expect(source).toContain("{sharedNavigation(false)}");
  // 新建任务的动作只有一份定义（rail 与展开态共用，不各写一份闭包）
  expect(
    source.match(/handleCreateTaskFromSidebar/gu)?.length,
  ).toBeGreaterThanOrEqual(3);
  expect(source).not.toMatch(
    /<HostSidebarRail onExpand=\{\(\) => onExpand\?\.\(\)\} \/>/u,
  );
});
