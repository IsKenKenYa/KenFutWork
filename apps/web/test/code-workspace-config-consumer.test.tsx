import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { useToolbarConfigOptions } from "@zui/hooks/useZCodeConfig";
import { prepareWorkspaceWithZCodeSessionService } from "@zui/hooks/workspacePrepareRpc";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore";
import { V4PaneConversationProvider } from "@zui/v4/V4ConversationContext";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  configProjectIdentity,
  configProjectPath,
  configWorkspace,
  createWorkspaceConfigHttpFixture,
} from "./setup/code-workspace-config-http";

const clients: CodeHttpChannelClient[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useZCodeSessionStore.setState({ workspaces: {} });
});

function ConfigReadout({
  identity = configProjectIdentity,
  label = "",
}: {
  identity?: string;
  label?: string;
} = {}) {
  const workspace = useZCodeSessionStore((state) =>
    state.getWorkspaceState(configProjectPath, identity),
  );
  const task = useToolbarConfigOptions(configProjectPath, "task-A", identity);
  return (
    <>
      <output aria-label={`${label}Project默认模型`}>
        {String(
          workspace.configOptions?.find((option) => option.id === "model")
            ?.currentValue ?? "",
        )}
      </output>
      <output aria-label={`${label}当前Task模型`}>
        {String(
          task.configOptions.find((option) => option.id === "model")
            ?.currentValue ?? "",
        )}
      </output>
      <output aria-label={`${label}工作区命令`}>
        {workspace.slashCommands.map((command) => command.name).join(",")}
      </output>
    </>
  );
}

it("真实原UI在metadata lease消费ACK前配置帧与在线更新，Project默认B变化不覆盖当前Task A且不创建Task", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  releases.push(bindCodeWorkspaceServices(client));
  const store = useZCodeSessionStore.getState();
  store.setActiveTaskId(configProjectPath, "task-A", configProjectIdentity);
  store.setTaskConfigOptions(
    configProjectPath,
    "task-A",
    [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "task-provider/task-A$low",
        options: [],
      },
    ],
    configProjectIdentity,
    "ready",
  );
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/default-B$high",
    ),
  );
  expect(screen.getByLabelText("当前Task模型").textContent).toBe(
    "task-provider/task-A$low",
  );
  expect(screen.getByLabelText("工作区命令").textContent).toBe("inspect");
  fixture.update({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "provider/new-B$low",
        options: [{ value: "provider/new-B", name: "新的默认B" }],
      },
    ],
    slashCommands: [
      { name: "updated", description: "新的真实命令", source: "custom" },
    ],
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/new-B$low",
    ),
  );
  expect(screen.getByLabelText("当前Task模型").textContent).toBe(
    "task-provider/task-A$low",
  );
  expect(screen.getByLabelText("工作区命令").textContent).toBe("updated");
  expect(
    fixture.requests
      .filter((request) => request.method === "subscribeWorkspaceConfigV4")
      .map((request) => request.args[0]),
  ).toEqual([
    expect.objectContaining({
      projectId: configWorkspace.projectId,
      workspacePath: configProjectPath,
      workspaceIdentity: configProjectIdentity,
      runtimePolicy: "existing-only",
    }),
  ]);
  expect(
    fixture.requests.filter((request) =>
      ["createSession", "sendConversationCommandV4", "startRun"].includes(
        request.method,
      ),
    ),
  ).toEqual([]);
  expect(
    store.getWorkspaceState(configProjectPath, configProjectIdentity)
      .activeTaskId,
  ).toBe("task-A");
});

it("原metadata prepare读取完整配置topic而非mode-only种子，返回真实模型与命令且不创建Task", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  const request = {
    workspacePath: configProjectPath,
    workspaceIdentity: configProjectIdentity,
    provider: "glm" as const,
    agentService: client.services.zcodeAgentService,
  };
  const prepared = await prepareWorkspaceWithZCodeSessionService(request);
  expect(
    prepared.configOptions?.find((option) => option.id === "model")
      ?.currentValue,
  ).toBe("provider/default-B$high");
  expect(prepared.slashCommands).toEqual([
    { name: "inspect", description: "真实检查命令", source: "custom" },
  ]);
  expect(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState(configProjectPath, configProjectIdentity).activeTaskId,
  ).toBeNull();
  expect(
    fixture.requests.filter((entry) =>
      ["createSession", "sendConversationCommandV4", "startRun"].includes(
        entry.method,
      ),
    ),
  ).toEqual([]);
});

