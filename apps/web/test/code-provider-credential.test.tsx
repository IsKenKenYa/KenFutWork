import type {
  ProviderInstanceModel,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { useModelProviders } from "@zui/hooks/useModelProviders";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import type { ProviderSettingsFormProvider } from "@zui/lib/providerSettingsFormTypes";
import { InlineEditableProviderCard } from "@zui/settings/model-provider-section/InlineEditableProviderCard";
import { ProviderDetailFeedbackBoundary } from "@zui/settings/model-provider-section/ProviderDetailFeedback";
import { useCallback } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
beforeAll(() =>
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  }),
);
afterAll(() => {
  if (scrollIntoViewDescriptor)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function OriginalProviderCard({ collapsed = false }: { collapsed?: boolean }) {
  const operation = useModelProviders({ workspacePath: "/fixture" });
  const save = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await operation.saveProvider(provider);
    },
    [operation.saveProvider],
  );
  const provider = operation.modelProviders[0];
  return provider ? (
    <InlineEditableProviderCard
      provider={provider}
      connectionCollapsed={collapsed}
      onSave={save}
      settingsRevision={operation.providerSettingsView?.revision ?? 0}
      onSetPersonalModelEnabled={operation.setPersonalModelEnabled}
      onDeletePersonalModel={operation.deletePersonalModel}
      onTestModel={operation.testModelConnectivity}
      onReorderModelIds={(ids) =>
        operation.reorderProviderModels(provider.providerId, ids)
      }
    />
  ) : null;
}

