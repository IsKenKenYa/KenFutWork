import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettingsLink } from "../src/components/model-settings-link";

afterEach(cleanup);
it("历史供应商入口只打开统一设置，不保留JSON模型表单", () => {
  const request = vi.fn();
  const close = vi.fn();
  window.addEventListener("kenfutwork:open-model-settings", request);
  try {
    render(<ModelSettingsLink onOpen={close} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开模型设置" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("kenfutwork:open-model-settings", request);
  }
});