it("真实通知断线恢复新配置lease，自动显示期间新目录；旧租约迟到帧不能覆写且不重放Task命令", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  releases.push(bindCodeWorkspaceServices(client));
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/default-B$high",
    ),
  );
  const oldId = [...fixture.subscriptions.keys()][0];
  if (!oldId) throw new Error("初始配置租约没有建立。");
  const latePackets = fixture.capture(oldId);
  fixture.disconnect(0);
  fixture.update({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "provider/reconnected-B$low",
        options: [],
      },
    ],
    slashCommands: [
      { name: "after-disconnect", description: "断线期间的新命令" },
    ],
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/reconnected-B$low",
    ),
  );
  expect(screen.getByLabelText("工作区命令").textContent).toBe(
    "after-disconnect",
  );
  for (const packet of latePackets) fixture.send(1, packet);
  await waitFor(() =>
    expect(
      fixture.requests.filter(
        (request) => request.method === "subscribeWorkspaceConfigV4",
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/reconnected-B$low",
  );
  expect([...fixture.subscriptions.keys()]).not.toContain(oldId);
  expect(
    fixture.requests.filter((request) =>
      ["createSession", "sendConversationCommandV4", "startRun"].includes(
        request.method,
      ),
    ),
  ).toEqual([]);
});

it("坏physical配置帧保持旧投影，通过原typed same-sub resync恢复真实最新目录", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  releases.push(bindCodeWorkspaceServices(client));
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/default-B$high",
    ),
  );
  const id = [...fixture.subscriptions.keys()][0];
  if (!id) throw new Error("配置源租约未建立。");
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "provider/recovered-B$low",
        options: [],
      },
    ],
    slashCommands: [{ name: "recovered", description: "恢复后的真实命令" }],
  });
  const packet = fixture.capture(id)[0];
  if (
    !packet ||
    packet.frame.kind !== "complete" ||
    packet.frame.frame.payload.kind !== "snapshot"
  )
    throw new Error("小型坏帧夹具未取得原完整snapshot。");
  fixture.send(0, {
    ...packet,
    frame: {
      ...packet.frame,
      frame: {
        ...packet.frame.frame,
        payload: {
          kind: "snapshot",
          snapshot: {
            ...packet.frame.frame.payload.snapshot,
            config: {
              configOptions: "corrupted-physical-payload",
              slashCommands: [],
            },
          },
        },
      },
    },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/recovered-B$low",
    ),
  );
  expect(screen.getByLabelText("工作区命令").textContent).toBe("recovered");
  expect(
    fixture.requests
      .filter((request) => request.method === "resyncWorkspaceConfigV4")
      .map((request) => request.args[0]?.subscriptionId),
  ).toEqual([id]);
  expect(
    fixture.requests.filter(
      (request) => request.method === "subscribeWorkspaceConfigV4",
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter((request) =>
      ["createSession", "sendConversationCommandV4", "startRun"].includes(
        request.method,
      ),
    ),
  ).toEqual([]);
});

