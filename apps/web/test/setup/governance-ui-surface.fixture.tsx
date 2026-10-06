import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { expect, vi } from "vitest";
import { CodeWorkbenchFrame } from "../../src/components/workbench/code-workbench-frame";
import { SettingsModal } from "../../src/components/workbench/settings-modal";
import { AGENT_GOVERNANCE_FIELDS } from "../../src/lib/agent-governance-settings";
import {
  LocalInstanceProvider,
  useLocalInstance,
} from "../../src/lib/local-instance-context";
import type { Server } from "./governance-ui-server-client.fixture";
import type { Values } from "./governance-ui-server-types";

export type Surface = "code" | "design";
export const UI_TIMEOUT_MS = 30_000;

// 只替换外部 Next 导航上下文；组件、实例 Provider 与全部 API/业务都是真实实现。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

/** 被动观察真实Provider公共状态；不提供或替换任何业务值。 */
function InstanceProbe() {
  const state = useLocalInstance();
  return (
    <output aria-label="已读取的真实实例">
      {state.instance?.instanceId ?? state.status}
    </output>
  );
}

function DesignEntry() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开 Design 设置
      </button>
      <SettingsModal
        open={open}
        initialTab="agentGovernance"
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export async function mountSurface(surface: Surface, server: Server) {
  render(
    <LocalInstanceProvider>
      <InstanceProbe />
      {surface === "code" ? (
        <CodeWorkbenchFrame onModeChange={() => {}} />
      ) : (
        <DesignEntry />
      )}
    </LocalInstanceProvider>,
  );
  await waitFor(
    () =>
      expect(screen.getByLabelText("已读取的真实实例").textContent).toBe(
        server.instanceId,
      ),
    { timeout: UI_TIMEOUT_MS },
  );
  return {
    async open() {
      fireEvent.click(
        screen.getByRole("button", {
          name: surface === "code" ? "本地实例" : "打开 Design 设置",
        }),
      );
      return screen.findByRole(
        "dialog",
        { name: surface === "code" ? "本地实例设置" : "设置" },
        { timeout: UI_TIMEOUT_MS },
      );
    },
    async close() {
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
        timeout: UI_TIMEOUT_MS,
      });
    },
  };
}

export function governanceInput(
  key: (typeof AGENT_GOVERNANCE_FIELDS)[number]["key"],
) {
  const field = AGENT_GOVERNANCE_FIELDS.find((entry) => entry.key === key);
  if (!field) throw new Error("未知公开治理字段。");
  return screen.getByRole("spinbutton", {
    name: field.label,
  }) as HTMLInputElement;
}

export async function assertDisplayed(values: Values) {
  await waitFor(
    () => {
      for (const field of AGENT_GOVERNANCE_FIELDS)
        expect(governanceInput(field.key).value).toBe(
          String(values[field.key]),
        );
      expect(
        (
          screen.getByRole("switch", {
            name: "模型请求无限重试",
          }) as HTMLInputElement
        ).checked,
      ).toBe(values.llmInfiniteRetry);
    },
    { timeout: UI_TIMEOUT_MS },
  );
}
