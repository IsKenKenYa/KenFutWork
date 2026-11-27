import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { setPendingSettingsPluginIntent } from "@zui/lib/settingsNavigation";
import { Root } from "@zui/Root";
import { McpSettingsSection } from "@zui/settings/McpSettingsSection";
import { setMcpStorePlatform } from "@zui/store/mcpStore";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { useLayoutEffect, useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_TASK_SETTINGS_BUTTON,
} from "../../../packages/zcode-shared/dist/index.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { createCodeWorkspaceContextResolver } from "../src/components/workbench/zcode/host/workspaceServiceController";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

let client: CodeHttpChannelClient | undefined;
let release: (() => void) | undefined;
afterEach(() => {
  cleanup();
  release?.();
  client?.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
  restoreCodeRootBrowser();
});

function InstanceMcpPage({ host }: { host: CodeHttpChannelClient }) {
  const platform = useMemo(() => createCodePlatform(host), [host]);
  useLayoutEffect(() => {
    setMcpStorePlatform(platform);
    return () => setMcpStorePlatform(null);
  }, [platform]);
  return (
    <ServiceProvider services={host.services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider>
          <TooltipProvider>
            <McpSettingsSection
              scopeFilter="user"
              parentScopeKey="user"
              workspaceTabs={[]}
              searchQuery=""
            />
          </TooltipProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}

async function openNativeMcpEditor(
  scenario: {
    failSave?: boolean;
    args?: string[];
    deferFirstRead?: boolean;
    skipEdit?: boolean;
    noProject?: boolean;
    unknownSave?: boolean;
    failReload?: boolean;
    envOrigin?: boolean;
    deferSave?: boolean;
    secondRecord?: boolean;
    /** MCP 市场的接口应答与宿主接通状态。 */
    marketplace?: {
      /** 市场读取失败。 */
      registry?: "ok" | "fail";
      add?: "ok" | "duplicate" | "fail";
      /** 宿主没有接通 MCP 市场。 */
      withoutCapability?: boolean;
    };
  } = {},
) {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const fallback = createCodeRootHostFetch(calls, { rejectOpen: false });
  const record = {
    source: "zcodeagentmcp",
    scope: "user",
    name: "native-probe",
    enabled: false,
    origin: scenario.envOrigin ? "env" : "managed",
    hostRecordId: "41000000-0000-4000-8000-000000000001",
    envKeys: ["TOKEN"],
    config: { command: "missing-mcp-command", args: scenario.args ?? [] },
  };
  const secondRecord = {
    ...record,
    name: "second-probe",
    hostRecordId: "41000000-0000-4000-8000-000000000003",
    config: { command: "second-command", args: [] },
  };
  let finishFirstRead: (response: Response) => void = () => {};
  const firstRead = new Promise<Response>((resolve) => {
    finishFirstRead = resolve;
  });
  let finishSave: (response: Response) => void = () => {};
  const pendingSave = new Promise<Response>((resolve) => {
    finishSave = resolve;
  });
  let delayNextInventory = false;
  let finishInventory: () => void = () => {};
  const delayedInventory = new Promise<Response>((resolve) => {
    finishInventory = () =>
      resolve(
        Response.json({
          result: {
            servers: [
              { ...record, config: { ...record.config }, enabled: false },
            ],
          },
        }),
      );
  });
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (scenario.noProject && url.endsWith("/workspaces"))
      return Response.json({ workspaces: [] });
    if (url.endsWith("/api/plugins")) return Response.json({ plugins: [] });
    if (
      url.includes("/api/mcp/claude-marketplace") &&
      !url.includes("/servers")
    ) {
      const params = new URL(url, "https://host.example").searchParams;
      calls.push({
        service: "mcp-marketplace",
        method: "read",
        args: [{ refresh: params.get("refresh") === "1" }],
      });
      if (scenario.marketplace?.registry === "fail")
        return Response.json(
          { error: { code: "mcp_marketplace_failed", message: "读取失败" } },
          { status: 502 },
        );
      return Response.json({
        marketplace: { name: "claude-plugins-official", owner: "Anthropic" },
        state: "ready",
        refreshing: false,
        checked: 3,
        total: 3,
        unreadable: 0,
        completedAt: 1_700_000_000_000,
        message: null,
        servers: [
          {
            id: "notion:notion",
            serverName: "notion",
            suggestedName: "notion",
            plugin: "notion",
            pluginTitle: "Notion",
            description: "Notion 数据库读写。",
            author: null,
            category: "productivity",
            homepage: null,
            kind: "http",
            summary: "https://mcp.notion.com/mcp",
            inputs: [],
            addable: true,
            unsupportedReason: null,
          },
          {
            id: "zoom:zoom-mcp",
            serverName: "zoom-mcp",
            suggestedName: "zoom-mcp",
            plugin: "zoom-plugin",
            pluginTitle: "Zoom",
            description: "Zoom 会议服务。",
            author: null,
            category: null,
            homepage: null,
            kind: "http",
            summary: "https://mcp.zoom.us/mcp/zoom/streamable",
            inputs: [
              {
                name: "ZOOM_ACCESS_TOKEN",
                label: "访问令牌",
                description: "在 Zoom 应用里创建",
                required: true,
                secret: true,
                default: null,
              },
            ],
            addable: true,
            unsupportedReason: null,
          },
          {
            id: "slack:slack",
            serverName: "slack",
            suggestedName: "slack",
            plugin: "slack",
            pluginTitle: "Slack",
            description: "Slack 消息。",
            author: null,
            category: null,
            homepage: null,
            kind: "http",
            summary: "https://mcp.slack.com/mcp",
            inputs: [],
            addable: false,
            unsupportedReason: "要登录授权才能连接",
          },
        ],
      });
    }
    if (
      url.endsWith("/api/mcp/claude-marketplace/servers") &&
      options?.method === "POST"
    ) {
      const body = JSON.parse(String(options.body));
      calls.push({ service: "mcp-marketplace", method: "add", args: [body] });
      if (scenario.marketplace?.add === "duplicate")
        return Response.json(
          {
            error: {
              code: "mcp_server_exists",
              message: "同名 MCP server 已存在。",
            },
          },
          { status: 409 },
        );
      if (scenario.marketplace?.add === "fail")
        return Response.json(
          { error: { code: "mcp_marketplace_failed", message: "添加失败" } },
          { status: 500 },
        );
      return Response.json({ server: { name: body.name } }, { status: 201 });
    }
    if (url.endsWith("/rpc")) {
      const call = JSON.parse(String(options?.body));
      if (call.service === "mcp-sync") {
        calls.push(call);
        if (call.method === "loadMcpFromUserDirectory") {
          if (delayNextInventory) {
            delayNextInventory = false;
            return delayedInventory;
          }
          if (
            scenario.failReload &&
            calls.some((call) => call.method === "saveMcpToUserDirectory")
          )
            return Response.json(
              { error: { message: "列表读取失败" } },
              { status: 503 },
            );
          return Response.json({
            result: {
              servers:
                scenario.deferFirstRead || scenario.secondRecord
                  ? [record, secondRecord]
                  : [record],
            },
          });
        }
        if (call.method === "readMcpServerConfiguration") {
          if (
            scenario.deferFirstRead &&
            call.args[0].hostRecordId === record.hostRecordId
          )
            return firstRead;
          if (call.args[0].hostRecordId === secondRecord.hostRecordId)
            return Response.json({ result: secondRecord });
          return Response.json({
            result: {
              ...record,
              config: { ...record.config, env: { TOKEN: "editor-secret" } },
            },
          });
        }
        if (call.method === "listWorkspaceMcpServerStatuses")
          return Response.json({
            result: {
              statuses: {
                "native-probe": {
                  status: "disconnected",
                  transport: "stdio",
                  toolCount: 0,
                  updatedAt: "2026-10-10T00:00:00Z",
                },
              },
            },
          });
        if (call.method === "saveMcpToUserDirectory") {
          if (call.args[0].hostRecordId !== record.hostRecordId)
            return Response.json(
              { error: { message: "MCP配置已删除，请刷新列表。" } },
              { status: 404 },
            );
          if (call.args[0].action === "set-enabled") {
            record.enabled = call.args[0].enabled;
            return Response.json({ result: null });
          }
          if (scenario.failSave !== false)
            return Response.json(
              { error: { message: "保存失败" } },
              { status: 503 },
            );
          record.config.command = call.args[0].config.command;
          record.config.args = call.args[0].config.args;
          if (scenario.deferSave) return pendingSave;
          if (scenario.unknownSave) throw new TypeError("网络中断");
          return Response.json({ result: null });
        }
      }
      if (call.service === "plugin-management")
        return Response.json({
          result:
            call.method === "listPlugins"
              ? { plugins: [], diagnostics: [] }
              : {
                  marketplaces: [],
                  availablePlugins: [],
                  installedPlugins: [],
                  restorableBuiltins: [],
                  diagnostics: [],
                  capability: { supported: true },
                },
        });
    }
    return fallback(url, options);
  });
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  client.registerWorkspaces(scenario.noProject ? [] : [rootWorkspace]);
  release = bindCodeWorkspaceServices(client);
  const platform = createCodePlatform(client);
  const renderPlatform = scenario.marketplace?.withoutCapability
    ? (Object.fromEntries(
        Object.entries(platform).filter(([key]) => key !== "mcpMarketplace"),
      ) as typeof platform)
    : platform;
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      {scenario.noProject ? (
        <InstanceMcpPage host={client} />
      ) : (
        <Root
          services={client.services}
          platform={renderPlatform}
          initialWorkspaceAbsPath="/code"
          initialWorkspaceIdentity={JSON.stringify([rootProjectId, "/code"])}
          restoreSession={false}
          allowOpenWorkspace={!scenario.noProject}
          allowRemoteWorkspace={false}
          directoryServices={client.directoryServices()}
          onWorkspaceContextChange={createCodeWorkspaceContextResolver(client)}
        />
      )}
    </ZCodeIntlProvider>,
  );
  if (!scenario.noProject) {
    const settings = await screen.findByTestId(TID_TASK_SETTINGS_BUTTON);
    // 插件·MCP·技能已并成一个分区：进 MCP 用页签意图，不再发独立分区 id。
    setPendingSettingsPluginIntent("mcps");
    fireEvent.click(settings);
  }
  await screen.findByText("native-probe", { exact: true });
  if (!scenario.skipEdit) {
    fireEvent.click(screen.getByText("native-probe", { exact: true }));
    await waitFor(() =>
      expect(
        calls
          .filter((call) => call.method === "readMcpServerConfiguration")
          .map((call) => call.args),
      ).toEqual([[{ hostRecordId: record.hostRecordId }]]),
    );
  }
  return {
    calls,
    record,
    finishFirstRead,
    finishSave,
    finishInventory,
    delayInventory: () => {
      delayNextInventory = true;
    },
  };
}

