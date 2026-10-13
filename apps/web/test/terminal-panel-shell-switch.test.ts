import {
  switchTerminalSessionShell,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@zui/terminal/terminalPanelState.js";
import { describe, expect, it } from "vitest";

/**
 * 换 shell = 换会话（G9/Q17）的状态层回归锁：
 * 选择 shell 后原 session descriptor 必须被移除（卸载即 dispose 旧 PTY），
 * 同一 tab 位换成带新 shell 的新 descriptor（挂载即按新 shell create）。
 */
const services = {} as TerminalSessionDescriptor["services"];

function workspaceOf(state: TerminalPanelState) {
  const workspace = state.workspaces.ws;
  if (!workspace) throw new Error("测试状态缺少 ws workspace");
  return workspace;
}

function session(
  overrides: Partial<TerminalSessionDescriptor>,
): TerminalSessionDescriptor {
  return {
    id: "session",
    workspaceKey: "ws",
    services,
    cwd: "D:\\work",
    index: 1,
    shellLabel: null,
    ...overrides,
  };
}

function makePanel(): TerminalPanelState {
  return {
    sessions: {
      "first-id": session({ id: "first-id", index: 1 }),
      "second-id": session({
        id: "second-id",
        index: 2,
        shellLabel: "PowerShell",
      }),
    },
    workspaces: {
      ws: {
        sessionIds: ["first-id", "second-id"],
        activeSessionId: "second-id",
      },
      other: { sessionIds: ["other-1"], activeSessionId: "other-1" },
    },
  };
}

describe("switchTerminalSessionShell（换 shell = 换会话）", () => {
  it("替换活动会话：旧 descriptor 移除，新 descriptor 带新 shell 占同一 tab 位并保持活动", () => {
    const state = makePanel();

    const next = switchTerminalSessionShell(state, "second-id", "git-bash");

    // 旧 session 已移除（卸载即 dispose 旧 PTY）
    expect(next.sessions["second-id"]).toBeUndefined();
    // 同一 tab 位（第二个位置）换成新 descriptor，仍为活动 tab
    const ws = workspaceOf(next);
    expect(ws.sessionIds).toEqual(["first-id", expect.any(String)]);
    expect(ws.activeSessionId).toBe(ws.sessionIds[1]);
    const replacement = next.sessions[ws.sessionIds[1]!];
    expect(replacement).toMatchObject({
      workspaceKey: "ws",
      cwd: "D:\\work",
      index: 2,
      shell: "git-bash",
      shellLabel: null,
    });
    expect(replacement?.id).not.toBe("second-id");
    // 另一个 session 与别的 workspace 不受影响
    expect(next.sessions["first-id"]).toBeDefined();
    expect(next.workspaces.other).toBe(state.workspaces.other);
  });

  it("活动 tab 不是被切换的 tab：只换被选中的那个，活动 tab 不变", () => {
    const state = makePanel();

    const next = switchTerminalSessionShell(state, "first-id", "cmd");

    const ws = workspaceOf(next);
    expect(ws.sessionIds).toEqual([expect.any(String), "second-id"]);
    expect(ws.activeSessionId).toBe("second-id");
    expect(next.sessions[ws.sessionIds[0]!]?.shell).toBe("cmd");
    expect(next.sessions["first-id"]).toBeUndefined();
  });

  it("同一 shell 重复选择：状态不变（无谓的会话重启不开）", () => {
    const state: TerminalPanelState = {
      ...makePanel(),
      sessions: {
        ...makePanel().sessions,
        "second-id": session({ id: "second-id", index: 2, shell: "cmd" }),
      },
    };

    expect(switchTerminalSessionShell(state, "second-id", "cmd")).toBe(state);
  });

  it("未显式选过 shell（undefined）也允许切换：undefined ≠ 任何具体 shell", () => {
    const state = makePanel();

    const next = switchTerminalSessionShell(state, "second-id", "powershell");

    expect(next).not.toBe(state);
    expect(next.sessions["second-id"]).toBeUndefined();
    expect(
      Object.values(next.sessions).find((s) => s.shell === "powershell"),
    ).toBeDefined();
  });

  it("不存在的会话 / 不在 workspace 列表里的会话：状态原样返回", () => {
    const state = makePanel();
    expect(switchTerminalSessionShell(state, "nope", "cmd")).toBe(state);
    // other-1 不在本面板 sessions 里（孤儿 tab id）：同样不动
    expect(switchTerminalSessionShell(state, "other-1", "cmd")).toBe(state);
  });

  it("切换后再换一个 shell：又是一次新会话，历史会话 id 不复活", () => {
    const state = makePanel();

    const once = switchTerminalSessionShell(state, "second-id", "cmd");
    const onceId = workspaceOf(once).activeSessionId ?? "";
    const twice = switchTerminalSessionShell(once, onceId, "powershell");

    expect(twice.sessions[onceId]).toBeUndefined();
    expect(twice.sessions["second-id"]).toBeUndefined();
    expect(workspaceOf(twice).sessionIds).toEqual([
      "first-id",
      expect.any(String),
    ]);
    expect(
      twice.sessions[workspaceOf(twice).activeSessionId ?? ""]?.shell,
    ).toBe("powershell");
  });
});
