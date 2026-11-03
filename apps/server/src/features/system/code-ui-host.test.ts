import { describe, expect, it } from "vitest";
import type { TerminalShellOption } from "../code-git/terminal-runner.js";
import type { LocalActor } from "../local-instance/types.js";
import { createCodeUiSystemHost } from "./code-ui-host.js";

const actor = {} as LocalActor;

const cmd: TerminalShellOption = {
  id: "cmd",
  label: "cmd",
  executable: "C:\\Windows\\System32\\cmd.exe",
};
const systemGitBash: TerminalShellOption = {
  id: "git-bash",
  label: "Git Bash",
  executable: "C:\\Program Files\\Git\\bin\\bash.exe",
};
const pathGitBash: TerminalShellOption = {
  id: "git-bash",
  label: "Git Bash",
  executable: "D:\\tools\\Git\\bin\\bash.exe",
};
const powershell: TerminalShellOption = {
  id: "powershell",
  label: "Windows PowerShell",
  executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
};

describe("Code 设置页 system 宿主", () => {
  it("system.info 返回服务端所在机器的家目录与平台", async () => {
    const host = createCodeUiSystemHost({
      platform: "win32",
      resolveHomedir: () => "C:\\Users\\tester",
    });

    await expect(host["system.info"]?.call(actor, [])).resolves.toEqual({
      homedir: "C:\\Users\\tester",
      platform: "win32",
    });
  });

  it("system.listIntegratedTerminalShells 只返回 cmd 与 git-bash，并标出来源", async () => {
    const host = createCodeUiSystemHost({
      platform: "win32",
      detectShells: () => [cmd, powershell, systemGitBash],
    });

    await expect(
      host["system.listIntegratedTerminalShells"]?.call(actor, []),
    ).resolves.toEqual([
      {
        dialect: "cmd",
        id: `cmd:${cmd.executable}`,
        label: "CMD",
        path: cmd.executable,
        source: "system",
      },
      {
        dialect: "git-bash",
        id: `git-bash:${systemGitBash.executable}`,
        label: "Git Bash",
        path: systemGitBash.executable,
        source: "system",
      },
    ]);
  });

  it("PATH 上找到的 Git Bash 标为 path 来源", async () => {
    const host = createCodeUiSystemHost({
      platform: "win32",
      detectShells: () => [pathGitBash],
    });

    await expect(
      host["system.listIntegratedTerminalShells"]?.call(actor, []),
    ).resolves.toEqual([
      {
        dialect: "git-bash",
        id: `git-bash:${pathGitBash.executable}`,
        label: "Git Bash",
        path: pathGitBash.executable,
        source: "path",
      },
    ]);
  });

  it("非 Windows 不提供集成终端 shell 选项", async () => {
    const host = createCodeUiSystemHost({
      platform: "linux",
      detectShells: () => [cmd, systemGitBash],
    });

    await expect(
      host["system.listIntegratedTerminalShells"]?.call(actor, []),
    ).resolves.toEqual([]);
  });
});