it("原MCP表单按记录ID编辑；保存失败保留草稿并显示错误，不伪装成功", async () => {
  const { calls } = await openNativeMcpEditor();
  const command = await screen.findByPlaceholderText("npx");
  fireEvent.change(command, { target: { value: "draft-command" } });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("保存失败");
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "draft-command",
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toHaveLength(1);
});

it("原表单修改命令不拆碎既有参数，保留Unicode、空参数与授权编辑的env", async () => {
  const { calls, record } = await openNativeMcpEditor({
    failSave: false,
    args: ["中文 带空格", ""],
  });
  fireEvent.change(await screen.findByPlaceholderText("npx"), {
    target: { value: "changed-command" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(1),
  );
  expect(screen.queryByRole("alert")?.textContent).toBeUndefined();
  await waitFor(() => expect(screen.queryByPlaceholderText("npx")).toBeNull());
  expect(
    calls
      .filter((call) => call.method === "saveMcpToUserDirectory")
      .map((call) => call.args),
  ).toEqual([
    [
      {
        action: "upsert",
        source: "zcodeagentmcp",
        name: "native-probe",
        hostRecordId: record.hostRecordId,
        config: {
          type: "stdio",
          command: "changed-command",
          args: ["中文 带空格", ""],
          env: { TOKEN: "editor-secret" },
          enable: false,
        },
      },
    ],
  ]);
});

it("授权表单清空env时显式清除，不将空输入当作保留旧凭据", async () => {
  const { calls } = await openNativeMcpEditor({ failSave: false });
  fireEvent.click(screen.getByRole("button", { name: /环境变量/ }));
  const env = screen.getByPlaceholderText(/MY_API_KEY/);
  fireEvent.change(env, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(1),
  );
  expect(
    calls.find((call) => call.method === "saveMcpToUserDirectory")?.args[0],
  ).toMatchObject({ config: { env: {} } });
});

it("env格式错误保留编辑内容，零请求且不清除已存凭据", async () => {
  const { calls } = await openNativeMcpEditor({ failSave: false });
  fireEvent.click(screen.getByRole("button", { name: /环境变量/ }));
  fireEvent.change(screen.getByPlaceholderText(/MY_API_KEY/), {
    target: { value: "{TOKEN" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "环境变量格式错误",
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toEqual([]);
  expect(
    (screen.getByPlaceholderText(/MY_API_KEY/) as HTMLTextAreaElement).value,
  ).toBe("{TOKEN");
});

it("旧MCP草稿遇到同名重建仍提交旧ID，不能覆盖新记录", async () => {
  const { calls, record } = await openNativeMcpEditor({ failSave: false });
  await screen.findByPlaceholderText("npx");
  const originalId = record.hostRecordId;
  record.hostRecordId = "41000000-0000-4000-8000-000000000002";
  record.config.command = "replacement-command";
  fireEvent.change(screen.getByPlaceholderText("npx"), {
    target: { value: "stale-command" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "MCP配置已删除，请刷新列表。",
  );
  expect(
    calls
      .filter((call) => call.method === "saveMcpToUserDirectory")
      .map((call) => call.args[0]),
  ).toEqual([expect.objectContaining({ hostRecordId: originalId })]);
  expect(record.config.command).toBe("replacement-command");
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "stale-command",
  );
});

it("非法env切换JSON时留在表单并保留草稿", async () => {
  const { calls } = await openNativeMcpEditor({ failSave: false });
  fireEvent.click(screen.getByRole("button", { name: /环境变量/ }));
  fireEvent.change(screen.getByPlaceholderText(/MY_API_KEY/), {
    target: { value: "{TOKEN" },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: /^JSON$/ }), {
    button: 0,
    ctrlKey: false,
  });
  expect((await screen.findByRole("alert")).textContent).toBe(
    "环境变量格式错误",
  );
  expect(
    (screen.getByPlaceholderText(/MY_API_KEY/) as HTMLTextAreaElement).value,
  ).toBe("{TOKEN");
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toEqual([]);
});

it("授权读取A迟到不能覆盖后选的B表单", async () => {
  const { calls, record, finishFirstRead } = await openNativeMcpEditor({
    deferFirstRead: true,
    skipEdit: true,
    failSave: false,
  });
  fireEvent.click(screen.getByText("native-probe", { exact: true }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "readMcpServerConfiguration"),
    ).toHaveLength(1),
  );
  fireEvent.click(screen.getByText("second-probe", { exact: true }));
  await waitFor(() =>
    expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
      "second-command",
    ),
  );
  await act(async () => {
    finishFirstRead(
      Response.json({
        result: { ...record, config: { command: "late-command", args: [] } },
      }),
    );
  });
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "second-command",
  );
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(1),
  );
  expect(
    calls.find((call) => call.method === "saveMcpToUserDirectory")?.args[0],
  ).toMatchObject({ hostRecordId: "41000000-0000-4000-8000-000000000003" });
});

it("未打开Project仍可在原MCP页编辑本机配置并读取状态，零隐式Task", async () => {
  const { calls } = await openNativeMcpEditor({
    noProject: true,
    failSave: false,
  });
  fireEvent.change(await screen.findByPlaceholderText("npx"), {
    target: { value: "instance-command" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() => expect(screen.queryByPlaceholderText("npx")).toBeNull());
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toHaveLength(1);
  expect(
    calls.some((call) => call.method === "listWorkspaceMcpServerStatuses"),
  ).toBe(true);
  expect(
    calls.filter((call) =>
      ["createTask", "ensureConversationWorkspace", "open"].includes(
        call.method,
      ),
    ),
  ).toEqual([]);
});

it("写入响应未知时只读对账，保留草稿且不自动重试", async () => {
  const { calls, record } = await openNativeMcpEditor({
    failSave: false,
    unknownSave: true,
  });
  fireEvent.change(await screen.findByPlaceholderText("npx"), {
    target: { value: "committed-command" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("网络中断");
  const write = calls.findIndex(
    (call) => call.method === "saveMcpToUserDirectory",
  );
  await waitFor(() =>
    expect(
      calls
        .slice(write + 1)
        .filter((call) => call.method === "loadMcpFromUserDirectory"),
    ).toHaveLength(1),
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toHaveLength(1);
  expect(record.config.command).toBe("committed-command");
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "committed-command",
  );
});

it("写入成功但对账失败时保留表单并报告已保存的读取错误", async () => {
  const { calls, record } = await openNativeMcpEditor({
    failSave: false,
    failReload: true,
  });
  fireEvent.change(await screen.findByPlaceholderText("npx"), {
    target: { value: "saved-command" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "MCP已保存，列表读取失败，请刷新列表。",
  );
  expect(record.config.command).toBe("saved-command");
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "saved-command",
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toHaveLength(1);
});

it("原表单未接入的服务参数和项目范围禁用，JSON授权配置不能写入", async () => {
  const { calls } = await openNativeMcpEditor({ failSave: false });
  expect(
    (screen.getByPlaceholderText("30000") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.mouseDown(screen.getByRole("tab", { name: /^JSON$/ }), {
    button: 0,
    ctrlKey: false,
  });
  const json = await screen.findByRole("textbox", { name: "" });
  fireEvent.change(json, {
    target: {
      value: JSON.stringify({
        "native-probe": {
          type: "http",
          url: "https://mcp.invalid",
          oauth: { type: "authorization_code" },
        },
      }),
    },
  });
  expect(
    (screen.getByRole("button", { name: /^保存$/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText("未接入")).toBeTruthy();
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toEqual([]);
});

it("环境来源MCP只读，点击和开关都不发编辑或写入请求", async () => {
  const { calls } = await openNativeMcpEditor({
    envOrigin: true,
    skipEdit: true,
  });
  fireEvent.click(screen.getByText("native-probe", { exact: true }));
  expect(screen.queryByPlaceholderText("npx")).toBeNull();
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect(
    calls.filter((call) =>
      ["readMcpServerConfiguration", "saveMcpToUserDirectory"].includes(
        call.method,
      ),
    ),
  ).toEqual([]);
});

it("旧记录草稿确认删除时固定原ID，刷新后的同名新记录不会被删除", async () => {
  const { calls, record } = await openNativeMcpEditor({ failSave: false });
  await screen.findByPlaceholderText("npx");
  const originalId = record.hostRecordId;
  record.hostRecordId = "41000000-0000-4000-8000-000000000002";
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: /^删除$/ }));
  fireEvent.click(await screen.findByTestId(TID_CONFIRM_DIALOG_CONFIRM));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(2),
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory").at(-1)
      ?.args[0],
  ).toMatchObject({ action: "delete", hostRecordId: originalId });
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "missing-mcp-command",
  );
});

it("写后对账不复用写前延迟库存，不让旧enabled覆盖真实开关", async () => {
  const { calls, record, finishInventory, delayInventory } =
    await openNativeMcpEditor({
      noProject: true,
      skipEdit: true,
      failSave: false,
    });
  delayInventory();
  const before = calls.filter(
    (call) => call.method === "loadMcpFromUserDirectory",
  ).length;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "loadMcpFromUserDirectory"),
    ).toHaveLength(before + 1),
  );
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(1),
  );
  expect(record.enabled).toBe(true);
  await act(async () => {
    finishInventory();
  });
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    ),
  );
  expect(
    calls.filter((call) => call.method === "saveMcpToUserDirectory"),
  ).toHaveLength(1);
});

it("保存A后取消并编辑B，A的迟到写响应不能关闭B草稿", async () => {
  const { calls, finishSave } = await openNativeMcpEditor({
    failSave: false,
    deferSave: true,
    secondRecord: true,
  });
  fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === "saveMcpToUserDirectory"),
    ).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole("button", { name: /^取消$/ }));
  fireEvent.click(await screen.findByText("second-probe", { exact: true }));
  fireEvent.change(await screen.findByPlaceholderText("npx"), {
    target: { value: "B-draft" },
  });
  await act(async () => {
    finishSave(Response.json({ result: null }));
  });
  expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe(
    "B-draft",
  );
});