function renderOriginalCard(
  beforeSave: () => Promise<void> = async () => {},
  native?: ProviderInstanceResponse,
  collapsed = false,
) {
  const provider = {
    ...(native ? { native } : {}),
    ...(native ? { configRevision: native.configRevision } : {}),
    providerId: native?.id ?? "provider-1",
    providerName: "原供应商",
    enabled: true,
    executable: true,
    credentialConfigured: true,
    effectiveConfig: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://example.invalid/v1",
      },
    },
    personalConfig: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://example.invalid/v1",
      },
    },
    issues: [],
    models:
      native?.models.map((model) => ({
        kind: "candidate",
        modelId: model.id,
        builtin: false,
        effectiveBuiltinConfig: {},
        personalExactConfig: {},
        effectiveConfig: { enabled: model.enabled !== false },
        enabled: model.enabled !== false,
        executable: true,
        selectable: false,
        issues: [],
      })) ?? [],
  };
  const serverView = {
    revision: 1,
    providerTemplates: [],
    providerOrder: ["provider-1"],
    providers: [provider],
  };
  const savedKeys: Array<string | null | undefined> = [];
  const savedOverlays: unknown[] = [];
  const savedModels: unknown[] = [];
  const savedProviders: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, options) => {
      if (String(_input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const request = JSON.parse(options.body);
      if (request.service === "providerSettingsService") {
        if (request.method === "saveManagedProvider") {
          savedProviders.push(request.args[0]);
          if (provider.native) {
            Object.assign(provider.native, request.args[0].patch);
            provider.native.configRevision += 1;
            provider.configRevision = provider.native.configRevision;
            serverView.revision += 1;
          }
        }
        if (request.method === "saveManagedModel") {
          savedModels.push(request.args[0]);
          await beforeSave();
          if (provider.native) {
            const draft = request.args[0];
            const originalId = draft.originalModelId;
            const updated = provider.native.models.filter(
              (entry) => entry.id !== originalId,
            );
            const index = provider.native.models.findIndex(
              (entry) => entry.id === originalId,
            );
            updated.splice(index < 0 ? updated.length : index, 0, draft.model);
            provider.native.models = updated;
            provider.native.configRevision += 1;
            provider.configRevision = provider.native.configRevision;
            provider.models = updated.map((model: ProviderInstanceModel) => ({
              kind: "candidate",
              modelId: model.id,
              builtin: false,
              effectiveBuiltinConfig: {},
              personalExactConfig: {},
              effectiveConfig: { enabled: model.enabled !== false },
              enabled: model.enabled !== false,
              executable: true,
              selectable: false,
              issues: [],
            }));
            serverView.revision += 1;
          }
        }
        if (request.method === "savePersonalProviderOverlay") {
          savedOverlays.push(request.args[1]);
          const key = request.args[1].access?.apiKey;
          savedKeys.push(key);
          await beforeSave();
          if (key !== undefined) provider.credentialConfigured = key !== null;
          provider.executable = provider.credentialConfigured;
          serverView.revision += 1;
        }
        // 外部 HTTP 边界仅返回 presence，绝不返回 Key。
        return new Response(JSON.stringify({ result: serverView }));
      }
      return new Response(JSON.stringify({ result: {} }));
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <ProviderDetailFeedbackBoundary>
              <OriginalProviderCard collapsed={collapsed} />
            </ProviderDetailFeedbackBoundary>
          </TooltipProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  return { client, savedKeys, savedModels, savedProviders, savedOverlays };
}

it("原添加弹窗创建视频模型使用生成用途和打开时的供应商修订", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "视频连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "添加模型" }),
    );
    act(() => screen.getByLabelText("用途").focus());
    await userEvent.keyboard("[Space]");
    await screen.findByRole("option", { name: "视频" });
    await userEvent.keyboard("[ArrowDown][ArrowDown][Enter]");
    expect(screen.queryByLabelText("上下文窗口")).toBeNull();
    await userEvent.type(screen.getByLabelText("模型 ID"), "video/中文");
    await userEvent.type(screen.getByLabelText("名称"), "视频模型");
    await userEvent.type(screen.getByLabelText("时长"), "6,12");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(savedModels).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          expectedRevision: 1,
          model: {
            id: "video/中文",
            name: "视频模型",
            capability: "video",
            videoGeneration: { durations: [6, 12] },
          },
        },
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("生成新增校验显示字段提示，失败保留草稿，重试后列表及修订更新，取消不保存", async () => {
  let attempts = 0;
  const { client, savedModels } = renderOriginalCard(
    async () => {
      if (++attempts === 1) throw new Error("连接失败，请重试。");
    },
    {
      id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
      name: "图像连接",
      scope: "local",
      protocol: "google-image",
      hasCredential: true,
      configRevision: 1,
      enabled: true,
      headerKeys: [],
      models: [],
    },
  );
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "添加模型" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("请填写模型 ID。");
    expect(savedModels).toEqual([]);
    await userEvent.type(screen.getByLabelText("模型 ID"), "image/中文");
    await userEvent.type(screen.getByLabelText("名称"), "图像模型");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("连接失败，请重试。");
    expect(screen.getByLabelText("模型 ID")).toHaveProperty(
      "value",
      "image/中文",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("image/中文");
    await userEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
    await userEvent.type(screen.getByLabelText("名称"), "二");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(savedModels.at(-1)).toEqual({
        providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
        originalModelId: "image/中文",
        expectedRevision: 2,
        model: { id: "image/中文", name: "图像模型二", capability: "image" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "图像模型二");
    await userEvent.type(screen.getByLabelText("名称"), "取消");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(savedModels).toHaveLength(3);
  } finally {
    await act(async () => client.dispose());
  }
});

it("原供应商卡片按真实Flow用途隐藏本机模型编辑，不伪装聊天供应商", async () => {
  const { client } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "Flow连接",
    scope: "local",
    protocol: "dify-engine",
    baseUrl: "https://flow.example.invalid",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [],
  });
  try {
    await screen.findByTestId("model-provider-api-key-input");
    expect(screen.queryByRole("button", { name: "添加模型" })).toBeNull();
    expect(
      screen.getByTestId("model-provider-api-format-trigger").textContent,
    ).toContain("Dify");
  } finally {
    await act(async () => client.dispose());
  }
});

it("原模型行编辑视频用途时展示生成能力，不要求聊天上下文窗口", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "视频连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [
      {
        id: "video",
        name: "视频",
        capability: "video",
        videoGeneration: { durations: [6, 10] },
      },
    ],
  });
  try {
    await screen.findByText("video");
    expect(screen.queryByRole("button", { name: "测试模型" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
    expect(await screen.findByLabelText("时长")).toHaveProperty(
      "value",
      "6,10",
    );
    expect(screen.queryByLabelText("上下文窗口")).toBeNull();
    await userEvent.clear(screen.getByLabelText("时长"));
    await userEvent.type(screen.getByLabelText("时长"), "6,12");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(savedModels).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          originalModelId: "video",
          expectedRevision: 1,
          model: {
            id: "video",
            name: "视频",
            capability: "video",
            videoGeneration: { durations: [6, 12] },
          },
        },
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("生成编辑的下拉菜单用Enter操作不提交模型", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "视频连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [{ id: "video", name: "视频", capability: "video" }],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑模型配置" }),
    );
    act(() => screen.getByLabelText("用途").focus());
    await userEvent.keyboard("[Enter]");
    await screen.findByRole("option", { name: "图像" });
    expect(savedModels).toEqual([]);
    await userEvent.keyboard("[ArrowUp][Enter]");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(savedModels).toEqual([]);
  } finally {
    await act(async () => client.dispose());
  }
});

