import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalShellMenu } from "../src/components/workbench/zcode/host/TerminalShellMenu";

/**
 * Code 终端面板工具栏 shell 菜单（G9/Q17）：
 * - 选项来自 GET /api/code/shells（按本机存在性），不伪造不可用选项；
 * - 未显式选过 shell 时，选中态与触发展示都落在 resolved 默认上；
 * - 选择只回调 onSelectShell——停旧会话/按新 shell 重开由面板状态负责；
 * - 拿不到清单（失败/空）就不渲染菜单（不摆空壳）。
 *
 * 注：radix 弹层在同一 jsdom 环境里跨用例二次渲染后无法再打开（执行档 chip 菜单
 * 测试同因只开一个用例），交互断言合并进同一个用例、多轮 open/select。
 */
const SHELLS_BODY = {
  shells: [
    { id: "cmd", label: "cmd", executable: "C:\\Windows\\system32\\cmd.exe" },
    {
      id: "powershell",
      label: "Windows PowerShell",
      executable:
        "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\powershell.exe",
    },
    {
      id: "git-bash",
      label: "Git Bash",
      executable: "C:\\Program Files\\Git\\bin\\bash.exe",
    },
  ],
  defaultShell: "auto",
  resolvedShell: "powershell",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubShellsResponse(body: unknown = SHELLS_BODY, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );
}

describe("终端 shell 菜单", () => {
  it("打开菜单：按清单渲染选项、resolved 默认选中、activeShell 覆盖、选择回调 shell id", async () => {
    stubShellsResponse();
    const user = userEvent.setup();
    const onSelectShell = vi.fn();
    const view = render(<TerminalShellMenu onSelectShell={onSelectShell} />);

    // 未显式选过 shell：触发展示 resolved 默认（auto 解析后的那个）
    const trigger = await screen.findByRole("button", { name: "Shell" });
    expect(trigger.textContent).toContain("Windows PowerShell");

    await user.click(trigger);
    const menu = screen.getByRole("menu");
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      "cmd",
      "Windows PowerShell",
      "Git Bash",
    ]);
    expect(
      menu.querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.textContent,
    ).toBe("Windows PowerShell");

    // 选择 Git Bash：菜单关闭，只回调 id（换会话逻辑不在本组件）
    await user.click(screen.getByRole("menuitemradio", { name: "Git Bash" }));
    expect(onSelectShell).toHaveBeenCalledTimes(1);
    expect(onSelectShell).toHaveBeenCalledWith("git-bash");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // 会话显式选定 shell 后：触发显示该 shell，重开菜单对应项选中
    view.rerender(
      <TerminalShellMenu
        activeShell="git-bash"
        onSelectShell={onSelectShell}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Shell" }).textContent,
      ).toContain("Git Bash"),
    );
    await user.click(screen.getByRole("button", { name: "Shell" }));
    expect(
      screen
        .getByRole("menu")
        .querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.textContent,
    ).toBe("Git Bash");

    // 再选 cmd：回调最新选择
    await user.click(screen.getByRole("menuitemradio", { name: "cmd" }));
    expect(onSelectShell).toHaveBeenLastCalledWith("cmd");
  });

  it("清单请求失败：不渲染菜单（不摆空壳）", async () => {
    stubShellsResponse({ error: { code: "x", message: "boom" } }, 500);
    const { container } = render(<TerminalShellMenu onSelectShell={vi.fn()} />);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Shell" })).toBeNull(),
    );
    expect(container.textContent).toBe("");
  });

  it("清单为空：这台机器没有 shell，同样不渲染", async () => {
    stubShellsResponse({
      shells: [],
      defaultShell: "auto",
      resolvedShell: "auto",
    });
    render(<TerminalShellMenu onSelectShell={vi.fn()} />);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Shell" })).toBeNull(),
    );
  });
});
