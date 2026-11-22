import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceProvider } from "@zui/hooks/useServices";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { ModelDefaultsSection } from "../src/components/workbench/zcode/host/ModelDefaultsSection";
import { PermissionTierSection } from "../src/components/workbench/zcode/host/PermissionTierControl";
import { codeHostNotificationResponse } from "./setup/code-host-http";

const scrollDescriptor = Object.getOwnPropertyDescriptor(
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
  if (scrollDescriptor)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

let client: CodeHttpChannelClient | undefined;
afterEach(async () => {
  cleanup();
  client?.dispose();
  vi.unstubAllGlobals();
});

function openDefaults(fail = false, approvalOnly = false) {
  const ids = [
    "c0a03eb2-d58c-4637-9fda-c796230a751a",
    "722f052b-fd06-458b-a231-e43bce5b6613",
  ];
  const calls: unknown[] = [];
  let defaults = {
    chat: null,
    approval: null,
    image: { mode: "auto" },
    video: { mode: "auto" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/events"))
        return codeHostNotificationResponse(init?.signal);
      const request = JSON.parse(init.body);
      if (request.service !== "providerSettingsService")
        return Response.json({ result: {} });
      if (request.method === "getModelDefaults")
        return Response.json({ result: defaults });
      if (request.method === "saveModelDefaults") {
        calls.push(request.args[0]);
        if (fail) throw new Error("默认模型保存失败，请重试。");
        defaults = request.args[0];
        return Response.json({ result: defaults });
      }
      return Response.json({
        result: {
          revision: 1,
          providerTemplates: [],
          providerOrder: ids,
          providers: ids.map((id, index) => ({
            providerId: id,
            providerName: `网关${index + 1}`,
            enabled: true,
            executable: true,
            effectiveConfig: {},
            personalConfig: {},
            native: {
              id,
              name: `网关${index + 1}`,
              protocol: "openai-compatible",
              scope: "local",
              configRevision: 1,
              enabled: true,
              hasCredential: true,
              headerKeys: [],
              models: [
                { id: "same-model", name: "同名模型", capability: "image" },
                { id: "chat-model", name: "对话模型", capability: "chat" },
                {
                  id: "disabled-chat",
                  name: "停用对话",
                  capability: "chat",
                  enabled: false,
                },
              ],
            },
            models: [
              {
                kind: "candidate",
                modelId: "same-model",
                builtin: false,
                effectiveBuiltinConfig: {},
                personalExactConfig: {},
                effectiveConfig: { enabled: true },
                enabled: true,
                executable: true,
                selectable: false,
                issues: [],
              },
              ...["chat-model", "disabled-chat"].map((modelId) => ({
                kind: "candidate",
                modelId,
                builtin: false,
                effectiveBuiltinConfig: {},
                personalExactConfig: {},
                effectiveConfig: { enabled: modelId !== "disabled-chat" },
                enabled: modelId !== "disabled-chat",
                executable: modelId !== "disabled-chat",
                selectable: modelId !== "disabled-chat",
                issues: [],
              })),
            ],
          })),
        },
      });
    }),
  );
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  render(
    <ServiceProvider services={client.services}>
      {approvalOnly ? <PermissionTierSection /> : <ModelDefaultsSection />}
    </ServiceProvider>,
  );
  return { calls, ids };
}

it("默认图片模型按供应商实例和原生ID保存，保留其他用途的策略", async () => {
  const { calls, ids } = openDefaults();
  const trigger = await screen.findByRole("combobox", { name: "默认图片模型" });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  act(() => trigger.focus());
  await userEvent.keyboard("[Space]");
  await screen.findByRole("option", { name: "网关2 / 同名模型" });
  await userEvent.keyboard("[End][Enter]");
  await waitFor(() =>
    expect(calls).toEqual([
      {
        chat: null,
        approval: null,
        image: {
          mode: "manual",
          models: [{ providerId: ids[1], modelId: "same-model" }],
        },
        video: { mode: "auto" },
      },
    ]),
  );
  expect(
    screen.getByRole("combobox", { name: "默认图片模型" }).textContent,
  ).toContain("网关2");
});

