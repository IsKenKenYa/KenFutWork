// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import { ConversationVisualsSection } from "../src/components/workbench/conversation-visuals-section";
import { isConversationVisualsEnabled } from "../src/lib/conversation-visuals";

/**
 * 设置 → 通用 →「对话流」：可视化组件渲染开关（本机偏好）。
 * 锁接线：默认开、点一下写偏好（关）、渲染侧读的是同一份偏好。
 */
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it("默认开；关掉后写本机偏好（渲染侧读同一份）", async () => {
  const user = userEvent.setup();
  render(<ConversationVisualsSection />);

  const toggle = screen.getByRole("switch", { name: "渲染可视化组件" });
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(isConversationVisualsEnabled()).toBe(true);

  await user.click(toggle);

  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(window.localStorage.getItem("kenfutwork.conversationVisuals")).toBe(
    "off",
  );
  expect(isConversationVisualsEnabled()).toBe(false);
});