it("多pane同Project共享原lease，同根另一Project以opaque key隔离且释放一个pane不退订余者", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  const secondProjectId = "32000000-0000-4000-8000-000000000032";
  const secondIdentity = JSON.stringify([secondProjectId, configProjectPath]);
  client.registerWorkspaces([
    configWorkspace,
    {
      ...configWorkspace,
      projectId: secondProjectId,
      name: "相同根的第二项目",
    },
  ]);
  releases.push(bindCodeWorkspaceServices(client));
  const tree = (includeFirst: boolean) => (
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <TabStoreProvider>
          {includeFirst && (
            <V4PaneConversationProvider
              scope={{
                workspacePath: configProjectPath,
                workspaceIdentity: configProjectIdentity,
              }}
            >
              <ConfigReadout label="A1" />
            </V4PaneConversationProvider>
          )}
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout label="A2" />
          </V4PaneConversationProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: secondIdentity,
            }}
          >
            <ConfigReadout label="B" identity={secondIdentity} />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
  const view = render(tree(true));
  await waitFor(() =>
    expect(screen.getByLabelText("BProject默认模型").textContent).toBe(
      "provider/default-B$high",
    ),
  );
  expect(
    fixture.requests.filter(
      (request) => request.method === "subscribeWorkspaceConfigV4",
    ),
  ).toHaveLength(2);
  const a = [...fixture.subscriptions.entries()].find(
    ([, subscription]) =>
      subscription.target.workspaceIdentity === configProjectIdentity,
  );
  if (!a) throw new Error("项目A配置lease未建立。");
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/only-A$high",
        options: [],
      },
    ],
    slashCommands: [],
  });
  for (const packet of fixture.capture(a[0])) fixture.send(0, packet);
  await waitFor(() =>
    expect(screen.getByLabelText("A2Project默认模型").textContent).toBe(
      "provider/only-A$high",
    ),
  );
  expect(screen.getByLabelText("A1Project默认模型").textContent).toBe(
    "provider/only-A$high",
  );
  expect(screen.getByLabelText("BProject默认模型").textContent).toBe(
    "provider/default-B$high",
  );
  view.rerender(tree(false));
  expect(screen.queryByLabelText("A1Project默认模型")).toBeNull();
  expect(screen.getByLabelText("A2Project默认模型").textContent).toBe(
    "provider/only-A$high",
  );
  expect(
    fixture.requests.filter(
      (request) => request.method === "unsubscribeWorkspaceConfigV4",
    ),
  ).toEqual([]);
  expect(
    fixture.requests.filter(
      (request) => request.method === "subscribeWorkspaceConfigV4",
    ),
  ).toHaveLength(2);
});

it("最后pane释放后原keep-warm到期精确退订，过期frame不能更新旧桶或相同根的新Project", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  const otherId = "33000000-0000-4000-8000-000000000033";
  const otherIdentity = JSON.stringify([otherId, configProjectPath]);
  client.registerWorkspaces([
    configWorkspace,
    { ...configWorkspace, projectId: otherId },
  ]);
  releases.push(bindCodeWorkspaceServices(client));
  const platform = createCodePlatform(client);
  const tree = (identity: string) => (
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: identity,
            }}
          >
            <ConfigReadout identity={identity} />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
  vi.useFakeTimers();
  const first = render(tree(configProjectIdentity));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/default-B$high",
  );
  const id = [...fixture.subscriptions.keys()][0];
  if (!id) throw new Error("原owned配置租约未建立。");
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/expired-A$high",
        options: [],
      },
    ],
    slashCommands: [],
  });
  const latePackets = fixture.capture(id);
  first.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(
    fixture.requests
      .filter((request) => request.method === "unsubscribeWorkspaceConfigV4")
      .map((request) => request.args[0]),
  ).toEqual([
    expect.objectContaining({
      subscriptionId: id,
      workspaceIdentity: configProjectIdentity,
      projectId: configWorkspace.projectId,
      runtimePolicy: "existing-only",
    }),
  ]);
  expect(fixture.subscriptions.size).toBe(0);
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/project-C$low",
        options: [],
      },
    ],
    slashCommands: [],
  });
  render(tree(otherIdentity));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/project-C$low",
  );
  for (const packet of latePackets) fixture.send(0, packet);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/project-C$low",
  );
  expect(
    useZCodeSessionStore
      .getState()
      .getWorkspaceState(configProjectPath, configProjectIdentity)
      .configOptions?.find((option) => option.id === "model")?.currentValue,
  ).toBe("provider/default-B$high");
});

it("initial ACK仍pending时最后lease到期，迟到ACK只精确退订旧id，不激活或清掉新租约", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  releases.push(bindCodeWorkspaceServices(client));
  const platform = createCodePlatform(client);
  const tree = () => (
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
  vi.useFakeTimers();
  fixture.holdNextSubscribeAck();
  const old = render(tree());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const oldId = [...fixture.subscriptions.keys()][0];
  if (!oldId) throw new Error("在途初订阅没有真实id。");
  expect(screen.getByLabelText("Project默认模型").textContent).toBe("");
  old.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/new-lease$high",
        options: [],
      },
    ],
    slashCommands: [],
  });
  render(tree());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/new-lease$high",
  );
  const newId = [...fixture.subscriptions.keys()].find((id) => id !== oldId);
  if (!newId) throw new Error("新的配置租约未建立。");
  fixture.releaseSubscribeAck(oldId);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByLabelText("Project默认模型").textContent).toBe(
    "provider/new-lease$high",
  );
  expect(
    fixture.requests
      .filter((request) => request.method === "unsubscribeWorkspaceConfigV4")
      .map((request) => request.args[0]?.subscriptionId),
  ).toEqual([oldId]);
  expect(fixture.subscriptions.has(oldId)).toBe(false);
  expect(fixture.subscriptions.has(newId)).toBe(true);
});