/** 打开 MCP 页的「添加」下拉，返回当前菜单内容。 */
async function openMcpAddMenu() {
  const trigger = await screen.findByTestId("mcp-add-trigger");
  // Radix 下拉在 jsdom 里用键盘事件打开（fireEvent.click 不触发开菜单）
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter", bubbles: true });
  return screen.findByTestId("mcp-add-menu");
}

it("MCP 页头部出现添加下拉：宿主接通市场时有新建与从市场添加", async () => {
  await openNativeMcpEditor({ skipEdit: true });
  const menu = await openMcpAddMenu();
  expect(within(menu).getByTestId("mcp-add-create").textContent).toContain(
    "新建",
  );
  expect(within(menu).getByTestId("mcp-add-marketplace").textContent).toContain(
    "从市场添加",
  );
});

it("宿主未接通 MCP 市场时菜单只有新建，页头没有外部 Agent 导入入口", async () => {
  await openNativeMcpEditor({
    skipEdit: true,
    marketplace: { withoutCapability: true },
  });
  const menu = await openMcpAddMenu();
  expect(within(menu).getByTestId("mcp-add-create")).toBeTruthy();
  expect(within(menu).queryByTestId("mcp-add-marketplace")).toBeNull();
  // 「从外部 Agent 导入 MCP 服务器」入口已撤掉
  expect(screen.queryByText("从外部 Agent 导入 MCP 服务器")).toBeNull();
});

