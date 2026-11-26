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
import { Root } from "@zui/Root";
import { SkillsImportDialog } from "@zui/settings/ExternalAgentImportDialog";
import { SkillsSection } from "@zui/settings/SkillsSection";
import { useSkillStore } from "@zui/store/skillStore";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
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

type CodePlatform = ReturnType<typeof createCodePlatform>;

/** 宿主没接通技能市场的形态：在真实宿主能力的基础上只摘掉这一项。 */
function omitSkillMarketplace(platform: CodePlatform): CodePlatform {
  return Object.fromEntries(
    Object.entries(platform).filter(([key]) => key !== "skillMarketplace"),
  ) as CodePlatform;
}

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

async function openSkillsPage(
  scenario: {
    unknownToggle?: boolean;
    failLoad?: boolean;
    invalidList?: boolean;
    invalidDiagnostic?: boolean;
    importDialog?: boolean;
    root?: boolean;
    workspacePath?: string;
    deferToggle?: boolean;
    pluginSkill?: boolean;
    /** 插件技能所属的插件在市场目录里带有图标。 */
    pluginIcon?: boolean;
    /** 技能记录带市场包名：表示它是此前从技能市场添加的。 */
    recordPackageName?: string;
    /** 宿主没有接通技能市场。 */
    withoutMarketplace?: boolean;
    /** 技能市场接口的应答；传入对象可在用例中途修改，用来测重试。 */
    marketplace?: {
      search?: "ok" | "fail";
      install?: "ok" | "duplicate" | "fail";
      /** 市场里的技能总数，超过一页时出现「加载更多」。 */
      total?: number;
    };
    onCreateTask?: (request?: unknown) => void;
  } = {},
) {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const fallback = createCodeRootHostFetch(calls, { rejectOpen: false });
  let delayNextRead = false;
  let pluginInstalled = true;
  let settleRead: (value: Response) => void = () => {};
  const pendingRead = new Promise<Response>((resolve) => {
    settleRead = resolve;
  });
  let settleToggle: (value: Response) => void = () => {};
  const pendingToggle = new Promise<Response>((resolve) => {
    settleToggle = resolve;
  });
  const record = {
    id: "51000000-0000-4000-8000-000000000001",
    name: "native-skill",
    description: "本机技能",
    installationRevision: "installed-a",
    scope: "user",
    path: "",
    enabled: true,
    resourceRef: "kenfutwork-skill:51000000-0000-4000-8000-000000000001",
    body: "# 技能正文\n\n- Unicode😀\n",
    metadata: {
      slug: "native-skill",
      ...(scenario.recordPackageName
        ? { packageName: scenario.recordPackageName }
        : {}),
    },
  };
  if (scenario.pluginSkill)
    Object.assign(record, {
      id: "kenfutwork-plugin-skill:local__probe/skills%2Finspect%2FSKILL.md",
      scope: "plugin",
      pluginId: "local__probe",
      pluginName: "probe",
      enabled: false,
      resourceRef:
        "kenfutwork-plugin-skill:local__probe/skills%2Finspect%2FSKILL.md",
    });
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/plugins")) return Response.json({ plugins: [] });
    const marketplace = scenario.marketplace ?? {};
    if (url.includes("/api/skills/marketplace/search")) {
      const params = new URL(url, "https://host.example").searchParams;
      const page = Number(params.get("page"));
      const limit = Number(params.get("limit"));
      calls.push({
        service: "skill-marketplace",
        method: "search",
        args: [{ q: params.get("q"), page, limit }],
      });
      if (marketplace.search === "fail")
        return Response.json(
          { error: { code: "marketplace_search_failed", message: "搜索失败" } },
          { status: 502 },
        );
      const total = marketplace.total ?? 2;
      const start = (page - 1) * limit;
      const skills = Array.from(
        { length: Math.max(0, Math.min(limit, total - start)) },
        (_, index) => {
          const ordinal = start + index + 1;
          return {
            packageName: `skill-${ordinal}`,
            name: `skill-${ordinal}`,
            description: `第 ${ordinal} 个技能`,
            author: "tester",
            version: "1.0.0",
            downloads: 10,
            keywords: [],
          };
        },
      );
      return Response.json({ skills, total });
    }
    if (url.endsWith("/api/skills/marketplace/install")) {
      const body = JSON.parse(String(options?.body));
      calls.push({ service: "skill-marketplace", method: "install", args: [body] });
      if (marketplace.install === "fail")
        return Response.json(
          { error: { code: "marketplace_install_failed", message: "下载失败" } },
          { status: 502 },
        );
      if (marketplace.install === "duplicate")
        return Response.json(
          {
            error: {
              code: "marketplace_install_failed",
              message: "This skill is already installed.",
            },
          },
          { status: 409 },
        );
      return Response.json(
        { skill: { id: "new-skill", slug: body.packageName, name: body.packageName } },
        { status: 201 },
      );
    }
    if (url.endsWith("/rpc")) {
      const call = JSON.parse(String(options?.body));
      if (scenario.pluginSkill && call.service === "plugin-management") {
        calls.push(call);
        if (call.method === "uninstallPlugin") {
          pluginInstalled = false;
          return Response.json({ result: null });
        }
        const info = {
          id: "local__probe",
          name: "probe",
          enabled: record.enabled,
          source: "url",
          marketplace: "kenfutwork-local",
          rootPath: "/packages/probe",
          skillRootCount: 1,
          commandRootCount: 0,
          mcpServerNames: [],
          version: "1.0",
        };
        return Response.json({
          result:
            call.method === "listPlugins"
              ? { plugins: pluginInstalled ? [info] : [], diagnostics: [] }
              : {
                  marketplaces: [],
                  availablePlugins:
                    scenario.pluginSkill && scenario.pluginIcon
                      ? [
                          {
                            id: "local__probe",
                            name: "probe",
                            marketplace: "kenfutwork-local",
                            installed: pluginInstalled,
                            listing: {
                              displayName: "Probe",
                              icon: "/api/plugins/local__probe/assets/icon.svg",
                            },
                          },
                        ]
                      : [],
                  installedPlugins: [],
                  restorableBuiltins: [],
                  diagnostics: [],
                },
        });
      }
      if (call.service === "mcp-sync") {
        calls.push(call);
        return Response.json({
          result:
            call.method === "loadMcpFromUserDirectory"
              ? { servers: [] }
              : { statuses: {} },
        });
      }
      if (call.service === "skills") {
        calls.push(call);
        if (call.method === "list") {
          if (scenario.invalidList) return Response.json({ result: [] });
          if (delayNextRead) {
            delayNextRead = false;
            return pendingRead;
          }
          if (scenario.failLoad)
            return Response.json(
              { error: { message: "技能读取失败" } },
              { status: 503 },
            );
          return Response.json({
            result: {
              skills: scenario.pluginSkill && !pluginInstalled ? [] : [record],
              diagnostics: scenario.invalidDiagnostic ? [null] : [],
              capability: {
                userScopeAvailable: true,
                databaseRecords: true,
                workspaceScopeAvailable: false,
                externalImportAvailable: false,
              },
            },
          });
        }
        if (call.method === "setEnabled") {
          record.enabled = call.args[0].enabled;
          if (scenario.unknownToggle) throw new TypeError("网络中断");
          if (scenario.deferToggle) return pendingToggle;
          return Response.json({ result: null });
        }
      }
    }
    return fallback(url, options);
  });
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  client.registerWorkspaces([rootWorkspace]);
  release = bindCodeWorkspaceServices(client);
  const host = client;
  const page = (workspacePath?: string) => (
    <ServiceProvider services={host.services}>
      <PlatformProvider
        platform={
          scenario.withoutMarketplace
            ? omitSkillMarketplace(createCodePlatform(host))
            : createCodePlatform(host)
        }
      >
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TabStoreProvider>
            <TooltipProvider>
              {scenario.root ? (
                <Root
                  services={host.services}
                  platform={createCodePlatform(host)}
                  initialWorkspaceAbsPath="/code"
                  initialWorkspaceIdentity={JSON.stringify([
                    rootProjectId,
                    "/code",
                  ])}
                  restoreSession={false}
                  allowRemoteWorkspace={false}
                />
              ) : scenario.importDialog ? (
                <SkillsImportDialog
                  open
                  workspacePath={null}
                  settingsSyncService={host.services.settingsSyncService}
                  onOpenChange={() => {}}
                  onImported={() => {}}
                />
              ) : (
                <SkillsSection
                  {...(workspacePath ? { workspacePath } : {})}
                  {...(scenario.onCreateTask
                    ? { onCreateTask: scenario.onCreateTask }
                    : {})}
                  scopeFilter="user"
                  searchQuery=""
                />
              )}
            </TooltipProvider>
          </TabStoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
  const view = render(page(scenario.workspacePath));
  return {
    calls,
    record,
    services: host.services,
    delayRead: () => {
      delayNextRead = true;
    },
    settleRead,
    settleToggle,
    changeTarget: (path: string) => view.rerender(page(path)),
  };
}

