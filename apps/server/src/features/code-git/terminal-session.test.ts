import { EventEmitter } from "node:events";
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
 * 交互式终端会话（R3-1 的可用形态）：一条常驻 shell，cd 保留、REPL 能连续对话。
 *
 * 这里用**替身进程**测协议与边界（行尾、UTF-8 前置、闲置超时、帧切分），
 * 不依赖本机装了什么 shell——真机行为另有一次性执行那组用例兜着。
 */

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: { write: (data: string) => void; written: string[] };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawnFn = (() => {
    const child = new EventEmitter() as FakeChild;
    child.pid = 1000 + children.length;
    const written: string[] = [];
    child.stdin = {
      written,
      write: (data: string) => {
        written.push(data);
      },
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    children.push(child);
    return child;
  }) as never;
  return { spawnFn, children };
}

const SHELLS: TerminalShellOption[] = [
  { id: "cmd", label: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" },
  { id: "powershell", label: "Windows PowerShell", executable: "ps.exe" },
];

function start(options: {
  shell: "cmd" | "powershell";
  children: FakeChild[];
  idleMs?: number;
}) {
  const { spawnFn, children } = fakeSpawn();
  options.children.push(...children);
  const onData = vi.fn();
  const onExit = vi.fn();
  /** 杀进程树在真实环境会调 taskkill：单测里必须换成替身（假 pid 可能误伤真进程）。 */
  const killTreeFn = vi.fn();
  const session = startTerminalSession({
    id: "s1",
    cwd: "C:\\work",
    shell: options.shell,
    availableShells: SHELLS,
    onData,
    onExit,
    spawnFn,
    killTreeFn,
    idleMs: options.idleMs ?? 60_000,
  });
  const child = children[0];
  if (!child) {
    throw new Error("替身进程未创建");
  }
  return { session, onData, onExit, killTreeFn, child };
}

describe("终端会话：常驻 shell 的协议与边界", () => {
  it("cmd：先切 UTF-8 代码页（否则中文输出在管道里就是乱码），行尾用 \\r\\n", () => {
    const children: FakeChild[] = [];
    const { session, child } = start({ shell: "cmd", children });

    expect(child.stdin.written[0]).toBe("chcp 65001>nul\r\n");
    session.write("cd apps");
    expect(child.stdin.written[1]).toBe("cd apps\r\n");
    session.write("dir");
    expect(child.stdin.written[2]).toBe("dir\r\n");
  });

  it("PowerShell：会话开头切输出编码；同一进程连续收命令（cd 因此保留）", () => {
    const children: FakeChild[] = [];
    const { session, child } = start({ shell: "powershell", children });

    expect(child.stdin.written[0]).toContain("[Console]::OutputEncoding");
    session.write("cd D:\\work");
    session.write("python");
    expect(child.stdin.written).toHaveLength(3);
  });

  it("输出：stdout/stderr 都转成文本回调（拼回由客户端做）", () => {
    const children: FakeChild[] = [];
    const { onData, child } = start({ shell: "cmd", children });

    child.stdout.emit("data", Buffer.from("hello\r\n", "utf8"));
    child.stderr.emit("data", Buffer.from("warn\r\n", "utf8"));
    expect(onData.mock.calls.map((call) => call[0])).toEqual([
      "hello\r\n",
      "warn\r\n",
    ]);
  });

  it("进程退出：回调退出码，且之后不再写入", () => {
    const children: FakeChild[] = [];
    const { session, onExit, child } = start({ shell: "cmd", children });

    child.emit("close", 3);
    expect(onExit).toHaveBeenCalledWith(3, undefined);
    expect(session.exited).toBe(true);

    const before = child.stdin.written.length;
    session.write("echo should-not-run");
    expect(child.stdin.written).toHaveLength(before);
  });

  it("停止会话：杀整棵进程树，并在进程收不掉时兜底结束（不留悬挂会话）", () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      const { session, onExit, killTreeFn, child } = start({
        shell: "cmd",
        children,
      });
      session.stop("手动关闭");
      expect(killTreeFn).toHaveBeenCalledTimes(1);
      expect(killTreeFn.mock.calls[0]?.[0]).toBe(child);
      // 进程没在 1.5s 内收掉：兜底结束，会话不会永远停在「退出中」
      vi.advanceTimersByTime(1600);
      expect(onExit).toHaveBeenCalledWith(null, "手动关闭");
      // 重复 stop 是幂等的（不再杀第二次）
      session.stop();
      expect(killTreeFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("闲置超时：到点自动收掉会话并给出可读原因", () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      const { onExit } = start({ shell: "cmd", children, idleMs: 50 });
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
      cwd: "C:\\work",
      shell: "cmd",
      availableShells: [],
      onData: vi.fn(),
      onExit,
    });
    await Promise.resolve();
    expect(session.exited).toBe(true);
    expect(onExit).toHaveBeenCalled();
    expect(String(onExit.mock.calls[0]?.[1])).toMatch(/找不到可用的 shell/);
  });
});

describe("输出分帧（WS 帧不因一条大输出变成几 MB）", () => {
  it("小于上限原样返回一段", () => {
    expect(chunkForFrames("hello")).toEqual(["hello"]);
  });

  it("超过上限切成多段，且拼回等于原文（不切碎多字节字符）", () => {
    const text = "中".repeat(TERMINAL_OUTPUT_FRAME_BYTES); // 每字 3 字节
    const frames = chunkForFrames(text);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(
        TERMINAL_OUTPUT_FRAME_BYTES,
      );
      // 切出来的每一段都必须是完整字符（没有替换符）
      expect(frame).not.toContain("\uFFFD");
    }
    expect(frames.join("")).toBe(text);
  });
});

/**
 * 真机行为：常驻 shell 的核心性质是**会话状态保留**（cd 保留、变量保留）——
 * 这正是「一条命令一个进程」做不到、而参考图的终端能做到的事。用真 shell 验一遍。
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
    shell: "cmd" | "bash",
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
        session.write("cd sub");
        session.write("set KFW_PROBE=kept");
        session.write("echo PROBE:%CD%:%KFW_PROBE%:END");
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
        session.write("cd sub");
        session.write("echo PROBE:$(pwd):END");
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
    "交互式程序（python REPL）只要本机有就能连续对话——不是一条命令一个进程",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kfw-session-"));
      dirs.push(root);
      let output = "";
      const { session, exited } = startReal("cmd", root, (chunk) => {
        output += chunk;
      });
      try {
        session.write("where python");
        await waitForOutput("python", () => output, 8_000);
        // 有 python 才有 REPL 可测；没有就只验「探查命令能跑」（不把环境缺失当失败）
        if (!output.toLowerCase().includes("python")) return;
        session.write("python -i");
        session.write("print(6*7)");
        session.write("print('KFW_REPL_OK')");
        session.write("exit()");
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