it("真实配置源失败透出原错误并保持error，不能把旧缓存或空目录假作prepare成功；显式重读可恢复", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  const store = useZCodeSessionStore.getState();
  store.setConfigOptions(
    configProjectPath,
    [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/old-cache$low",
        options: [],
      },
    ],
    configProjectIdentity,
  );
  fixture.failNextSubscribe("真实目录读取失败，Project数据不可用");
  const request = {
    workspacePath: configProjectPath,
    workspaceIdentity: configProjectIdentity,
    provider: "glm" as const,
    agentService: client.services.zcodeAgentService,
  };
  await expect(
    prepareWorkspaceWithZCodeSessionService(request),
  ).rejects.toThrow("真实目录读取失败");
  const failed = store.getWorkspaceState(
    configProjectPath,
    configProjectIdentity,
  );
  expect(failed.configOptionsStatus).toBe("error");
  expect(
    failed.configOptions?.find((option) => option.id === "model")?.currentValue,
  ).toBe("provider/old-cache$low");
  expect(fixture.subscriptions.size).toBe(0);
  const actual = await prepareWorkspaceWithZCodeSessionService(request);
  expect(
    actual.configOptions?.find((option) => option.id === "model")?.currentValue,
  ).toBe("provider/default-B$high");
  expect(
    store.getWorkspaceState(configProjectPath, configProjectIdentity)
      .configOptionsStatus,
  ).toBe("ready");
  expect(
    fixture.requests.filter((entry) =>
      ["createSession", "sendConversationCommandV4", "startRun"].includes(
        entry.method,
      ),
    ),
  ).toEqual([]);
});

it("新online完整态取代迟到recovery后flight收口，下一坏帧仍能再次same-sub恢复", async () => {
  const fixture = createWorkspaceConfigHttpFixture();
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new CodeHttpChannelClient({
    apiBase: "https://config-host.test",
  });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([configWorkspace]);
  releases.push(bindCodeWorkspaceServices(client));
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <TabStoreProvider>
          <V4PaneConversationProvider
            scope={{
              workspacePath: configProjectPath,
              workspaceIdentity: configProjectIdentity,
            }}
          >
            <ConfigReadout />
          </V4PaneConversationProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/default-B$high",
    ),
  );
  const id = [...fixture.subscriptions.keys()][0];
  if (!id) throw new Error("配置源lease未建立。");
  const corrupt = () => {
    const packet = fixture.capture(id)[0];
    if (
      !packet ||
      packet.frame.kind !== "complete" ||
      packet.frame.frame.payload.kind !== "snapshot"
    )
      throw new Error("坏帧夹具未取得完整态。");
    fixture.send(0, {
      ...packet,
      frame: {
        ...packet.frame,
        frame: {
          ...packet.frame.frame,
          payload: {
            kind: "snapshot",
            snapshot: {
              ...packet.frame.frame.payload.snapshot,
              config: { configOptions: "corrupt", slashCommands: [] },
            },
          },
        },
      },
    });
  };
  fixture.onlineSnapshotReplacesNextRecovery();
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/online-replacement$high",
        options: [],
      },
    ],
    slashCommands: [],
  });
  corrupt();
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/online-replacement$high",
    ),
  );
  fixture.setSource({
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "provider/next-recovery$low",
        options: [],
      },
    ],
    slashCommands: [],
  });
  corrupt();
  await waitFor(() =>
    expect(screen.getByLabelText("Project默认模型").textContent).toBe(
      "provider/next-recovery$low",
    ),
  );
  expect(
    fixture.requests
      .filter((request) => request.method === "resyncWorkspaceConfigV4")
      .map((request) => request.args[0]?.subscriptionId),
  ).toEqual([id, id]);
});