it("原技能页保留停用插件的只读定义与正文，不展示DB卸载/开关或虚构目录", async () => {
  const { calls, record } = await openSkillsPage({ pluginSkill: true });
  fireEvent.click(await screen.findByRole("button", { name: /native-skill/ }));
  await screen.findByRole("heading", { name: "技能正文" });
  expect(screen.getByText("Unicode😀")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "卸载" })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(record.enabled).toBe(false);
  expect(
    calls
      .filter((call) => call.service === "skills")
      .every((call) => call.method === "list"),
  ).toBe(true);
  await act(async () => {
    await client
      ?.getChannel("plugin-management")
      .call("uninstallPlugin", [{ pluginId: "local__probe" }]);
  });
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "技能正文" })).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: /native-skill/ })).toBeNull();
});

/** 技能行行首的图标位：应统一为技能图标（魔法棒），不出现图片或名字首字母。 */
function expectUnifiedSkillIcon(trigger: HTMLElement) {
  const row = trigger.parentElement;
  expect(row).not.toBeNull();
  expect(row?.querySelector("svg.lucide-wand-sparkles")).not.toBeNull();
  expect(row?.querySelector("img")).toBeNull();
  expect(row?.querySelector("svg text")).toBeNull();
}

it("技能图标统一：插件自带的技能不显示所属插件的图标", async () => {
  await openSkillsPage({ pluginSkill: true, pluginIcon: true });
  expectUnifiedSkillIcon(await screen.findByRole("button", { name: /native-skill/ }));
});