it("生成参数校验失败保留输入的原文，不把非法数字改成NaN", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "视频连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [
      {
        id: "video",
        name: "视频",
        capability: "video",
        videoGeneration: { durations: [6] },
      },
    ],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑模型配置" }),
    );
    await userEvent.clear(screen.getByLabelText("时长"));
    await userEvent.type(screen.getByLabelText("时长"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("时长需填写正数。");
    expect(screen.getByLabelText("时长")).toHaveProperty("value", "abc");
    expect(savedModels).toEqual([]);
  } finally {
    await act(async () => client.dispose());
  }
});

it("切换生成用途不会把视频时长草稿带入图像模式字段", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "生成连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [
      {
        id: "model",
        name: "模型",
        capability: "video",
        videoGeneration: { durations: [6] },
      },
    ],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑模型配置" }),
    );
    expect(screen.getByLabelText("时长")).toHaveProperty("value", "6");
    act(() => screen.getByLabelText("用途").focus());
    await userEvent.keyboard("[Enter]");
    await screen.findByRole("option", { name: "图像" });
    await userEvent.keyboard("[Home][Enter]");
    expect(await screen.findByLabelText("模式")).toHaveProperty("value", "");
    expect(savedModels).toEqual([]);
  } finally {
    await act(async () => client.dispose());
  }
});

