// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../src/components/toast";
import { AccountSection } from "../src/components/workbench/account-section";
import { SubagentsSection } from "../src/components/workbench/subagents-section";

/**
 * 设置里「子智能体」与「账号」两页的信息全部来自真实数据源——
 * 子智能体清单来自 `GET /api/agent/subagents`（与 agent 装配同源），
 * 账号来自 viewer（显示名/邮箱/套餐/额度）。
 *
 * 子智能体是**管理列表**（风格 5）：自定义项可添加、可删除（写工作区设置），
 * 内置声明只展示；与内置撞名/重名的添加就地拒绝（装配不会生效的行不许造出来）。
 */
const fetchSubagents = vi.fn();
const updateWorkspaceSettings = vi.fn();

vi.mock("../src/lib/server-api.js", () => ({
  fetchSubagents: (...args: unknown[]) => fetchSubagents(...args),
  // 钩子/命令等页面都用它写工作区设置（同一文件只能有一个 mock 工厂，所以放一起）
  updateWorkspaceSettings: (...args: unknown[]) =>
    updateWorkspaceSettings(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 驱动「点删除 → onSaved 回写」的受控包装：子智能体页的状态在 modal，单测里用 state 镜像。 */
function renderSubagents(props: {
  subagents: Array<{
    name: string;
    label: string;
    description: string;
    systemPrompt: string;
  }>;
  onSaved: (next: unknown) => void;
}) {
  return render(
    <SubagentsSection
      accessToken="tok"
      subagents={props.subagents}
      onSaved={props.onSaved}
    />,
  );
}

describe("设置 → 子智能体（管理列表）", () => {
  const CATALOG = {
    subagents: [
      {
        name: "video_generate",
        label: "视频生成",
        description: "按描述生成视频。",
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
    custom: [
      {
        name: "translator",
        label: "翻译官",
        description: "把长文翻译成中文。",
        systemPrompt: "You are a translator.",
      },
    ],
  };

  it("列出内置声明、自定义项与分发工具（可删的只有自定义项）", async () => {
    fetchSubagents.mockResolvedValue(CATALOG);
    renderSubagents({ subagents: CATALOG.custom, onSaved: () => {} });

    expect(await screen.findByText("视频生成")).toBeVisible();
    expect(screen.getByText("翻译官")).toBeVisible();
    expect(screen.getByText("子任务分发")).toBeVisible();
    expect(screen.getByText(/工具：generate_video/)).toBeVisible();
    // 自定义项有删除按钮，内置没有
    expect(screen.getByRole("button", { name: "删除 翻译官" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "删除 视频生成" }),
    ).not.toBeInTheDocument();
  });

  it("添加：填表后点添加 → onSaved 收到追加后的整表", async () => {
    fetchSubagents.mockResolvedValue({ ...CATALOG, custom: [] });
    const onSaved = vi.fn(async (next: unknown) => next);
    renderSubagents({ subagents: [], onSaved });

    await userEvent.click(
      await screen.findByRole("button", { name: /添加子智能体/ }),
    );
    await userEvent.type(screen.getByLabelText("子智能体名字"), "reviewer");
    await userEvent.type(screen.getByLabelText("子智能体名称"), "审稿人");
    await userEvent.type(
      screen.getByLabelText("子智能体派活依据"),
      "代码写完后让它评审",
    );
    await userEvent.type(
      screen.getByLabelText("子智能体角色设定"),
      "You are a code reviewer.",
    );
    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith([
        {
          name: "reviewer",
          label: "审稿人",
          description: "代码写完后让它评审",
          systemPrompt: "You are a code reviewer.",
        },
      ]),
    );
  });

  it("与内置撞名：就地拒绝（装配不会生效的行不许造出来）", async () => {
    fetchSubagents.mockResolvedValue(CATALOG);
    const onSaved = vi.fn();
    renderSubagents({ subagents: [], onSaved });

    await userEvent.click(
      await screen.findByRole("button", { name: /添加子智能体/ }),
    );
    await userEvent.type(
      screen.getByLabelText("子智能体名字"),
      "video_generate",
    );
    await userEvent.type(screen.getByLabelText("子智能体名称"), "冒牌货");
    await userEvent.type(screen.getByLabelText("子智能体派活依据"), "x");
    await userEvent.type(screen.getByLabelText("子智能体角色设定"), "y");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByText(/与内置子智能体撞名/)).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("删除：点自定义项的删除 → onSaved 收到剔除后的整表", async () => {
    fetchSubagents.mockResolvedValue(CATALOG);
    const onSaved = vi.fn(async (next: unknown) => next);
    renderSubagents({ subagents: CATALOG.custom, onSaved });

    await userEvent.click(
      await screen.findByRole("button", { name: "删除 翻译官" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([]));
  });

  it("读取失败：原样显示服务端原因", async () => {
    fetchSubagents.mockRejectedValue(new Error("服务端未装配认证。"));
    renderSubagents({ subagents: [], onSaved: () => {} });
    await waitFor(() =>
      expect(screen.getByText("服务端未装配认证。")).toBeVisible(),
    );
  });
});

describe("设置 → 账号", () => {
  it("只列真实字段；未启用计费时写「未启用计费」而不是编数字", () => {
    render(
      <AccountSection
        displayName=""
        email="u@example.com"
        plan={null}
        balance={null}
      />,
    );
    expect(screen.getByText("（未设置）")).toBeVisible();
    expect(screen.getByText("u@example.com")).toBeVisible();
    expect(screen.getAllByText("未启用计费")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "管理后台" })).toBeNull();
  });

  it("管理员才出现「管理后台」，点了走真回调", async () => {
    const onOpenAdmin = vi.fn();
    render(
      <AccountSection
        displayName="未来"
        email="u@example.com"
        plan="pro"
        balance={941}
        isAdmin
        onOpenAdmin={onOpenAdmin}
      />,
    );
    expect(screen.getByText("pro")).toBeVisible();
    expect(screen.getByText("941")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "管理后台" }));
    expect(onOpenAdmin).toHaveBeenCalledTimes(1);
  });
});

/**
 * 「上下文自动压缩」开关（R4-1 输出预留线的执行面）。
 *
 * 锁两件事：① 口径必须写在界面上（阈值 = 窗口 − 预留输出、摘要用本轮模型、转录不变），
 * 用户才知道打开它意味着什么；② 开关**立即写**（部分更新），不是等「保存」按钮。
 */
describe("设置 → 模型：上下文自动压缩开关", () => {
  it("文案写清行为（何时压缩 / 关掉后的后果）", async () => {
    const { AgentSection } = await import("../src/components/agent-section");
    render(
      <AgentSection
        agentMaxRetries={10}
        defaultModel="inst-1:glm-5.3-flash"
        fetchModels={async () => ({ models: [] })}
        onSave={async () => {}}
        autoCompactEnabled
        onToggleAutoCompact={async () => {}}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "上下文自动压缩" }),
    ).toBeChecked();
    expect(screen.getByText(/接近模型上下文上限/)).toBeVisible();
    expect(screen.getByText(/压缩成摘要/)).toBeVisible();
    expect(screen.getByText(/超长对话会被模型拒绝/)).toBeVisible();
  });

  it("关掉时立即回调（部分更新），不依赖「保存」按钮", async () => {
    const { AgentSection } = await import("../src/components/agent-section");
    const onToggleAutoCompact = vi.fn(async () => {});
    render(
      <AgentSection
        agentMaxRetries={10}
        defaultModel="inst-1:glm-5.3-flash"
        fetchModels={async () => ({ models: [] })}
        onSave={async () => {}}
        autoCompactEnabled
        onToggleAutoCompact={onToggleAutoCompact}
      />,
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "上下文自动压缩" }),
    );
    expect(onToggleAutoCompact).toHaveBeenCalledWith(false);
  });
});