it("技能图标统一：个人技能与插件技能用同一个图标", async () => {
  await openSkillsPage();
  expectUnifiedSkillIcon(await screen.findByRole("button", { name: /native-skill/ }));
});

type Call = { service: string; method: string; args: unknown[] };
const marketplaceCalls = (calls: Call[]) =>
  calls.filter((call) => call.service === "skill-marketplace");
const skillListCalls = (calls: Call[]) =>
  calls.filter((call) => call.service === "skills" && call.method === "list");

/** 打开技能页的「添加」下拉，返回菜单。 */
async function openAddMenu() {
  const trigger = await screen.findByRole("button", { name: "添加" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter", bubbles: true });
  return screen.findByRole("menu");
}

const menuItemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());

/** 打开技能页并从「添加」菜单进入技能市场，返回市场对话框。 */
async function openMarketplace(
  scenario: Parameters<typeof openSkillsPage>[0] = {},
) {
  const opened = await openSkillsPage(scenario);
  await openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "从市场添加" }));
  const dialog = await screen.findByRole("dialog");
  return { ...opened, dialog };
}

it("「添加」下拉依次是导入、从市场添加、使用 agent 创建", async () => {
  await openSkillsPage();
  expect(menuItemNames(await openAddMenu())).toEqual([
    "导入",
    "从市场添加",
    "使用 agent 创建",
  ]);
});

