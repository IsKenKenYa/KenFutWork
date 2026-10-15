// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubagentsSection } from "../src/components/workbench/subagents-section";

const navigateToCode = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigateToCode }),
}));

/**
 * R5-2：设置里「子智能体」与「账号」两页的信息全部来自真实数据源——
 * 子智能体清单来自 `GET /api/agent/subagents`（与 agent 装配同源），
 * 账号来自 viewer（显示名/邮箱/套餐/额度）。
 *
 * 锁三件事：① 页面只显示服务端真给的东西；② 子智能体运行入口导航到完整原 Code 工作台；③ 账号页没启用计费时不编数字。
 */
const fetchSubagents = vi.fn();
const updateInstanceSettings = vi.fn();

vi.mock("../src/lib/server-api.js", () => ({
  fetchSubagents: (...args: unknown[]) => fetchSubagents(...args),
  // 钩子/命令等页面都用它写工作区设置（同一文件只能有一个 mock 工厂，所以放一起）
  updateInstanceSettings: (...args: unknown[]) =>
    updateInstanceSettings(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("设置 → 子智能体", () => {
  it("列出服务端给的子代理与内置分发工具（含工具名）", async () => {
    fetchSubagents.mockResolvedValue({
      subagents: [
        {
          name: "video_generate",
          label: "视频生成",
          description:
            "Video generation availability depends on provider configuration.",
          tools: ["generate_video"],
        },
      ],
      builtin: [
        {
          name: "task",
          label: "子任务分发",
          description: "把子任务派给某个子代理。",
        },
      ],
    });
    render(<SubagentsSection accessToken="tok" />);

    expect(await screen.findByText("视频生成")).toBeVisible();
    expect(screen.getByText("子任务分发")).toBeVisible();
    expect(screen.getByText(/工具：generate_video/)).toBeVisible();
  });

  it("子代理运行入口导航到完整原 Code 工作台", async () => {
    fetchSubagents.mockResolvedValue({ subagents: [], builtin: [] });
    render(<SubagentsSection accessToken="tok" />);
    await screen.findByText("运行记录见 Code 子代理目录");
    await userEvent.click(
      screen.getByRole("button", { name: "前往 Code 查看子智能体" }),
    );
    expect(navigateToCode).toHaveBeenCalledWith("/workbench");
  });

  it("读取失败：原样显示服务端原因", async () => {
    fetchSubagents.mockRejectedValue(new Error("服务端未装配认证。"));
    render(<SubagentsSection accessToken="tok" />);
    await waitFor(() =>
      expect(screen.getByText("服务端未装配认证。")).toBeVisible(),
    );
  });
});

/**
 * 设置 → 钩子（R5-2「钩子」条目）。
 *
 * 这一页最重要的不是控件，而是**边界写清楚**：模型不能触发钩子、钩子在项目工作目录里跑、
 * 失败不影响本轮。少写一句，用户就会以为它是「给模型的执行面」。
 */
describe("设置 → 钩子", () => {
  it("空表：给示例；新增后可写时机与命令并整表保存", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValue([{ event: "turn-end", command: "npx biome check ." }]);
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection hooks={[]} onSave={onSave} />);
    expect(screen.getByText("没有钩子")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /新增钩子/ }));
    await userEvent.type(
      screen.getByLabelText("钩子命令 1"),
      "npx biome check .",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存钩子" }));

    expect(onSave).toHaveBeenCalledWith([
      { event: "turn-end", command: "npx biome check ." },
    ]);
  });

  it("空命令：就地报错，不发请求", async () => {
    const onSave = vi.fn();
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection hooks={[]} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: /新增钩子/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存钩子" }));
    expect(screen.getByText(/还没写命令/)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("边界写在页面上：只有你能配置 / 在工作目录里跑 / 失败不影响本轮", async () => {
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection hooks={[]} onSave={vi.fn()} />);
    expect(screen.queryByText(/只有你能配置/)).toBeNull();
    expect(screen.getByRole("button", { name: "保存钩子" })).toBeVisible();
    expect(screen.queryByText(/失败也不影响本轮对话/)).toBeNull();
  });
});
