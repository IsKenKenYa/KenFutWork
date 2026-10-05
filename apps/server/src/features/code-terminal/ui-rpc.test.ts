import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeTerminalService } from "./types.js";
import { codeUiTerminalRpc } from "./ui-rpc.js";

it("原terminal.create返回用户字体及真实source，fallback不返回空占位", async () => {
  const taskId = randomUUID();
  const actor: LocalActor = { instanceId: randomUUID(), accessClientId: null };
  const create = vi.fn(async () => ({
    id: "actual-pty",
    taskId,
    shell: "sh",
    executable: "/bin/sh",
    tty: true,
  }));
  const options = {
    terminals: { create } as unknown as CodeTerminalService,
    actor,
    connectionId: "connection",
    method: "create",
    args: [{ taskId, cols: 80, rows: 24 }],
    subscriber: () => ({ output: async () => {}, exit: async () => {} }),
  };
  expect(
    await codeUiTerminalRpc({
      ...options,
      preferences: {
        terminalFontFamily: "Fira Code",
        terminalInheritSystemProfile: false,
      },
    }),
  ).toMatchObject({
    result: {
      id: "actual-pty",
      shell: "/bin/sh",
      fontFamily: expect.stringContaining("Fira Code"),
      fontFamilySource: "custom",
    },
  });
  expect(
    await codeUiTerminalRpc({
      ...options,
      preferences: { terminalInheritSystemProfile: false },
    }),
  ).toMatchObject({
    result: {
      fontFamily: expect.stringContaining("monospace"),
      fontFamilySource: "fallback",
    },
  });
  expect(create).toHaveBeenCalledWith(actor, "connection", {
    taskId,
    cols: 80,
    rows: 24,
  });
});