it("「使用 agent 创建」以创造模式创建新任务", async () => {
  const onCreateTask = vi.fn();
  await openSkillsPage({ onCreateTask });
  await openAddMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "使用 agent 创建" }),
  );
  expect(onCreateTask).toHaveBeenCalledWith(
    expect.objectContaining({
      initialPrompt: "创建一个技能：\n",
      executionMode: "creative",
    }),
  );
});

it("宿主未接通技能市场时，下拉里不出现「从市场添加」", async () => {
  await openSkillsPage({ withoutMarketplace: true });
  expect(menuItemNames(await openAddMenu())).toEqual([
    "导入",
    "使用 agent 创建",
  ]);
});

it("「导入」打开导入对话框", async () => {
  await openSkillsPage();
  await openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "导入" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("导入外部 Agent 技能"),
  ).toBeTruthy();
});

it("「从市场添加」打开技能市场：打开即浏览第一页", async () => {
  const { calls, dialog } = await openMarketplace();
  const items = await within(dialog).findAllByTestId(
    "skill-marketplace-item",
  );
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("skill-1");
  expect(items[0]?.textContent).toContain("第 1 个技能");
  expect(marketplaceCalls(calls)).toEqual([
    {
      service: "skill-marketplace",
      method: "search",
      args: [{ q: "", page: 1, limit: 20 }],
    },
  ]);
});

it("输入关键词后等输入停下再按关键词搜索", async () => {
  const { calls, dialog } = await openMarketplace();
  await within(dialog).findAllByTestId("skill-marketplace-item");
  fireEvent.change(within(dialog).getByRole("searchbox"), {
    target: { value: "wri" },
  });
  expect(marketplaceCalls(calls)).toHaveLength(1);
  await waitFor(() =>
    expect(marketplaceCalls(calls).at(-1)?.args[0]).toEqual({
      q: "wri",
      page: 1,
      limit: 20,
    }),
  );
});

it("超过一页时出现「加载更多」，点击后取下一页接在后面", async () => {
  const { calls, dialog } = await openMarketplace({
    marketplace: { total: 25 },
  });
  await within(dialog).findAllByTestId("skill-marketplace-item");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "加载更多" }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getAllByTestId("skill-marketplace-item"),
    ).toHaveLength(25),
  );
  expect(marketplaceCalls(calls).map((call) => call.args[0])).toEqual([
    { q: "", page: 1, limit: 20 },
    { q: "", page: 2, limit: 20 },
  ]);
  expect(
    within(dialog).queryByRole("button", { name: "加载更多" }),
  ).toBeNull();
});

it("市场里点「添加」安装该技能并刷新技能列表，条目变成「已添加」", async () => {
  const { calls, dialog } = await openMarketplace({
    marketplace: { install: "ok" },
  });
  const [item] = await within(dialog).findAllByTestId(
    "skill-marketplace-item",
  );
  if (!item) throw new Error("市场条目未渲染");
  const listsBefore = skillListCalls(calls).length;
  fireEvent.click(within(item).getByRole("button", { name: "添加" }));
  await within(item).findByText("已添加");
  expect(marketplaceCalls(calls)).toContainEqual({
    service: "skill-marketplace",
    method: "install",
    args: [{ packageName: "skill-1" }],
  });
  await waitFor(() =>
    expect(skillListCalls(calls).length).toBe(listsBefore + 1),
  );
  expect(within(item).queryByRole("button")).toBeNull();
});

it("此前从市场添加过的技能直接显示「已添加」", async () => {
  const { dialog } = await openMarketplace({ recordPackageName: "skill-2" });
  const [first, second] = await within(dialog).findAllByTestId(
    "skill-marketplace-item",
  );
  expect(
    within(first as HTMLElement).getByRole("button", { name: "添加" }),
  ).toBeTruthy();
  expect(
    within(second as HTMLElement).getByText("已添加"),
  ).toBeTruthy();
  expect(within(second as HTMLElement).queryByRole("button")).toBeNull();
});