/**
 * 插件市场「使用」态（R3-5 参考图：已装插件显示「使用」而不是「安装」）。
 *
 * 锁两条：① 只有**装了、且有真实消费界面**的插件才给「使用」（不在显式表里的不给，
 * 免得点了没反应）；② 点它把插件名交给上层去跳（上层负责打开 MCP/技能/设置对应页）。
 */
/**
 * 市场弹窗**直接用 fetch('/api/plugins')**（不经 server-api 封装），所以这里桩 fetch 而不是桩模块。
 */
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as never;

describe("插件市场：使用态", () => {
  it("已装且有消费界面 → 出现「使用」，点了把插件名交给上层", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plugins: [
          {
            id: "mcp",
            name: "mcp",
            title: "MCP 接入",
            description: "连接 MCP server",
            source: "builtin",
            installed: true,
            enabled: true,
            system: false,
            category: "工具与集成",
          },
        ],
      }),
    });
    const onUse = vi.fn();
    const { PluginMarketModal } = await import(
      "../src/components/workbench/plugin-market-modal"
    );
    render(
      <ToastProvider>
        <PluginMarketModal
          open
          onClose={() => {}}
          accessToken="tok"
          isAdmin
          onUse={onUse}
        />
        ,
      </ToastProvider>,
    );
    const use = await screen.findByRole("button", { name: "使用" });
    await userEvent.click(use);
    expect(onUse).toHaveBeenCalledWith("mcp");
  });

  it("已装但没有消费界面（不在显式表里）→ 不给「使用」", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plugins: [
          {
            id: "local__x",
            name: "some-third-party",
            title: "第三方插件",
            description: "x",
            source: "local",
            installed: true,
            enabled: true,
            system: false,
          },
        ],
      }),
    });
    const { PluginMarketModal } = await import(
      "../src/components/workbench/plugin-market-modal"
    );
    render(
      <ToastProvider>
        <PluginMarketModal
          open
          onClose={() => {}}
          accessToken="tok"
          isAdmin
          onUse={() => {}}
        />
        ,
      </ToastProvider>,
    );
    expect(await screen.findByText("第三方插件")).toBeVisible();
    expect(screen.queryByRole("button", { name: "使用" })).toBeNull();
  });

  it("「导出」按钮不带图标（用户口径：导出不要加图标）", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plugins: [
          {
            id: "local__x",
            name: "some-third-party",
            title: "第三方插件",
            description: "x",
            source: "local",
            installed: true,
            enabled: true,
            system: false,
          },
        ],
      }),
    });
    const { PluginMarketModal } = await import(
      "../src/components/workbench/plugin-market-modal"
    );
    render(
      <ToastProvider>
        <PluginMarketModal
          open
          onClose={() => {}}
          accessToken="tok"
          isAdmin
          onUse={() => {}}
        />
        ,
      </ToastProvider>,
    );
    // 与同排的「卸载」「使用」口径一致：只有文字，不带 ⬇ 之类的图标
    const exportButton = await screen.findByRole("button", { name: "导出" });
    expect(exportButton.querySelector("svg")).toBeNull();
    expect(exportButton.textContent?.trim()).toBe("导出");
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
    updateWorkspaceSettings.mockResolvedValue({
      settings: {
        hooks: [{ event: "turn-end", command: "npx biome check ." }],
      },
    });
    const onSaved = vi.fn();
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection accessToken="tok" hooks={[]} onSaved={onSaved} />);
    expect(screen.getByText("没有钩子")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /新增钩子/ }));
    await userEvent.type(
      screen.getByLabelText("钩子命令 1"),
      "npx biome check .",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存钩子" }));

    expect(updateWorkspaceSettings).toHaveBeenCalledWith("tok", {
      hooks: [{ event: "turn-end", command: "npx biome check ." }],
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("空命令：就地报错，不发请求", async () => {
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection accessToken="tok" hooks={[]} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /新增钩子/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存钩子" }));
    expect(screen.getByText(/还没写命令/)).toBeVisible();
    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  /**
   * 曾经这里断言「三条边界写在页面上」（只有你能配置 / 在工作目录里跑 / 失败不影响本轮）。
   * 2026-09-27 用户口径把界面文案收成「只写标签、不写句子」（见 AGENTS.md「界面文案（硬约束）」），
   * 那三句整体删除；边界本身仍是实现事实（钩子不进工具注册表、按工作目录执行、失败不改本轮状态），
   * 由服务端行为与 docs 承担说明职责，不再由界面复述。
   */
  it("页面只剩标签与控件（无解释句）", async () => {
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection accessToken="tok" hooks={[]} onSaved={() => {}} />);
    expect(screen.getByText("钩子")).toBeVisible();
    expect(screen.getByRole("button", { name: /新增钩子/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "保存钩子" })).toBeVisible();
    // 解释句一律不许回来
    expect(screen.queryByText(/只有你能配置|失败也不影响本轮/)).toBeNull();
  });
});
