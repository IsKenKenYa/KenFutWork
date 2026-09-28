// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSection } from "../src/components/agent-section";
import { PermissionSection } from "../src/components/permission-section";
import { ProfileSection } from "../src/components/profile-section";
import { ProviderSettings } from "../src/components/provider-settings";
import { BrowserSettingsSection } from "../src/components/workbench/browser-settings-section";
import { TerminalSettingsSection } from "../src/components/workbench/terminal-settings-section";
import { VoiceSettingsSection } from "../src/components/workbench/voice-settings-section";

/**
 * 设置区「能左右就别说上下」的**结构性核对**（用户口径 2026-09-27）。
 *
 * 源码级门禁（`settings-copy-guard.test.ts`）盯的是「不许出现上下排布的形状」；
 * 这一层盯**渲染出来的 DOM**：单行控件必须与它的标签同处一个 `justify-between`
 * 横排容器里、控件是行的最后一个子元素（= 在右），且不铺满整行；档位选择必须横排
 * （grid），不是一行一档；整份设置 HTML 里不许出现 `block text-xs` 的「第二行小字」。
 *
 * jsdom 没有布局引擎，量不了像素——所以这里锁的是**结构**（谁和谁同一行、谁在最后、
 * 控件有没有固定宽度），颜色与像素由真机复核。
 */