it("市场对话框列出 Claude 市场的 MCP 服务，带插件名与不可添加原因", async () => {
  await openNativeMcpEditor({ skipEdit: true });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("notion");
  expect(screen.getAllByTestId("mcp-marketplace-item")).toHaveLength(3);
  expect(screen.getByText("Zoom")).toBeTruthy();
  // 不可添加的条目只给原因，不给添加按钮
  const slackRow = screen.getByText("slack").closest("li") as HTMLElement;
  expect(slackRow.textContent).toContain("要登录授权才能连接");
  expect(within(slackRow).queryByRole("button", { name: "添加" })).toBeNull();
});

it("要填变量的条目在填齐前不能添加，填齐后按 id 与填写值添加", async () => {
  const { calls } = await openNativeMcpEditor({ skipEdit: true });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("zoom-mcp");
  const zoomRow = screen.getByText("zoom-mcp").closest("li") as HTMLElement;
  const addButton = within(zoomRow).getByRole("button", { name: "添加" });
  expect((addButton as HTMLButtonElement).disabled).toBe(true);
  // 密钥类变量是密码框：没有 textbox 角色，按 aria-label 定位
  fireEvent.change(
    zoomRow.querySelector('input[aria-label="访问令牌"]') as HTMLInputElement,
    { target: { value: "zoom-token" } },
  );
  expect((addButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(addButton);
  await screen.findByTestId("mcp-marketplace-installed");
  expect(calls.filter((call) => call.service === "mcp-marketplace")).toEqual([
    { service: "mcp-marketplace", method: "read", args: [{ refresh: false }] },
    {
      service: "mcp-marketplace",
      method: "add",
      args: [
        {
          id: "zoom:zoom-mcp",
          name: "zoom-mcp",
          values: { ZOOM_ACCESS_TOKEN: "zoom-token" },
        },
      ],
    },
  ]);
});

it("输入关键词按服务名、插件名与说明筛选", async () => {
  await openNativeMcpEditor({ skipEdit: true });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("notion");
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "zoom" },
  });
  await waitFor(() => {
    expect(screen.getAllByTestId("mcp-marketplace-item")).toHaveLength(1);
  });
  expect(screen.getByText("zoom-mcp")).toBeTruthy();
  expect(screen.queryByText("notion")).toBeNull();
});

