import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentsInstructionEditor } from "@zui/settings/AgentsInstructionEditor";
import { afterEach, expect, it, vi } from "vitest";

afterEach(cleanup);

it("加载默认文件、编辑并保存", async () => {
  const load = vi.fn(async () => ({ content: "旧规则" }));
  const save = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <AgentsInstructionEditor
      open
      filePath="C:\\data\\AGENTS.md"
      load={load}
      save={save}
      onClose={onClose}
    />,
  );
  const textarea = (await screen.findByRole("textbox", {
    name: "AGENTS.md",
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe("旧规则"));
  fireEvent.change(textarea, { target: { value: "新规则" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("新规则"));
  expect(onClose).toHaveBeenCalled();
});

it("保存失败时保留编辑内容并显示原因", async () => {
  const onClose = vi.fn();
  render(
    <AgentsInstructionEditor
      open
      filePath="C:\\data\\AGENTS.md"
      load={async () => ({ content: "已有规则" })}
      save={async () => {
        throw new Error("写入失败");
      }}
      onClose={onClose}
    />,
  );
  await screen.findByRole("textbox", { name: "AGENTS.md" });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("写入失败")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