function stubApi(overrides: Record<string, unknown> = {}) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes("/api/workspace/settings")) {
        return json({
          settings: { terminalShell: "auto", defaultModel: "", ...overrides },
        });
      }
      if (path.includes("/api/permissions/tier")) {
        return json({
          tier: "default",
          automationTier: "default",
          rules: { allow: [], deny: [] },
          browserControlEnabled: false,
          browserAutoScreenshot: false,
          browserHeadless: false,
          browserDevtoolsReadEnabled: true,
          approvedForever: [],
        });
      }
      if (path.includes("/api/code/shells")) {
        return json({
          shells: [{ id: "cmd", label: "cmd", executable: "cmd.exe" }],
          defaultShell: "auto",
          resolvedShell: "cmd",
        });
      }
      if (path.includes("/api/provider-instances")) {
        return json({ instances: [] });
      }
      if (path.includes("/api/browser/cdp/status")) {
        return json({ cdp: { status: "disconnected" } });
      }
      if (path.includes("/api/voice/settings")) {
        return json({
          settings: {
            mode: "transcribe",
            listen: null,
            think: null,
            speak: null,
            speakReplies: false,
          },
        });
      }
      if (path.includes("/api/voice/models")) return json({ models: [] });
      if (path.includes("/api/voice/diagnose")) return json({ report: null });
      return new Response("not found", { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 控件必须与标签同处一个横排（`justify-between`）行、在行的最右、且不铺满整行。 */
function expectControlRight(
  control: HTMLElement,
  labelText: string,
  options: { fixedWidth?: boolean } = {},
) {
  // 从**父元素**往上找行：Select 触发器自己的 className 里也有 `justify-between`
  // （内部是「值 + 箭头」两端对齐），从控件自身 closest 会命中它自己而不是行。
  const row = control.parentElement?.closest(
    ".justify-between",
  ) as HTMLElement | null;
  expect(row, `「${labelText}」不在标签左/控件右的行里`).not.toBeNull();
  const rowElement = row as HTMLElement;
  expect(rowElement.className).toMatch(/\bflex\b/);
  expect(rowElement.className).toMatch(/items-center/);
  expect(rowElement.className).not.toMatch(/flex-col/);
  // 只数**可见**子元素：Base UI 的 Select 会在触发器后面挂一个 aria-hidden 的播报节点，
  // 它没有宽度、不参与视觉排布，不算「行里的控件」
  const children = Array.from(rowElement.children).filter(
    (child) => child.getAttribute("aria-hidden") !== "true",
  );
  // 控件在行的最后一个位置 = 视觉上的右侧
  expect(children.at(-1)).toBe(control);
  // 它前面确实有这一行的标签（不是「只有控件、没标签」的哑控件）
  const labelSide = children
    .slice(0, -1)
    .map((child) => child.textContent ?? "")
    .join("");
  expect(labelSide).toContain(labelText);
  if (options.fixedWidth !== false) {
    // 有固定宽度（w-64 / w-32 / w-9 …），而不是铺满整行的 w-full
    expect(control.className).toMatch(/\bw-\d/);
    expect(control.className).not.toMatch(/\bw-full\b/);
  }
}

describe("设置区结构：标签在左、控件在右（横排）", () => {
  it("供应商表单：四个单行字段是横排行；两份 JSON 是多行编辑（标签在上，例外）", async () => {
    stubApi();
    const user = userEvent.setup();
    render(<ProviderSettings accessToken="tok" />);
    await screen.findByRole("button", { name: "添加供应商" });
    await user.click(screen.getByRole("button", { name: "添加供应商" }));

    expectControlRight(screen.getByLabelText("实例名称"), "实例名称");
    expectControlRight(screen.getByLabelText("协议"), "协议");
    expectControlRight(screen.getByLabelText("Base URL"), "Base URL");
    expectControlRight(screen.getByLabelText("API Key"), "API Key");

    for (const label of ["模型清单（JSON）", "自定义请求头"]) {
      const editor = screen.getByLabelText(label);
      // 多行编辑器**不挤进**横排行：它按「标签在上、控件铺满」渲染
      expect(editor.closest(".justify-between")).toBeNull();
      const wrapper = editor.parentElement as HTMLElement;
      expect(wrapper.className).toMatch(/space-y-1/);
      expect(wrapper.textContent).toContain(label);
    }
  });

  it("权限页：常规/自动化两组各四档**横排**（grid），不是一行一档的竖排", async () => {
    stubApi();
    render(<PermissionSection accessToken="tok" />);

    for (const name of ["常规任务档位", "自动化任务档位"]) {
      const group = await screen.findByRole("group", { name });
      const grid = group.querySelector("div") as HTMLElement;
      expect(grid.className).toMatch(/\bgrid\b/);
      expect(grid.className).toMatch(/grid-cols-2/);
      expect(grid.className).toMatch(/sm:grid-cols-4/);
      const radios = group.querySelectorAll('input[type="radio"]');
      expect(radios).toHaveLength(4);
      for (const radio of radios) {
        // 每个档位卡是横排（单选钮 + 档名一行），且卡本身在 grid 单元格里
        const card = radio.parentElement as HTMLElement;
        expect(card.className).toMatch(/\bflex\b/);
        expect(card.className).not.toMatch(/flex-col/);
        expect(card.closest('[class*="grid-cols"]')).not.toBeNull();
      }
    }
  });

  it("语音页：模式两项横排（grid-cols-2）", async () => {
    stubApi();
    render(<VoiceSettingsSection accessToken="tok" />);
    const mode = await screen.findByRole("group", { name: "模式" });
    const grid = mode.querySelector("div") as HTMLElement;
    expect(grid.className).toMatch(/grid-cols-2/);
    for (const radio of mode.querySelectorAll('input[type="radio"]')) {
      expect(
        (radio.parentElement as HTMLElement).closest('[class*="grid-cols"]'),
      ).not.toBeNull();
    }
  });

  it("浏览器页：四个开关与两个下拉都在行的最右；行里没有第二行小字", async () => {
    stubApi();
    render(<BrowserSettingsSection accessToken="tok" />);

    for (const name of [
      "允许 AI 控制浏览器",
      "无头浏览器",
      "自动截图",
      "允许 AI 读取开发者工具数据",
    ]) {
      const control = await screen.findByRole("switch", { name });
      expectControlRight(control, name);
    }
    for (const label of ["默认搜索引擎", "AI 任务默认浏览器"]) {
      expectControlRight(screen.getByLabelText(label), label);
    }
    // 用户口径「副标题默认不写」：整份设置 HTML 里不许有 block text-xs 的第二行小字
    expect(document.querySelector(".block.text-xs")).toBeNull();
  });

  it("终端 / 模型 / 个人资料：单行控件固定宽度、右对齐；没有 flex-col 行", async () => {
    stubApi();
    render(<TerminalSettingsSection accessToken="tok" />);
    expectControlRight(
      await screen.findByLabelText("默认 shell"),
      "默认 shell",
    );

    render(
      <AgentSection
        agentMaxRetries={10}
        defaultModel="gpt-4.1"
        autoCompactEnabled
        onToggleAutoCompact={async () => undefined}
        fetchModels={async () => ({
          models: [{ id: "gpt-4.1", name: "GPT 4.1", provider: "openai" }],
        })}
        onSave={async () => undefined}
      />,
    );
    expectControlRight(await screen.findByLabelText("默认模型"), "默认模型");
    expectControlRight(
      screen.getByLabelText("失败自动重试次数"),
      "失败自动重试次数",
    );
    expectControlRight(
      screen.getByRole("switch", { name: "上下文自动压缩" }),
      "上下文自动压缩",
    );

    render(
      <ProfileSection
        displayName="阿远"
        email="a@example.com"
        onSave={async () => undefined}
      />,
    );
    expectControlRight(screen.getByLabelText("显示名称"), "显示名称");
    expectControlRight(screen.getByLabelText("邮箱"), "邮箱");

    // 通栏检查：这一批设置行里没有任何上下排布的容器
    expect(document.querySelectorAll(".justify-between.flex-col")).toHaveLength(
      0,
    );
  });
});