it("权限页只保留基础配置与规则与放行两组，必备项都在", async () => {
  openDefaults(false, true);
  // 用户口径（2026-11-22）：权限页只保留这两个小标题，其余分组全部移除。
  const headings = (await screen.findAllByRole("heading", { level: 3 })).map(
    (node) => node.textContent?.trim(),
  );
  expect(headings).toEqual(["基础配置", "规则与放行"]);

  // 基础配置必备项，以及它们各自的控件。
  expect(screen.getByRole("combobox", { name: "常规任务档位" })).toBeTruthy();
  expect(screen.getByLabelText("沙箱隔离")).toBeTruthy();
  expect(screen.getByLabelText("删除模式")).toBeTruthy();
  expect(screen.getByLabelText("命令执行前审查")).toBeTruthy();
  expect(screen.getByLabelText("自动备份")).toBeTruthy();
  expect(screen.getByLabelText("备份保留上限")).toBeTruthy();

  // 规则与放行：放行策略 + 四组规则入口（点箭头进弹窗编辑）+ 两个网络开关。
  expect(screen.getByLabelText("放行策略")).toBeTruthy();
  for (const label of [
    "编辑工具规则",
    "编辑文件路径规则",
    "编辑命令规则",
    "编辑网络规则",
  ]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  }
  expect(screen.getByLabelText("HTTP 放行")).toBeTruthy();
  expect(screen.getByLabelText("SSL 证书校验")).toBeTruthy();
  // 勾选框全部换成下拉（用户口径）：页面上不应再出现 checkbox。
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

  // 被移除的分组不再出现。
  for (const removed of [
    "自动化任务档位",
    "帮我批准模型",
    "敏感保护",
    "审计中心",
  ]) {
    expect(screen.queryByLabelText(removed)).toBeNull();
  }
});

it("帮我批准独立选择启用对话模型，切回人工审批仍保留对话选择", async () => {
  const { calls, ids } = openDefaults();
  const approval = await screen.findByRole("combobox", {
    name: "帮我批准模型",
  });
  await waitFor(() => expect(approval).toHaveProperty("disabled", false));
  expect(approval.textContent).toContain("人工审批");
  act(() => approval.focus());
  await userEvent.keyboard("[Space]");
  await screen.findByRole("option", { name: "网关2 / 对话模型" });
  expect(screen.queryByRole("option", { name: /同名模型/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /停用对话/ })).toBeNull();
  await userEvent.keyboard("[End][Enter]");
  await waitFor(() =>
    expect(calls).toEqual([
      {
        chat: null,
        approval: { providerId: ids[1], modelId: "chat-model" },
        image: { mode: "auto" },
        video: { mode: "auto" },
      },
    ]),
  );

  const chat = screen.getByRole("combobox", { name: "默认对话模型" });
  await waitFor(() => expect(chat).toHaveProperty("disabled", false));
  act(() => chat.focus());
  await userEvent.keyboard("[Space]");
  await screen.findByRole("option", { name: "网关1 / 对话模型" });
  await userEvent.keyboard("[Home][ArrowDown][Enter]");
  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      chat: { providerId: ids[0], modelId: "chat-model" },
      approval: { providerId: ids[1], modelId: "chat-model" },
      image: { mode: "auto" },
      video: { mode: "auto" },
    }),
  );

  await waitFor(() => expect(approval).toHaveProperty("disabled", false));
  act(() => approval.focus());
  await userEvent.keyboard("[Space]");
  await screen.findByRole("option", { name: "人工审批" });
  await userEvent.keyboard("[Home][Enter]");
  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      chat: { providerId: ids[0], modelId: "chat-model" },
      approval: null,
      image: { mode: "auto" },
      video: { mode: "auto" },
    }),
  );
  expect(approval.textContent).toContain("人工审批");
  expect(chat.textContent).toContain("网关1");
});

it("默认模型写入失败保留原策略并显示错误，重试加载不伪报成功", async () => {
  const { calls } = openDefaults(true);
  const trigger = await screen.findByRole("combobox", { name: "默认图片模型" });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  act(() => trigger.focus());
  await userEvent.keyboard("[Space]");
  await screen.findByRole("option", { name: "网关1 / 同名模型" });
  await userEvent.keyboard("[ArrowDown][Enter]");
  await screen.findByRole("alert");
  expect(trigger.textContent).toContain("自动");
  expect(calls).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(trigger.textContent).toContain("自动");
  await act(async () => client?.dispose());
});