it("重复添加时条目也标成「已添加」，不显示失败", async () => {
  const { dialog } = await openMarketplace({
    marketplace: { install: "duplicate" },
  });
  const [item] = await within(dialog).findAllByTestId(
    "skill-marketplace-item",
  );
  fireEvent.click(
    within(item as HTMLElement).getByRole("button", { name: "添加" }),
  );
  await within(item as HTMLElement).findByText("已添加");
  expect(
    within(item as HTMLElement).queryByText("添加失败"),
  ).toBeNull();
});

it("添加失败时条目显示「添加失败」并保留「添加」按钮", async () => {
  const { dialog } = await openMarketplace({
    marketplace: { install: "fail" },
  });
  const [item] = await within(dialog).findAllByTestId(
    "skill-marketplace-item",
  );
  fireEvent.click(
    within(item as HTMLElement).getByRole("button", { name: "添加" }),
  );
  await within(item as HTMLElement).findByText("添加失败");
  expect(
    within(item as HTMLElement).getByRole("button", { name: "添加" }),
  ).toBeTruthy();
});

it("搜索失败时显示无法访问，点「重试」后重新取到结果", async () => {
  const marketplace = { search: "fail" as "fail" | "ok" };
  const { dialog } = await openMarketplace({ marketplace });
  const retry = await within(dialog).findByRole("button", { name: "重试" });
  expect(within(dialog).getByText("技能市场无法访问")).toBeTruthy();
  marketplace.search = "ok";
  fireEvent.click(retry);
  expect(
    await within(dialog).findAllByTestId("skill-marketplace-item"),
  ).toHaveLength(2);
});

it("市场没有结果时显示「没有找到技能」", async () => {
  const { dialog } = await openMarketplace({ marketplace: { total: 0 } });
  await within(dialog).findByText("没有找到技能");
});

it("翻下一页失败时保留已有结果，点「重试」只补取失败的那一页", async () => {
  const marketplace = { search: "ok" as "ok" | "fail", total: 25 };
  const { calls, dialog } = await openMarketplace({ marketplace });
  const more = await within(dialog).findByRole("button", { name: "加载更多" });
  marketplace.search = "fail";
  fireEvent.click(more);
  const retry = await within(dialog).findByRole("button", { name: "重试" });
  expect(
    within(dialog).getAllByTestId("skill-marketplace-item"),
  ).toHaveLength(20);
  marketplace.search = "ok";
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      within(dialog).getAllByTestId("skill-marketplace-item"),
    ).toHaveLength(25),
  );
  expect(marketplaceCalls(calls).map((call) => call.args[0])).toEqual([
    { q: "", page: 1, limit: 20 },
    { q: "", page: 2, limit: 20 },
    { q: "", page: 2, limit: 20 },
  ]);
});

it("无Project原技能页显示真实本机包，启停写回相同安装记录", async () => {
  const { calls, record } = await openSkillsPage();
  await screen.findByRole("button", { name: /native-skill/ });
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(record.enabled).toBe(false));
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(
    calls
      .filter((call) => call.method === "setEnabled")
      .map((call) => call.args[0]),
  ).toEqual([
    expect.objectContaining({
      skillId: record.id,
      scope: "user",
      enabled: false,
    }),
  ]);
  expect(
    calls.filter((call) =>
      ["createTask", "ensureConversationWorkspace", "open"].includes(
        call.method,
      ),
    ),
  ).toEqual([]);
});

it("本机包详情显示原Markdown正文，不提供假文件路径操作", async () => {
  const { calls } = await openSkillsPage();
  fireEvent.click(await screen.findByRole("button", { name: /native-skill/ }));
  await screen.findByRole("heading", { name: "技能正文" });
  expect(screen.getByText("Unicode😀")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^打开$/ })).toBeNull();
  expect(calls.filter((call) => call.method === "openInFileManager")).toEqual(
    [],
  );
});

