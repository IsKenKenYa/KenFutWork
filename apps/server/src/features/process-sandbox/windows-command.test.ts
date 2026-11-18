import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessLimits, ProcessSpawnRequest } from "./types.js";

type ShellOption = { id: string; label: string; executable: string };

const shell = (id: string, executable: string): ShellOption => ({
  id,
  label: id,
  executable,
});
const gitBash = shell("git-bash", "C:\\Program Files\\Git\\bin\\bash.exe");
const pwsh = shell("pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
const cmd = shell("cmd", "C:\\Windows\\System32\\cmd.exe");

const limits: ProcessLimits = {
  maxOutputBytes: 4096,
  previewMaxChars: 1024,
  yieldMs: 50,
  killGraceMs: 1000,
};

function request(extra: Partial<ProcessSpawnRequest>): ProcessSpawnRequest {
  return {
    scope: {
      instanceId: "workspace",
      projectId: "project",
      taskId: "task",
      generation: 1,
      rootDirectory: "C:\\work",
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    },
    agentId: "main",
    invocationId: "inv-1",
    background: false,
    limits,
    ...extra,
  };
}

/**
 * 每个用例重开模块：默认 shell 是「这台机器上探测一次」的结果，按进程缓存，
 * 不 resetModules 会让后续用例读到前一个用例的缓存。mock 复刻真实实现的
 * 两段语义——先认显式请求的那个 id，再按 auto 顺序 pwsh→powershell→cmd。
 */
async function loadWindowsCommand(
  available: ShellOption[],
  env: Record<string, string> = {},
) {
  vi.resetModules();
  vi.doMock("../code-git/terminal-runner.js", () => ({
    detectTerminalShells: () => available,
    resolveTerminalShell: (requested?: string) =>
      available.find((option) => option.id === requested) ??
      ["pwsh", "powershell", "cmd"]
        .map((id) => available.find((option) => option.id === id))
        .find((option) => option !== undefined) ??
      available[0] ??
      null,
  }));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const { windowsCommand } = await import("./windows-broker.js");
  return windowsCommand;
}

afterEach(() => {
  vi.doUnmock("../code-git/terminal-runner.js");
  delete process.env.ComSpec;
  delete process.env.COMSPEC;
});

describe("windowsCommand 的 shell 选择", () => {
  it("不指定 shell 时按终端 auto 顺序落 pwsh，不再抓 ComSpec 落 cmd", async () => {
    const windowsCommand = await loadWindowsCommand([cmd, pwsh, gitBash], {
      ComSpec: cmd.executable,
    });
    expect(windowsCommand(request({ command: "Get-Date" }))).toEqual([
      pwsh.executable,
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Get-Date",
    ]);
  });

  it("系统里只有 cmd 时才用 cmd（开关形状不变）", async () => {
    const windowsCommand = await loadWindowsCommand([cmd], {
      ComSpec: cmd.executable,
    });
    expect(windowsCommand(request({ command: "dir" }))).toEqual([
      cmd.executable,
      "/d",
      "/s",
      "/c",
      "dir",
    ]);
  });

  it("一个 shell 都没探测到时退回 ComSpec（cmd 开关形状不变）", async () => {
    const windowsCommand = await loadWindowsCommand([], {
      ComSpec: cmd.executable,
    });
    expect(windowsCommand(request({ command: "dir" }))).toEqual([
      cmd.executable,
      "/d",
      "/s",
      "/c",
      "dir",
    ]);
  });

  it("显式 request.shell 优先于本机探测结果（bash 走登录 shell 的 -lc）", async () => {
    const windowsCommand = await loadWindowsCommand([pwsh]);
    expect(
      windowsCommand(
        request({
          command: "ls -1 | grep x",
          shell: gitBash.executable,
        }),
      ),
    ).toEqual([gitBash.executable, "-lc", "ls -1 | grep x"]);
  });

  it("argv 形态不经过 shell 包装", async () => {
    const windowsCommand = await loadWindowsCommand([gitBash]);
    expect(
      windowsCommand(
        request({ argv: { executable: "node.exe", args: ["-v"] } }),
      ),
    ).toEqual(["node.exe", "-v"]);
  });

  it("认不出的 shell 直接报错，不静默换外壳", async () => {
    const windowsCommand = await loadWindowsCommand([gitBash]);
    // 按文案断言而非类身份：resetModules 后 broker 拿到的是新一份 types.js 的类。
    expect(() =>
      windowsCommand(
        request({ command: "whoami", shell: "C:\\tools\\fish.exe" }),
      ),
    ).toThrow(/不支持的 Windows shell/);
  });

  it("没有命令也没有 argv 时报无效请求", async () => {
    const windowsCommand = await loadWindowsCommand([gitBash]);
    expect(() => windowsCommand(request({}))).toThrow(/没有提供命令/);
  });
});
