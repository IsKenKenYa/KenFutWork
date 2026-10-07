import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { unixCommand } from "./command.js";
import { executionEnvironment } from "./environment.js";
import { prepareLinuxSandboxArgv } from "./linux-launch.js";
import type { ProcessOwner } from "./managed-process.js";
import { ProcessOutputCapture } from "./output-capture.js";
import { commandDirectory, unixPolicy } from "./policy.js";
import type { HelperRequest, HelperResponse } from "./protocol.js";
import { prepareLinuxProcessInspector } from "./pty-native-runtime.js";
import { loadTaskPtyRuntime } from "./pty-runtime.js";
import { losesExecutionRights } from "./scope-change.js";
import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessOutputStream,
  ProcessSpawnRequest,
} from "./types.js";
import { ProcessSandboxError } from "./types.js";
import { UnixManagedProcess } from "./unix-process.js";
import { WindowsTaskBroker } from "./windows-broker.js";
import { windowsLaunch } from "./windows-policy.js";
import { WindowsManagedProcess } from "./windows-process.js";

class TaskProcessHelper {
  private taskId = "";
  private generation = 0;
  private phase: "starting" | "ready" | "revoking" | "closed" | "failed" =
    "starting";
  private options:
    | Extract<HelperRequest, { method: "initialize" }>["options"]
    | undefined;
  private privateDirectory = "";
  private temporaryDirectory = "";
  private readonly processes = new Map<string, ProcessOwner>();
  private windowsBroker: WindowsTaskBroker | undefined;
  private windowsBrokerPath = "";
  private readonly invocations = new Map<
    string,
    { child: Promise<ProcessOwner>; fingerprint: string }
  >();
  private readonly wrapping = new Set<AbortController>();
  private ptyRuntime: ReturnType<typeof loadTaskPtyRuntime> | undefined;
  private linuxInspector: Promise<string> | undefined;
  private closePromise: Promise<void> | undefined;
  private initialization: Promise<null> | undefined;
  private readonly invalidatedProcesses = new Set<string>();

