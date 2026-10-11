import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    metadata: { slug: "native-skill" },
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
                  availablePlugins: [],
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
      <PlatformProvider platform={createCodePlatform(host)}>
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
  await screen.findByRole("heading", { name: "技能", level: 2 });
  await screen.findByRole("button", { name: /native-skill/ });
  const back = screen.getAllByRole("button", { name: "返回工作区" })[0];
  if (!back) throw new Error("原返回工作区入口缺失");
  fireEvent.click(back);
  fireEvent.click(await screen.findByRole("button", { name: /^MCP 服务器$/ }));
  await screen.findByRole("heading", { name: "MCP 服务器", level: 2 });
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
