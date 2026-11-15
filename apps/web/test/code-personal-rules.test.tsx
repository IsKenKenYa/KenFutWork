import { createServer, type ServerResponse } from "node:http";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PersonalRulesSection } from "@zui/host/PersonalRulesSection.js";
import { setSurfaceApiBase } from "@zui/host/surfaceApi.js";
import {
  personalRulesLimit,
  usePersonalRules,
} from "@zui/host/usePersonalRules.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { createSettingsPageConfig } from "@zui/settings/settingsPageConfig.js";
import { useState } from "react";
import { expect, it } from "vitest";

it("个人指令可以直接从 Agent 能力分区进入", () => {
  const { settingsSectionGroups } = createSettingsPageConfig({});
  const agent = settingsSectionGroups.find(
    ({ id }) => id === "agentCapabilities",
  );
  expect(agent?.sections[0]?.id).toBe("personalRules");
});

function SettingsFixture() {
  const [active, setActive] = useState(true);
  const editor = usePersonalRules(active);
  return (
    <>
      <button type="button" onClick={() => setActive((current) => !current)}>
        切换设置分区
      </button>
      {active && <PersonalRulesSection editor={editor} />}
    </>
  );
}

it("读取现有规则，离开分区后保留失败的草稿，重试只更新个人规则", async () => {
  let receiveFailedWrite!: (response: ServerResponse) => void;
  const failedWrite = new Promise<ServerResponse>((resolve) => {
    receiveFailedWrite = resolve;
  });
  const writes: unknown[] = [];
  function sendSettings(response: ServerResponse, userRules: string) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ settings: { defaultModel: "", userRules } }));
  }
  const server = createServer(async (request, response) => {
    if (request.url !== "/api/instance/settings") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      sendSettings(response, "现有指令");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const patch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    writes.push(patch);
    if (writes.length === 1) {
      receiveFailedWrite(response);
      return;
    }
    sendSettings(response, patch.userRules);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("设置测试监听失败");
    setSurfaceApiBase(`http://127.0.0.1:${address.port}`);
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <SettingsFixture />
      </ZCodeIntlProvider>,
    );
    const editor = await screen.findByDisplayValue("现有指令");
    fireEvent.change(editor, {
      target: { value: "文".repeat(personalRulesLimit + 1) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "请将指令缩短",
    );
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(editor);
    expect(writes).toHaveLength(0);
    fireEvent.change(editor, { target: { value: "保留的草稿" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    const response = await failedWrite;
    fireEvent.click(screen.getByRole("button", { name: "切换设置分区" }));
    response.writeHead(500).end();
    fireEvent.click(screen.getByRole("button", { name: "切换设置分区" }));
    expect(await screen.findByText(/保存失败/)).toBe(screen.getByRole("alert"));
    expect(screen.getByDisplayValue("保留的草稿")).toBe(
      screen.getByRole("textbox", { name: "个人指令" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("已保存")).toBeTruthy();
    expect(writes).toEqual([
      { userRules: "保留的草稿" },
      { userRules: "保留的草稿" },
    ]);
    fireEvent.change(screen.getByRole("textbox", { name: "个人指令" }), {
      target: { value: "不要保存" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
    expect(screen.getByDisplayValue("保留的草稿")).toBe(
      screen.getByRole("textbox", { name: "个人指令" }),
    );
  } finally {
    cleanup();
    setSurfaceApiBase("");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
