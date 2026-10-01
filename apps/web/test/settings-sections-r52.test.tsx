// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../src/components/toast";
import { AccountSection } from "../src/components/workbench/account-section";
import { SubagentsSection } from "../src/components/workbench/subagents-section";
import { onPanelViewRequest } from "../src/lib/panel-open";

/**
 * R5-2：设置里「子智能体」与「账号」两页的信息全部来自真实数据源——
 * 子智能体清单来自 `GET /api/agent/subagents`（与 agent 装配同源），
 * 账号来自 viewer（显示名/邮箱/套餐/额度）。
 *
 * 锁三件事：① 页面只显示服务端真给的东西；② 「打开右栏子智能体」走真通道
 * （有订阅者时转交，没有时**如实说明**而不是假装打开了）；③ 账号页没启用计费时不编数字。
 */
const fetchSubagents = vi.fn();
const updateWorkspaceSettings = vi.fn();

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn(), refresh: vi.fn() }),
}));

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

  it("点「打开右栏子智能体」：有订阅者时转交面板通道", async () => {
    fetchSubagents.mockResolvedValue({ subagents: [], builtin: [] });
    const seen: string[] = [];
    const unsubscribe = onPanelViewRequest((kind) => seen.push(kind));
    render(<SubagentsSection accessToken="tok" />);
    await screen.findByText(/主 Agent 可以把子任务/);

    await userEvent.click(
      screen.getByRole("button", { name: /打开右栏「子智能体」/ }),
    );
    expect(seen).toEqual(["subagents"]);
    unsubscribe();
  });

  it("没有面板在监听（如 Design 模式）：如实说明，不假装打开", async () => {
    fetchSubagents.mockResolvedValue({ subagents: [], builtin: [] });
    render(<SubagentsSection accessToken="tok" />);
    await screen.findByText(/主 Agent 可以把子任务/);

    await userEvent.click(
      screen.getByRole("button", { name: /打开右栏「子智能体」/ }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      /没有右栏面板可打开/,
    );
  });

  it("读取失败：原样显示服务端原因", async () => {
    fetchSubagents.mockRejectedValue(new Error("服务端未装配认证。"));
    render(<SubagentsSection accessToken="tok" />);
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
    expect(screen.getByText(/还没有钩子/)).toBeVisible();

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

  it("边界写在页面上：只有你能配置 / 在工作目录里跑 / 失败不影响本轮", async () => {
    const { HooksSection } = await import(
      "../src/components/workbench/hooks-section"
    );
    render(<HooksSection accessToken="tok" hooks={[]} onSaved={() => {}} />);
    expect(screen.getByText(/只有你能配置/)).toBeVisible();
    expect(screen.getByText(/工作目录/)).toBeVisible();
    expect(screen.getByText(/失败也不影响本轮对话/)).toBeVisible();
  });
});

/**
 * 设置 → 外部应用授权（R5-2「外部应用授权」）。
 *
 * 锁三条：① 明文只显示一次（创建响应里拿到的那个串出现在醒目块里）；② 列表只显示前缀
 * 与最近使用时间（**不显示明文**）；③ 四条红线写在页面上（尤其「令牌不能签发令牌」）。
 */
const fetchApiTokens = vi.fn();
const createApiToken = vi.fn();
const revokeApiToken = vi.fn();
vi.mock("../src/lib/server-api.js", () => ({
  fetchSubagents: (...args: unknown[]) => fetchSubagents(...args),
  updateWorkspaceSettings: (...args: unknown[]) =>
    updateWorkspaceSettings(...args),
  fetchApiTokens: (...args: unknown[]) => fetchApiTokens(...args),
  createApiToken: (...args: unknown[]) => createApiToken(...args),
  revokeApiToken: (...args: unknown[]) => revokeApiToken(...args),
}));

describe("设置 → 外部应用授权", () => {
  it("创建后明文只出现一次，列表只给前缀与最近使用", async () => {
    fetchApiTokens.mockResolvedValue({
      tokens: [
        {
          id: "tok-1",
          name: "CI 部署",
          tokenPrefix: "kfw_abcd1234",
          createdAt: "2026-09-17T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    });
    createApiToken.mockResolvedValue({
      token: "kfw_plaintext_once",
      record: {
        id: "tok-2",
        name: "新令牌",
        tokenPrefix: "kfw_plainte",
        createdAt: "2026-09-17T01:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    });
    const { ApiTokensSection } = await import(
      "../src/components/workbench/api-tokens-section"
    );
    render(<ApiTokensSection accessToken="tok" />);

    // 列表：前缀 + 从未使用（没有明文）
    expect(await screen.findByText(/kfw_abcd1234…/)).toBeVisible();
    expect(screen.queryByText("kfw_plaintext_once")).toBeNull();

    await userEvent.type(screen.getByLabelText("令牌名字"), "新令牌");
    await userEvent.click(screen.getByRole("button", { name: /创建令牌/ }));
    expect(await screen.findByText("kfw_plaintext_once")).toBeVisible();
    expect(screen.getByText(/令牌只显示这一次/)).toBeVisible();
  });

  it("红线写在页面上：只显示一次 / 可吊销 / 需要登录会话", async () => {
    fetchApiTokens.mockResolvedValue({ tokens: [] });
    const { ApiTokensSection } = await import(
      "../src/components/workbench/api-tokens-section"
    );
    render(<ApiTokensSection accessToken="tok" />);
    expect(await screen.findByText(/只显示一次/)).toBeVisible();
    expect(screen.getByText(/可随时吊销/)).toBeVisible();
    expect(screen.getByText(/创建与吊销令牌需要登录会话/)).toBeVisible();
  });
});