it("技能写入响应未知时读回真实状态，不自动重放写入", async () => {
  const { calls } = await openSkillsPage({ unknownToggle: true });
  await screen.findByRole("button", { name: /native-skill/ });
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText("网络中断");
  await waitFor(() =>
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(calls.filter((call) => call.method === "setEnabled")).toHaveLength(1);
});

it("技能读取失败显示错误，不显示尚未安装的假空态", async () => {
  await openSkillsPage({ failLoad: true });
  await screen.findByText("技能读取失败");
  expect(screen.queryByText("尚未安装技能")).toBeNull();
});

it("原外部技能导入页明确未接入，禁止扫描、导入和假空结果", async () => {
  const { calls } = await openSkillsPage({ importDialog: true });
  await screen.findByText("未接入");
  expect(calls.filter((call) => call.service === "settings-sync")).toEqual([]);
  expect(screen.queryByText(/暂无可导入技能/)).toBeNull();
});

it("原Code侧栏提供技能与MCP直达原页，入口不创建新Task", async () => {
  const { calls } = await openSkillsPage({ root: true });
  fireEvent.click(await screen.findByRole("button", { name: /^技能$/ }));
  await screen.findByRole("heading", { name: "插件·MCP·技能", level: 2 });
  await screen.findByRole("button", { name: /native-skill/ });
  const back = screen.getAllByRole("button", { name: "返回工作区" })[0];
  if (!back) throw new Error("原返回工作区入口缺失");
  fireEvent.click(back);
  fireEvent.click(await screen.findByRole("button", { name: /^MCP 服务器$/ }));
  // 侧栏 MCP 入口落到 MCP 分区：空态标题只在 mcps 页签激活时渲染。
  await screen.findByText("尚未安装 MCP 服务器");
  expect(
    calls.filter((call) =>
      ["createTask", "ensureConversationWorkspace"].includes(call.method),
    ),
  ).toEqual([]);
});

it("原共享技能消费接口的写前读取不能复活已停用安装", async () => {
  const { record, services, delayRead, settleRead } = await openSkillsPage();
  await screen.findByRole("button", { name: /native-skill/ });
  const store = useSkillStore.getState();
  await act(async () => {
    await store.initialize("/shared-skill-consumer", services.skillsService);
  });
  delayRead();
  const previous = useSkillStore.getState().refresh(services.skillsService);
  await act(async () => {
    await useSkillStore
      .getState()
      .setEnabled(record.id, false, services.skillsService);
  });
  expect(
    useSkillStore.getState().skills.find((skill) => skill.id === record.id)
      ?.enabled,
  ).toBe(false);
  await act(async () => {
    settleRead(
      Response.json({
        result: {
          skills: [{ ...record, enabled: true }],
          capability: { userScopeAvailable: true, databaseRecords: true },
          diagnostics: [],
        },
      }),
    );
    await previous;
  });
  expect(
    useSkillStore.getState().skills.find((skill) => skill.id === record.id)
      ?.enabled,
  ).toBe(false);
});

it("启停A期间切换目标B，A迟到响应不能把B列表锁在加载状态", async () => {
  const { calls, settleToggle, changeTarget } = await openSkillsPage({
    workspacePath: "/A",
    deferToggle: true,
  });
  await screen.findByRole("button", { name: /native-skill/ });
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(calls.filter((call) => call.method === "setEnabled")).toHaveLength(
      1,
    ),
  );
  changeTarget("/B");
  await screen.findByRole("button", { name: /native-skill/ });
  await act(async () => {
    settleToggle(Response.json({ result: null }));
  });
  expect(screen.getByRole("button", { name: /native-skill/ })).toBeTruthy();
});

async function openSecondSkillHost(
  record: Awaited<ReturnType<typeof openSkillsPage>>["record"],
  pendingList?: Promise<Response>,
) {
  const baseFetch = fetch;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.startsWith("https://second-host.example") && url.endsWith("/rpc")) {
      const call = JSON.parse(String(options?.body));
      if (call.service === "skills" && call.method === "list")
        return (
          pendingList ??
          Response.json({
            result: {
              skills: [
                {
                  ...record,
                  id: "51000000-0000-4000-8000-000000000002",
                  name: "B-skill",
                },
              ],
              capability: { userScopeAvailable: true, databaseRecords: true },
              diagnostics: [],
            },
          })
        );
    }
    return baseFetch(url, options);
  });
  const second = new CodeHttpChannelClient({
    apiBase: "https://second-host.example",
  });
  await second.connect();
  return second;
}

