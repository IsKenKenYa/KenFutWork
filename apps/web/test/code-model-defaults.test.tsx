import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceProvider } from "@zui/hooks/useServices";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { ModelDefaultsSection } from "../src/components/workbench/zcode/host/ModelDefaultsSection";
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

function openDefaults(fail = false) {
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
            ],
          })),
        },
      });
    }),
  );
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  render(
    <ServiceProvider services={client.services}>
      <ModelDefaultsSection />
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
