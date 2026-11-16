import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@zui/ConfirmDialog.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import {
  type ConfirmDialogRequest,
  useConfirmDialogStore,
} from "@zui/store/confirmDialogStore.js";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  cleanup();
  useConfirmDialogStore.getState().settleChoice("dismiss");
});

function Fixture({ destructive }: { destructive: boolean }) {
  const [choice, setChoice] = useState("尚未选择");
  const request: ConfirmDialogRequest = {
    title: destructive ? "删除记录" : "保存记录",
    description: destructive ? "删除后无法恢复" : "保存当前内容",
    confirmLabel: destructive ? "删除" : "保存",
    confirmVariant: destructive ? "destructive" : "default",
  };
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <button
        type="button"
        onClick={() => {
          setChoice("尚未选择");
          void useConfirmDialogStore
            .getState()
            .requestChoice(request)
            .then(setChoice);
        }}
      >
        打开确认
      </button>
      <output aria-label="选择结果">{choice}</output>
      <ConfirmDialogHost />
    </ZCodeIntlProvider>
  );
}

it("删除确认默认取消，Enter 取消后可重新打开并用 Tab 和 Enter 确认", async () => {
  render(<Fixture destructive />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "打开确认" }));
  const cancel = screen.getByRole("button", { name: /取消/u });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(
    screen.getByRole("button", { name: "删除" }).textContent,
  ).not.toContain("⏎");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByLabelText("选择结果").textContent).toBe("cancel"),
  );
  await user.click(screen.getByRole("button", { name: "打开确认" }));
  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain("取消"),
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "删除" }),
  );
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByLabelText("选择结果").textContent).toBe("confirm"),
  );
});

it("普通确认在取消按钮按 Enter 保留取消含义", async () => {
  render(<Fixture destructive={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "打开确认" }));
  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain("保存"),
  );
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /取消/u }),
  );
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByLabelText("选择结果").textContent).toBe("cancel"),
  );
});

it.each([true, false])(
  "确认框 destructive=%s 在输入法组合时不结算，Escape 可退出",
  async (destructive) => {
    render(<Fixture destructive={destructive} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "打开确认" }));
    fireEvent.keyDown(window, { key: "Enter", isComposing: true });
    expect(screen.getByLabelText("选择结果").textContent).toBe("尚未选择");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByLabelText("选择结果").textContent).toBe("dismiss"),
    );
  },
);