  async execute(input: HelperRequest): Promise<unknown> {
    if (input.method === "initialize") {
      this.initialization ??= this.initialize(input);
      return this.initialization;
    }
    if (input.method === "revoke")
      return this.revoke(input.generation, input.reason);
    if (input.method === "scopechange")
      return this.revoke(input.next.generation, input.reason, input.next);
    if (input.method === "close") return this.close(input.reason);
    if (input.method === "spawn")
      return this.spawn(input.request, input.internalWriteRoots);
    const child = this.processes.get(input.processId);
    if (!child)
      throw new ProcessSandboxError("process_closed", "命令句柄不存在。");
    if (input.method === "output")
      return child.output(input.offset, input.maxBytes, input.stream);
    if (input.method === "outputreader") {
      if (!child.setOutputReader)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "命令没有 PTY 输出 reader。",
        );
      await child.setOutputReader(input.active, input.stream);
      return null;
    }
    if (input.method === "outputack") {
      if (!child.acknowledgeOutput)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "命令没有实时 PTY 输出。",
        );
      await child.acknowledgeOutput(input.sequence, input.stream);
      return null;
    }
    if (input.method === "wait") return child.wait();
    if (input.method === "stop") return child.stop(input.reason);
    if (input.method === "endstdin") {
      await child.endStdin();
      return null;
    }
    if (
      this.phase !== "ready" ||
      this.invalidatedProcesses.has(input.processId)
    ) {
      throw new ProcessSandboxError(
        "scope_revoked",
        "Task 权限已收紧，旧命令不再接受 stdin。",
      );
    }
    if (input.method === "resize") {
      if (!child.resize)
        throw new ProcessSandboxError(
          "invalid_process_request",
          "该命令没有 PTY resize 能力。",
        );
      await child.resize(input.cols, input.rows);
      return null;
    }
    await child.stdin(input.data);
    return null;
  }

  private async initialize(
    input: Extract<HelperRequest, { method: "initialize" }>,
  ): Promise<null> {
    if (this.options !== undefined)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "Task helper 已初始化。",
      );
    if (
      process.platform !== "darwin" &&
      process.platform !== "linux" &&
      process.platform !== "win32"
    ) {
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "本平台需要原生 Task sandbox broker。",
      );
    }
    this.taskId = input.taskId;
    this.generation = input.initial.scope.generation;
    this.options = input.options;
    this.privateDirectory = join(
      input.options.captureRoot,
      createHash("sha256").update(this.taskId).digest("hex"),
    );
    await mkdir(join(this.privateDirectory, "output"), {
      recursive: true,
      mode: 0o700,
    });
    this.temporaryDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-task-process-")),
    );
    const home = join(this.temporaryDirectory, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.CLAUDE_CODE_TMPDIR = this.temporaryDirectory;
    if (process.platform === "win32") {
      if (input.options.network.allowedDomains.length > 0) {
        throw new ProcessSandboxError(
          "enforcement_unavailable",
          "当前原生 Windows PSEC 无法落实客户端专用的受限代理策略；拒绝扩大网络权限。",
        );
      }
      this.windowsBrokerPath =
        input.options.windowsBrokerPath ??
        fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "./native/target/release/kenfutwork-process-broker.exe"
              : "./process-broker.exe",
            import.meta.url,
          ),
        );
      this.windowsBroker = new WindowsTaskBroker(
        this.windowsBrokerPath,
        executionEnvironment(process.env),
      );
      const capability = (await this.windowsBroker.rpc({
        method: "probe",
      })) as { protocolVersion?: number; pty?: string; stdio?: string };
      if (
        capability.protocolVersion !== 2 ||
        capability.pty !== "conpty" ||
        capability.stdio !== "ack-stream"
      )
        throw new ProcessSandboxError(
          "enforcement_unavailable",
          "Windows native broker 缺少完整 ConPTY/stdio 能力，请更新发布资源。",
        );
      this.phase = "ready";
      return null;
    }
    const policy = await this.policy(input.initial);
    const dependencies = await SandboxManager.checkDependenciesAsync();
    if (
      !SandboxManager.isSupportedPlatform() ||
      dependencies.errors.length > 0
    ) {
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        `真实沙箱不可用：${dependencies.errors.join("；")}`,
      );
    }
    await SandboxManager.initialize(policy, undefined, true);
    await this.probe(input.initial);
    this.phase = "ready";
    return null;
  }

  private async policy(
    request: ProcessSpawnRequest,
    internalWriteRoots: readonly string[] = [],
  ) {
    const options = this.requireOptions();
    const policy = await unixPolicy({
      scope: request.scope,
      privateDirectory: this.privateDirectory,
      temporaryDirectory: this.temporaryDirectory,
      network: options.network,
      internalWriteRoots,
      ...(options.runtimeReadRoots
        ? { runtimeReadRoots: options.runtimeReadRoots }
        : {}),
    });
    // SRT 明确的 macOS PTY ioctl 能力；仅该次 PTY 命令启用，目录与网络授权不变。
    return { ...policy, allowPty: request.pty !== undefined };
  }

  private requireOptions() {
    if (!this.options)
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        "Task helper 尚未初始化。",
      );
    return this.options;
  }

  private async probe(request: ProcessSpawnRequest): Promise<void> {
    const protectedFile = join(this.privateDirectory, "probe.txt");
    await writeFile(protectedFile, "private runtime probe", { mode: 0o600 });
    // Linux tmpfs 隐藏 private parent 时返回 ENOENT；Darwin seatbelt 返回 EACCES/EPERM。
    const unavailable = process.platform === "linux" ? ',"ENOENT"' : "";
    const program = `const fs=require("node:fs");let denied=0;let read="allowed",write="allowed";try{fs.readFileSync(${JSON.stringify(protectedFile)})}catch(e){read=e.code;if(["EACCES","EPERM"${unavailable}].includes(e.code))denied++}try{fs.writeFileSync(${JSON.stringify(protectedFile)},"escape")}catch(e){write=e.code;if(["EACCES","EPERM","EROFS"${unavailable}].includes(e.code))denied++}if(denied!==2)process.stderr.write(JSON.stringify({read,write}));process.exit(denied===2?0:91)`;
    const probe = await this.launch(
      {
        scope: request.scope,
        agentId: "sandbox-probe",
        invocationId: `probe:${randomUUID()}`,
        argv: { executable: process.execPath, args: ["-e", program] },
        background: false,
        limits: request.limits,
        timeoutMs: request.limits.killGraceMs,
      },
      true,
    );
    const exited = await probe.wait();
    if (exited.exitCode !== 0 || !exited.rangeEmpty) {
      const evidence = probe.output(0, request.limits.previewMaxChars).data;
      throw new ProcessSandboxError(
        "enforcement_unavailable",
        `操作系统未落实读取/写入隔离：${evidence}`,
      );
    }
  }

  private async spawn(
    request: ProcessSpawnRequest,
    internalWriteRoots: readonly string[],
  ): Promise<ManagedProcessSnapshot> {
    this.assertReady(request);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ request, internalWriteRoots }))
      .digest("hex");
    const previous = this.invocations.get(request.invocationId);
    if (previous && previous.fingerprint !== fingerprint)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "同一调用身份不能启动不同参数的命令。",
      );
    // 在第一次 await 前预留启动 Promise；失败也保留，不能重放不安全副作用。
    const pending = previous ?? {
      child: this.launch(request, false, internalWriteRoots),
      fingerprint,
    };
    this.invocations.set(request.invocationId, pending);
    return (await pending.child).snapshot();
  }

  private async launch(
    request: ProcessSpawnRequest,
    probe = false,
    internalWriteRoots: readonly string[] = [],
  ): Promise<ProcessOwner> {
    const abort = new AbortController();
    this.wrapping.add(abort);
    let wrapped = false;
    try {
      const cwd = await commandDirectory(request.scope, request.cwd);
      const id = randomUUID();
      if (this.windowsBroker) {
        if (!probe) this.assertReady(request);
        const launch = await windowsLaunch({
          request,
          processId: id,
          cwd,
          privateDirectory: this.privateDirectory,
          temporaryDirectory: this.temporaryDirectory,
          brokerPath: this.windowsBrokerPath,
          internalWriteRoots,
          ...(this.requireOptions().runtimeReadRoots
            ? { runtimeReadRoots: this.requireOptions().runtimeReadRoots }
            : {}),
        });
        if (!probe) this.assertReady(request);
        abort.signal.throwIfAborted();
        const { output, snapshot } = this.captureProcess(request, id);
        const child = new WindowsManagedProcess(
          this.windowsBroker,
          request,
          output,
          snapshot,
          launch,
          (changed) => this.send({ event: "snapshot", snapshot: changed }),
          (sequence, data, offset, nextOffset, stream) =>
            this.sendProcessOutput(
              id,
              sequence,
              data,
              offset,
              nextOffset,
              stream,
            ),
        );
        this.processes.set(id, child);
        await child.ready.promise;
        return child;
      }
      const policy = await this.policy(request, internalWriteRoots);
      const command = unixCommand(request);
      // 外层 launcher 是固定受信任的系统 shell；用户选择的 shell 只在 sandbox 内启动。
      const descriptor = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/sh",
        policy,
        abort.signal,
        cwd,
        {
          commandId: id,
          commandText: request.command ?? request.argv?.executable ?? "命令",
        },
      );
      wrapped = true;
      if (process.platform === "linux")
        descriptor.argv = prepareLinuxSandboxArgv(
          descriptor.argv,
          Boolean(request.pty),
          this.privateDirectory,
        );
      if (!probe) this.assertReady(request);
      abort.signal.throwIfAborted();
      descriptor.env = {
        ...executionEnvironment(descriptor.env),
        HOME: process.env.HOME,
        CLAUDE_CODE_TMPDIR: this.temporaryDirectory,
      };
      if (request.pty)
        this.ptyRuntime ??= loadTaskPtyRuntime(
          this.privateDirectory,
          request.limits,
        );
      const ptyModule = request.pty ? await this.ptyRuntime : undefined;
      if (!probe) this.assertReady(request);
      abort.signal.throwIfAborted();
      if (process.platform === "linux")
        this.linuxInspector ??= prepareLinuxProcessInspector(
          this.privateDirectory,
          request.limits,
        );
      const linuxInspector = await this.linuxInspector;
      if (!probe) this.assertReady(request);
      abort.signal.throwIfAborted();
      const { output, snapshot } = this.captureProcess(request, id);
      const child = new UnixManagedProcess(
        descriptor,
        request,
        cwd,
        output,
        snapshot,
        (changed) => {
          if (!probe) this.send({ event: "snapshot", snapshot: changed });
        },
        () => SandboxManager.cleanupAfterCommand(),
        ptyModule?.module,
        (sequence, data, offset, nextOffset, stream) =>
          this.sendProcessOutput(
            id,
            sequence,
            data,
            offset,
            nextOffset,
            stream,
          ),
        ptyModule?.inspector,
        linuxInspector,
      );
      this.processes.set(id, child);
      wrapped = false; // 命令 owner 已接管恰好一次 cleanup。
      await child.ready.promise;
      return child;
    } finally {
      this.wrapping.delete(abort);
      if (wrapped) SandboxManager.cleanupAfterCommand();
    }
  }

  private sendProcessOutput(
    processId: string,
    sequence: number,
    data: string,
    offset: number,
    nextOffset: number,
    stream?: ProcessOutputStream,
  ): void {
    const frame = { processId, sequence, data, offset, nextOffset };
    this.send(
      stream
        ? { event: "stdio-output", ...frame, stream }
        : { event: "pty-output", ...frame },
    );
  }

  private captureProcess(request: ProcessSpawnRequest, id: string) {
    const output = new ProcessOutputCapture(
      join(this.privateDirectory, "output", `${id}.bin`),
      request.limits.maxOutputBytes,
    );
    const snapshot: ManagedProcessSnapshot = {
      id,
      ownerTaskId: this.taskId,
      agentId: request.agentId,
      invocationId: request.invocationId,
      generation: request.scope.generation,
      state: "starting",
      pid: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      enforcement: {
        backend: this.windowsBroker
          ? "windows-task-broker"
          : process.platform === "darwin"
            ? "srt-seatbelt"
            : "srt-bwrap",
        filesystem: "enforced",
        processRange: this.windowsBroker
          ? "job-object"
          : process.platform === "darwin"
            ? "process-group"
            : "pid-namespace",
        permissionsGeneration: request.scope.generation,
      },
      exit: null,
      retainedBytes: 0,
      totalBytes: 0,
      discardedBytes: 0,
      outputPath: output.path,
    };
    return { output, snapshot };
  }

  private assertReady(request: ProcessSpawnRequest): void {
    if (
      this.phase !== "ready" ||
      request.scope.taskId !== this.taskId ||
      request.scope.generation < this.generation
    ) {
      throw new ProcessSandboxError(
        "scope_revoked",
        "Task 执行授权已撤销或正在收紧。",
      );
    }
  }

  private async revoke(
    generation: number,
    reason: string,
    next?: import("@kenfutwork/shared").CodeExecutionScope,
  ): Promise<null> {
    this.phase = "revoking";
    this.generation = Math.max(this.generation, generation);
    for (const abort of this.wrapping)
      abort.abort(new ProcessSandboxError("scope_revoked", reason));
    try {
      const affected = [...this.processes.values()].filter(
        (child) => !next || losesExecutionRights(child.scope, next),
      );
      for (const child of affected)
        this.invalidatedProcesses.add(child.snapshot().id);
      const outcomes = await Promise.all(
        affected.map((child) => child.stop(reason)),
      );
      if (outcomes.some((outcome) => !outcome.rangeEmpty))
        throw new ProcessSandboxError(
          "stop_unconfirmed",
          "存在尚未确认退出的命令。",
        );
      this.phase = "ready";
      return null;
    } catch (error) {
      this.phase = "failed";
      throw error;
    }
  }

  close(reason: string): Promise<void> {
    this.closePromise ??= (async () => {
      for (const abort of this.wrapping)
        abort.abort(new ProcessSandboxError("scope_revoked", reason));
      await this.initialization?.catch(() => {});
      await this.revoke(this.generation, reason);
      this.phase = "closed";
      if (this.windowsBroker) await this.windowsBroker.close();
      else await SandboxManager.reset();
      if (this.temporaryDirectory)
        await rm(this.temporaryDirectory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }

  send(message: HelperResponse): void {
    if (process.connected) process.send?.(message);
  }
}

const helper = new TaskProcessHelper();
process.on("message", (message: HelperRequest) => {
  if (
    !message ||
    typeof message.id !== "string" ||
    typeof message.method !== "string"
  )
    return;
  void helper.execute(message).then(
    (value) => {
      helper.send({
        id: message.id,
        ok: true,
        value: (value ?? null) as ManagedProcessSnapshot | ProcessExit | null,
      });
    },
    (error: unknown) => {
      helper.send({
        id: message.id,
        ok: false,
        error: {
          code:
            error instanceof ProcessSandboxError ? error.code : "spawn_failed",
          message:
            error instanceof Error ? error.message : "进程 helper 执行失败。",
        },
      });
    },
  );
});
const close = (reason: string): void => {
  void helper.close(reason).then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
};
process.on("disconnect", () => close("ipc_disconnected"));
process.once("SIGTERM", () => close("helper_terminated"));
process.once("SIGINT", () => close("helper_interrupted"));