it("同名 server 已存在时市场条目显示已添加", async () => {
  await openNativeMcpEditor({
    skipEdit: true,
    marketplace: { add: "duplicate" },
  });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("notion");
  const notionRow = screen.getByText("notion").closest("li") as HTMLElement;
  fireEvent.click(within(notionRow).getByRole("button", { name: "添加" }));
  await waitFor(() => {
    expect(screen.getAllByTestId("mcp-marketplace-installed")).toHaveLength(1);
  });
});

it("添加失败在条目上显示原因，不伪装成功", async () => {
  await openNativeMcpEditor({
    skipEdit: true,
    marketplace: { add: "fail" },
  });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("notion");
  const notionRow = screen.getByText("notion").closest("li") as HTMLElement;
  fireEvent.click(within(notionRow).getByRole("button", { name: "添加" }));
  await screen.findByText("添加失败");
  expect(screen.queryByTestId("mcp-marketplace-installed")).toBeNull();
});

it("市场读取失败时给原因与重试，不显示空列表", async () => {
  await openNativeMcpEditor({
    skipEdit: true,
    marketplace: { registry: "fail" },
  });
  await openMcpAddMenu();
  fireEvent.click(screen.getByTestId("mcp-add-marketplace"));
  await screen.findByText("MCP 市场暂不可用");
  expect(
    screen.getAllByRole("button", { name: "重试" }).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByTestId("mcp-marketplace-item")).toBeNull();
});