it("共享消费面切到B后，A的迟到启停不能读取B路径和A服务的组合", async () => {
  const { record, services, settleToggle } = await openSkillsPage({
    deferToggle: true,
  });
  await screen.findByRole("button", { name: /native-skill/ });
  const second = await openSecondSkillHost(record);
  try {
    await act(async () => {
      await useSkillStore
        .getState()
        .initialize("/late-A", services.skillsService);
    });
    const write = useSkillStore
      .getState()
      .setEnabled(record.id, false, services.skillsService);
    await act(async () => {
      await useSkillStore
        .getState()
        .initialize("/late-B", second.services.skillsService);
    });
    expect(useSkillStore.getState().skills.map((skill) => skill.name)).toEqual([
      "B-skill",
    ]);
    await act(async () => {
      settleToggle(Response.json({ result: null }));
      await write;
    });
    expect(useSkillStore.getState().skills.map((skill) => skill.name)).toEqual([
      "B-skill",
    ]);
  } finally {
    second.dispose();
  }
});

it("两个宿主的相同目录不共用在飞技能读取", async () => {
  const { record, services, delayRead, settleRead } = await openSkillsPage();
  await screen.findByRole("button", { name: /native-skill/ });
  const second = await openSecondSkillHost(record);
  try {
    delayRead();
    const firstRead = useSkillStore
      .getState()
      .initialize("/same-host-path", services.skillsService);
    const secondRead = useSkillStore
      .getState()
      .initialize("/same-host-path", second.services.skillsService);
    await act(async () => {
      settleRead(
        Response.json({
          result: {
            skills: [record],
            capability: { userScopeAvailable: true },
            diagnostics: [],
          },
        }),
      );
      await Promise.all([firstRead, secondRead]);
    });
    expect(useSkillStore.getState().skills.map((skill) => skill.name)).toEqual([
      "B-skill",
    ]);
  } finally {
    second.dispose();
  }
});

it("切换同路径宿主期间清空旧来源可见候选，等待新宿主读取", async () => {
  const { record, services } = await openSkillsPage();
  await screen.findByRole("button", { name: /native-skill/ });
  let finish: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const second = await openSecondSkillHost(record, pending);
  try {
    await act(async () => {
      await useSkillStore
        .getState()
        .initialize("/same-visible-path", services.skillsService);
    });
    const read = useSkillStore
      .getState()
      .initialize("/same-visible-path", second.services.skillsService);
    const interim = {
      names: useSkillStore.getState().skills.map((skill) => skill.name),
      loading: useSkillStore.getState().loading,
    };
    await act(async () => {
      finish(
        Response.json({
          result: {
            skills: [{ ...record, name: "B-skill" }],
            capability: { userScopeAvailable: true },
            diagnostics: [],
          },
        }),
      );
      await read;
    });
    expect(interim).toEqual({ names: [], loading: true });
    expect(useSkillStore.getState().skills.map((skill) => skill.name)).toEqual([
      "B-skill",
    ]);
  } finally {
    second.dispose();
  }
});

it("原技能接口响应无效时明确失败，不把数组当目录或让整页崩溃", async () => {
  await openSkillsPage({ invalidList: true });
  await screen.findByText("技能目录响应无效，请重新连接。");
  expect(screen.queryByText("尚未安装技能")).toBeNull();
});

it("原技能目录的诊断条目无效时明确失败，保留原页面", async () => {
  await openSkillsPage({ invalidDiagnostic: true });
  await screen.findByText("技能目录响应无效，请重新连接。");
  expect(screen.queryByText("尚未安装技能")).toBeNull();
});