it("生成编辑的Enter提交当前输入，中文候选确认不提交", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "视频连接",
    scope: "local",
    protocol: "metaso",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [
      {
        id: "video",
        name: "视频",
        capability: "video",
        videoGeneration: { durations: [6] },
      },
    ],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑模型配置" }),
    );
    const duration = screen.getByLabelText("时长");
    await userEvent.clear(duration);
    await userEvent.type(duration, "6,12");
    fireEvent.compositionStart(duration);
    fireEvent.keyDown(duration, { key: "Enter", isComposing: true });
    expect(savedModels).toEqual([]);
    fireEvent.compositionEnd(duration);
    await userEvent.keyboard("[Enter]");
    await waitFor(() =>
      expect(savedModels).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          originalModelId: "video",
          expectedRevision: 1,
          model: {
            id: "video",
            name: "视频",
            capability: "video",
            videoGeneration: { durations: [6, 12] },
          },
        },
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("图片能力编辑保存画幅尺寸质量格式及多图上限，不物化未知能力", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "图片连接",
    scope: "local",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 7,
    enabled: true,
    headerKeys: [],
    models: [{ id: "image", name: "图片模型", capability: "image" }],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "编辑模型配置" }),
    );
    await userEvent.type(screen.getByLabelText("画幅"), "1:1,16:9");
    await userEvent.type(screen.getByLabelText("尺寸"), "1024x1024,1536x1024");
    await userEvent.type(screen.getByLabelText("质量"), "auto,high");
    await userEvent.type(screen.getByLabelText("输出格式"), "png,gif");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("输出格式仅支持 png、jpg 或 webp。");
    expect(savedModels).toEqual([]);
    expect(screen.getByLabelText("输出格式")).toHaveProperty(
      "value",
      "png,gif",
    );
    await userEvent.clear(screen.getByLabelText("输出格式"));
    await userEvent.type(screen.getByLabelText("输出格式"), "png,webp");
    await userEvent.type(screen.getByLabelText("单次多图上限"), "4");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(savedModels).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          originalModelId: "image",
          expectedRevision: 7,
          model: {
            id: "image",
            name: "图片模型",
            capability: "image",
            imageGeneration: {
              aspectRatios: ["1:1", "16:9"],
              sizes: ["1024x1024", "1536x1024"],
              qualities: ["auto", "high"],
              outputFormats: ["png", "webp"],
              maxOutputs: 4,
            },
          },
        },
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("同一供应商按用途筛选和搜索模型，清空搜索恢复当前用途", async () => {
  const { client } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "混合网关",
    scope: "local",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 1,
    enabled: true,
    headerKeys: [],
    models: [
      { id: "chat-native", name: "对话模型", capability: "chat" },
      { id: "image-native", name: "图片模型", capability: "image" },
      { id: "video-native", name: "视频模型", capability: "video" },
    ],
  });
  try {
    await userEvent.click(await screen.findByRole("tab", { name: "图片 1" }));
    expect(screen.getByText("image-native")).toBeTruthy();
    expect(screen.queryByText("chat-native")).toBeNull();
    expect(screen.queryByText("video-native")).toBeNull();
    await userEvent.type(
      screen.getByRole("textbox", { name: "搜索模型" }),
      "not-found",
    );
    expect(screen.queryByText("image-native")).toBeNull();
    await userEvent.clear(screen.getByRole("textbox", { name: "搜索模型" }));
    expect(screen.getByText("image-native")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "全部 3" }));
    expect(screen.getByText("chat-native")).toBeTruthy();
    expect(screen.getByText("video-native")).toBeTruthy();
  } finally {
    await act(async () => client.dispose());
  }
});

it("兼容网关新增图片模型可选择用途并走原生保存，不误存聊天参数", async () => {
  const { client, savedModels } = renderOriginalCard(async () => {}, {
    id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
    name: "兼容网关",
    scope: "local",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 3,
    enabled: true,
    headerKeys: [],
    models: [],
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "添加模型" }),
    );
    act(() => screen.getByLabelText("用途").focus());
    await userEvent.keyboard("[Space]");
    await userEvent.click(await screen.findByRole("option", { name: "图像" }));
    expect(screen.queryByLabelText("上下文窗口")).toBeNull();
    await userEvent.type(screen.getByLabelText("模型 ID"), "native-image");
    await userEvent.type(screen.getByLabelText("名称"), "图片模型");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(savedModels).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          expectedRevision: 3,
          model: { id: "native-image", name: "图片模型", capability: "image" },
        },
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("原供应商卡片只显示真实凭证 presence，替换后清本次草稿，明确清除发送 null", async () => {
  const { client, savedKeys } = renderOriginalCard();
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    expect(input).toHaveProperty("value", "");
    expect(
      screen.getByRole("button", { name: "清除已保存的 API Key" }),
    ).toHaveProperty("disabled", false);
    await userEvent.type(input, "replacement-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys).toContain("replacement-private-key"));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    await userEvent.click(
      screen.getByRole("button", { name: "清除已保存的 API Key" }),
    );
    await waitFor(() => expect(savedKeys.at(-1)).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "清除已保存的 API Key" }),
      ).toBeNull(),
    );
    expect(input).toHaveProperty("value", "");
  } finally {
    client.dispose();
  }
});

it("原供应商的迟到保存成功不能清掉继续输入的新 Key，新草稿仅在自己的应答后清除", async () => {
  const pending: Array<() => void> = [];
  const { client, savedKeys } = renderOriginalCard(
    () => new Promise<void>((resolve) => pending.push(resolve)),
  );
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    await userEvent.type(input, "first-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys[0]).toBe("first-private-key"));
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "newer-private-key");
    await act(async () => {
      pending[0]?.();
    });
    expect(input).toHaveProperty("value", "newer-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys.at(-1)).toBe("newer-private-key"));
    await act(async () => {
      pending.at(-1)?.();
    });
    await waitFor(() => expect(input).toHaveProperty("value", ""));
  } finally {
    for (const resolve of pending) resolve();
    client.dispose();
  }
});

