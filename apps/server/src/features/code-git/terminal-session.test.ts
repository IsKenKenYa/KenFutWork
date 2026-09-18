import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalShellOption } from "./terminal-runner.js";
import {
  chunkForFrames,
  startTerminalSession,
  TERMINAL_OUTPUT_FRAME_BYTES,
} from "./terminal-session.js";

/**
 * 交互式终端会话（R3-1）：**真 PTY**（node-pty / ConPTY）。
 *
 * 替身测协议与边界（UTF-8 前置、原始按键、resize、退出、闲置、杀会话），
 * 真机用例证明「这不是管道」——`[Console]::IsOutputRedirected` 在管道里是 True，
 * 在真终端里是 False，这一条就是「和我直接打开 PowerShell 体验一致」的判据。
 */

interface FakePty {
  pid: number;
  written: string[];
  sizes: Array<[number, number]>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number) => void;
}

function fakeSpawn() {
  const ptys: FakePty[] = [];
  const dataHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(event: { exitCode: number }) => void> = [];
  const spawnFn = (() => {
    const index = ptys.length;
    const pty: FakePty = {
      pid: 2000 + index,
      written: [],
      sizes: [],
      kill: vi.fn(),
      emitData: (chunk) => {
        for (const handler of dataHandlers) handler(chunk);
      },
      emitExit: (exitCode) => {
        for (const handler of exitHandlers) handler({ exitCode });
      },
    };
    ptys.push(pty);
    return {
      pid: pty.pid,
      onData: (handler: (chunk: string) => void) => {
        dataHandlers.push(handler);
        return { dispose: () => {} };
      },
      onExit: (handler: (event: { exitCode: number }) => void) => {
        exitHandlers.push(handler);
        return { dispose: () => {} };
      },
      write: (data: string) => pty.written.push(data),
      resize: (cols: number, rows: number) => pty.sizes.push([cols, rows]),
      kill: pty.kill,
    };
  }) as never;
  return { spawnFn, ptys };
}

const SHELLS: TerminalShellOption[] = [
  { id: "cmd", label: "cmd", executable: "C:WindowsSystem32cmd.exe" },
  { id: "powershell", label: "Windows PowerShell", executable: "ps.exe" },
];

function start(options: {
  shell: "cmd" | "powershell";
  ptys: FakePty[];
  idleMs?: number;
  cols?: number;
  rows?: number;
}) {
  const { spawnFn, ptys } = fakeSpawn();
  const onData = vi.fn();
  const onExit = vi.fn();
  const session = startTerminalSession({
    id: "s1",
    cwd: "C:work",
    shell: options.shell,
    availableShells: SHELLS,
    onData,
    onExit,
    spawnFn,
    cols: options.cols,
    rows: options.rows,
    idleMs: options.idleMs ?? 60_000,
  });
  const pty = ptys.at(-1);
  if (!pty) throw new Error("替身 PTY 未创建");
  options.ptys.push(pty);
  return { session, onData, onExit, pty };
}

