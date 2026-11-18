import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationWorkContextHeader } from "../src/components/workbench/zcode/host/ConversationWorkContextHeader";
import { CANVAS_DOCUMENT_DELETED_EVENT } from "../src/components/workbench/zcode/host/canvasDocumentNavigation";
import {
  ComposerContextHeader,
  ComposerContextProvider,
} from "../src/components/workbench/zcode/v4/composer/ComposerContext";

const api = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: api.json,
}));
vi.mock(
  "../src/components/workbench/zcode/host/media/MediaModelPreferencePopover.js",
  () => ({ MediaModelPreferencePopover: () => null }),
);
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const projectId = "6d19ca8e-f27c-4d25-ae80-a3b196710f48";
const canvasId = "d0df5861-27f2-4d25-8eb7-dbfbbf668226";
const original: protocol.ConversationWorkContext = {
  preset: "design",
  canvasId,
  selectedCanvasElements: [{ id: "selected" }],
  imageGenerationPreference: { mode: "manual", models: ["chosen:model"] },
};
function Draft() {
  const [context, setContext] = useState<
    protocol.ConversationWorkContext | undefined
  >(() => structuredClone(original));
  return (
    <>
      <ComposerContextHeader
        workspacePath="/fixed"
        workspaceIdentity={JSON.stringify([projectId, "/fixed"])}
        {...(context ? { contextOverride: context } : {})}
        onChangeContext={setContext}
      />
      <output>{JSON.stringify(context)}</output>
    </>
  );
}
it("宿主贡献清理被删除的草稿画布引用，保留媒体选择且忽略其他项目删除", async () => {
  api.json.mockResolvedValue({ canvases: [{ id: canvasId, name: "画布" }] });
  const view = render(
    <ComposerContextProvider renderer={ConversationWorkContextHeader}>
      <Draft />
    </ComposerContextProvider>,
  );
  await waitFor(() => expect(api.json).toHaveBeenCalledOnce());
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(CANVAS_DOCUMENT_DELETED_EVENT, {
        detail: { projectId: "another", canvasId },
      }),
    ),
  );
  expect(view.getByRole("button", { name: "移除画布引用" })).toBeTruthy();
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(CANVAS_DOCUMENT_DELETED_EVENT, {
        detail: { projectId, canvasId },
      }),
    ),
  );
  expect(view.queryByRole("button", { name: "移除画布引用" })).toBeNull();
  expect(JSON.parse(view.getByRole("status").textContent ?? "null")).toEqual({
    preset: "design",
    imageGenerationPreference: original.imageGenerationPreference,
  });
});
it("恢复的草稿通过权威文档列表对账，缺失引用不会重新挂回共享输入", async () => {
  api.json.mockResolvedValue({ canvases: [] });
  const view = render(
    <ComposerContextProvider renderer={ConversationWorkContextHeader}>
      <Draft />
    </ComposerContextProvider>,
  );
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "移除画布引用" })).toBeNull(),
  );
  expect(JSON.parse(view.getByRole("status").textContent ?? "null")).toEqual({
    preset: "design",
    imageGenerationPreference: original.imageGenerationPreference,
  });
});