it("原供应商保存失败保留 Key 草稿，原重试操作成功后才清除", async () => {
  let attempt = 0;
  const { client, savedKeys } = renderOriginalCard(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("外部服务暂时失败");
  });
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    await userEvent.type(input, "retry-private-key");
    await userEvent.tab();
    await screen.findByRole("alert");
    expect(input).toHaveProperty("value", "retry-private-key");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    expect(savedKeys).toEqual(["retry-private-key", "retry-private-key"]);
  } finally {
    client.dispose();
  }
});

it("Code供应商卡可从标准协议切换到GRSAI并保留修订及未提交请求头草稿", async () => {
  const { client, savedProviders, savedOverlays } = renderOriginalCard(
    async () => {},
    {
      id: "c0a03eb2-d58c-4637-9fda-c796230a751a",
      name: "图片网关",
      scope: "local",
      protocol: "openai-compatible",
      hasCredential: true,
      configRevision: 1,
      enabled: true,
      headerKeys: [],
      models: [],
    },
    true,
  );
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "连接设置" }),
    );
    await userEvent.click(screen.getByText("高级配置"));
    fireEvent.change(screen.getByLabelText("自定义请求头"), {
      target: { value: '{"x-route":"{{sessionId}}"}' },
    });
    const trigger = await screen.findByTestId(
      "model-provider-api-format-trigger",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await userEvent.click(await screen.findByRole("option", { name: "GRSAI" }));
    await waitFor(() =>
      expect(savedProviders).toEqual([
        {
          providerId: "c0a03eb2-d58c-4637-9fda-c796230a751a",
          patch: { protocol: "grsai", expectedRevision: 1 },
        },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("model-provider-api-format-trigger").textContent,
      ).toContain("GRSAI"),
    );
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() =>
      expect(savedOverlays).toEqual([
        expect.objectContaining({
          api: expect.objectContaining({
            headers: { "x-route": "{{sessionId}}" },
          }),
        }),
      ]),
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("连接弹窗等待失焦保存完成，失败保留弹窗及当前输入", async () => {
  let rejectSave: (reason: Error) => void = () => {};
  const pendingSave = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  const { client, savedKeys } = renderOriginalCard(
    () => pendingSave,
    undefined,
    true,
  );
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "连接设置" }),
    );
    const input = screen.getByTestId("model-provider-base-url-input");
    await userEvent.clear(input);
    await userEvent.type(input, "https://new.example.invalid");
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(savedKeys.length).toBe(1));
    expect(screen.getByRole("dialog", { name: "连接设置" })).toBeTruthy();
    await act(async () => rejectSave(new Error("连接保存失败，请重试。")));
    const dialog = screen.getByRole("dialog", { name: "连接设置" });
    await within(dialog).findByRole("alert");
    expect(screen.getByTestId("model-provider-base-url-input")).toHaveProperty(
      "value",
      "https://new.example.invalid",
    );
  } finally {
    await act(async () => client.dispose());
  }
});

it("统一连接设置保留自定义头编辑，非法JSON不保存且不丢输入", async () => {
  const { client, savedOverlays } = renderOriginalCard(
    async () => {},
    undefined,
    true,
  );
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "连接设置" }),
    );
    await userEvent.click(screen.getByText("高级配置"));
    const input = screen.getByLabelText("自定义请求头");
    fireEvent.change(input, { target: { value: "not-json" } });
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(input).toHaveProperty("value", "not-json");
    expect(savedOverlays).toEqual([]);
    fireEvent.change(input, {
      target: { value: '{"authorization":"fixture"}' },
    });
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(savedOverlays).toEqual([]);
    fireEvent.change(input, {
      target: { value: '{"x-route":"{{sessionId}}"}' },
    });
    await userEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() =>
      expect(savedOverlays).toEqual([
        expect.objectContaining({
          api: expect.objectContaining({
            headers: { "x-route": "{{sessionId}}" },
          }),
        }),
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    await act(async () => client.dispose());
  }
});