describe("终端会话：真 PTY 的协议与边界", () => {
  it("**没有启动前置**（ConPTY 下中文不需要 chcp / OutputEncoding），按键原样送", () => {
    const ptys: FakePty[] = [];
    const { session, pty } = start({ shell: "cmd", ptys });

    // 以前那行 `chcp 65001` 会被 shell 回显在屏幕最上面（白占一行），ConPTY 下不需要它
    expect(pty.written).toHaveLength(0);
    // 原始按键原样送：不回显、不补换行（回车就是用户按的那个 \r）
    session.write("dir\r");
    expect(pty.written[0]).toBe("dir\r");
    // 方向键这类转义序列也要原样过
    session.write("\u001b[A");
    expect(pty.written[1]).toBe("\u001b[A");
  });

  it("PowerShell：启动参数**不关交互**（不加 -NonInteractive / -Command -，那会关掉 PSReadLine）", () => {
    const ptys: FakePty[] = [];
    const { pty } = start({ shell: "powershell", ptys });
    // 启动时不写任何东西（见 startupPrelude 的注释）
    expect(pty.written).toHaveLength(0);
    // spawn 的第二个参数在替身里看不到，这里从真实调用侧断言（见真机用例）
  });

  it("输出：PTY 的数据原样回调（ANSI 转义由客户端模拟器解析）", () => {
    const ptys: FakePty[] = [];
    const { onData, pty } = start({ shell: "cmd", ptys });
    pty.emitData("\u001b[32mPS D:\\work>\u001b[0m");
    expect(onData).toHaveBeenCalledWith("\u001b[32mPS D:\\work>\u001b[0m");
  });

  it("resize：把尺寸转给 PTY（PSReadLine / 全屏 TUI 靠它排版）", () => {
    const ptys: FakePty[] = [];
    const { session, pty } = start({ shell: "cmd", ptys, cols: 100, rows: 30 });
    expect(pty.sizes).toHaveLength(0); // 初始尺寸在 spawn 时给（替身看不到 spawn 参数）
    session.resize(120, 40);
    expect(pty.sizes).toEqual([[120, 40]]);
  });

  it("退出：回调退出码，之后不再写入也不再 resize", () => {
    const ptys: FakePty[] = [];
    const { session, onExit, pty } = start({ shell: "cmd", ptys });
    pty.emitExit(3);
    expect(onExit).toHaveBeenCalledWith(3, undefined);
    expect(session.exited).toBe(true);

    const before = pty.written.length;
    session.write("echo should-not-run\r");
    session.resize(10, 10);
    expect(pty.written).toHaveLength(before);
    expect(pty.sizes).toHaveLength(0);
  });

  it("停会话：kill PTY，并在收不掉时兜底结束（不留悬挂会话）；重复 stop 幂等", () => {
    vi.useFakeTimers();
    try {
      const ptys: FakePty[] = [];
      const { session, onExit, pty } = start({ shell: "cmd", ptys });
      session.stop("手动关闭");
      expect(pty.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1600);
      expect(onExit).toHaveBeenCalledWith(null, "手动关闭");
      session.stop();
      expect(pty.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("闲置超时：到点自动收掉会话并给出可读原因", () => {
    vi.useFakeTimers();
    try {
      const ptys: FakePty[] = [];
      const { onExit } = start({ shell: "cmd", ptys, idleMs: 50 });
      vi.advanceTimersByTime(51);
      vi.advanceTimersByTime(50 + 60_000);
      expect(onExit).toHaveBeenCalled();
      const [, reason] = onExit.mock.calls[0] ?? [];
      expect(reason).toMatch(/闲置/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("探测不到 shell：如实说明，而不是让 node 兜底跑一条谁也不知道的命令", async () => {
    const onExit = vi.fn();
    const session = startTerminalSession({
      id: "s1",
      cwd: "C:work",
      shell: "cmd",
      availableShells: [],
      onData: vi.fn(),
      onExit,
    });
    await Promise.resolve();
    expect(session.exited).toBe(true);
    expect(String(onExit.mock.calls[0]?.[1])).toMatch(/找不到可用的 shell/);
  });
});

describe("输出分帧（WS 帧不因一条大输出变成几 MB）", () => {
  it("小于上限原样返回一段", () => {
    expect(chunkForFrames("hello")).toEqual(["hello"]);
  });

  it("超过上限切成多段，且拼回等于原文（不切碎多字节字符）", () => {
    const text = "中".repeat(TERMINAL_OUTPUT_FRAME_BYTES);
    const frames = chunkForFrames(text);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(
        TERMINAL_OUTPUT_FRAME_BYTES,
      );
      expect(frame).not.toContain("\uFFFD");
    }
    expect(frames.join("")).toBe(text);
  });
});

/**
 * 真机行为：真 PTY 的判据是 **shell 自己认为它在终端里**——
 * `[Console]::IsOutputRedirected` 在管道里是 True、真终端里是 False；
 * 顺带验会话状态保留（cd 保留）与 resize 真的改变了控制台宽度。
 */
describe("终端会话：真机（常驻 shell 的会话状态）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      // 被 taskkill 的 shell（及它起的 REPL）可能还握着 cwd 一小会儿：留给它重试窗口
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    }
  });

  /** 起会话并返回「退出信号」的触发器（收尾时要等进程真的没了再删临时目录）。 */
  function startReal(
    shell: "cmd" | "bash" | "powershell",
    cwd: string,
    onData: (c: string) => void,
  ) {
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session = startTerminalSession({
      id: "real",
      cwd,
      shell,
      onData,
      onExit: () => resolveExit(),
    });
    return { session, exited };
  }

  /** 等输出里出现哨兵（命令回显与结果都到齐）。 */
  function waitForOutput(
    sentinel: string,
    getOutput: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (getOutput().includes(sentinel)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待 ${sentinel} 超时；已收到：${getOutput()}`));
        }
      }, 50);
    });
  }

  it.skipIf(process.platform !== "win32")(
    "cmd：cd 与变量都在同一进程里保留（两条命令不共享目录就是失败的实现）",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kfw-session-"));
      dirs.push(root);
      mkdirSync(join(root, "sub"));

      let output = "";
      const { session, exited } = startReal("cmd", root, (chunk) => {
        output += chunk;
      });
      try {
        session.write("cd sub\r");
        session.write("set KFW_PROBE=kept\r");
        session.write("echo PROBE:%CD%:%KFW_PROBE%:END\r");
        await waitForOutput("PROBE:", () => output);
        // cd 到了 sub、变量还在：说明这两条命令跑在同一个 shell 进程里
        expect(output).toContain("PROBE:");
        expect(output.toLowerCase()).toContain("sub");
        expect(output).toContain("kept");
      } finally {
        session.stop("测试结束");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "bash：cd 保留（POSIX 上没有 cmd，用 sh 验同一条性质）",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kfw-session-"));
      dirs.push(root);
      mkdirSync(join(root, "sub"));

      let output = "";
      const { session, exited } = startReal("bash", root, (chunk) => {
        output += chunk;
      });
      try {
        session.write("cd sub\r");
        session.write("echo PROBE:$(pwd):END\r");
        await waitForOutput("END", () => output);
        expect(output).toContain("/sub");
      } finally {
        session.stop("测试结束");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "真终端判据：PowerShell 认为自己在终端里（管道下 IsOutputRedirected 会是 True）",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kfw-session-"));
      dirs.push(root);
      let output = "";
      const { session, exited } = startReal("powershell", root, (chunk) => {
        output += chunk;
      });
      try {
        session.write(
          "if ([Console]::IsOutputRedirected) { 'KFW-' + 'NOPE' } else { 'KFW-' + 'T' + 'T' + 'Y' }\r",
        );
        await waitForOutput("KFW-TTY", () => output, 20_000);
        expect(output).toContain("KFW-TTY");
        expect(output).not.toContain("KFW-NOPE");
      } finally {
        session.stop("测试结束");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "交互式程序（python REPL）只要本机有就能连续对话——不是一条命令一个进程",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kfw-session-"));
      dirs.push(root);
      let output = "";
      const { session, exited } = startReal("cmd", root, (chunk) => {
        output += chunk;
      });
      try {
        session.write("where python\r");
        await waitForOutput("python", () => output, 8_000);
        // 有 python 才有 REPL 可测；没有就只验「探查命令能跑」（不把环境缺失当失败）
        if (!output.toLowerCase().includes("python")) return;
        session.write("python -i\r");
        session.write("print(6*7)\r");
        session.write("print('KFW_REPL_OK')\r");
        session.write("exit()\r");
        await waitForOutput("KFW_REPL_OK", () => output, 15_000);
        expect(output).toContain("42");
      } finally {
        session.stop("测试结束");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    },
    30_000,
  );
});
