import type { ProcessOwner } from "./managed-process.js";
import type { ProcessOutputCapture } from "./output-capture.js";
import type {
  ManagedProcessSnapshot,
  ProcessExit,
  ProcessOutputStream,
  ProcessSpawnRequest,
} from "./types.js";
import { ProcessSandboxError } from "./types.js";
import type {
  NativeLaunch,
  NativeProcessEvent,
  WindowsTaskBroker,
} from "./windows-broker.js";
import { WindowsLiveOutput } from "./windows-live-output.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class WindowsManagedProcess implements ProcessOwner {
  readonly ready = deferred<void>();
  readonly scope: ProcessSpawnRequest["scope"];
  private readonly settled = deferred<ProcessExit>();
  private readonly physicalExit = deferred<ProcessExit>();
  private stopPromise: Promise<ProcessExit> | undefined;
  private stopReason: string | null = null;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private readonly unlisten: () => void;
  private readonly live = new Map<ProcessOutputStream, WindowsLiveOutput>();

  constructor(
    private readonly broker: Pick<WindowsTaskBroker, "rpc" | "listen">,
    private readonly request: ProcessSpawnRequest,
    private readonly capture: ProcessOutputCapture,
    private readonly value: ManagedProcessSnapshot,
    launch: NativeLaunch,
    private readonly changed: (snapshot: ManagedProcessSnapshot) => void,
    sendOutput?: (
      sequence: number,
      data: string,
      offset: number,
      nextOffset: number,
      stream?: ProcessOutputStream,
    ) => void,
  ) {
    this.scope = structuredClone(request.scope);
    if (sendOutput && (request.pty || request.stdio)) {
      for (const stream of request.pty
        ? (["stdout"] as const)
        : (["stdout", "stderr"] as const)) {
        this.live.set(
          stream,
          new WindowsLiveOutput(
            request.pty ? undefined : stream,
            (sequence) =>
              broker.rpc({
                method: "outputack",
                processId: value.id,
                stream,
                sequence,
              }),
            (active) =>
              broker.rpc({
                method: "outputreader",
                processId: value.id,
                stream,
                active,
              }),
            (error) => {
              this.failed(error);
              void this.stop("output_failed").catch(() => {});
            },
            sendOutput,
          ),
        );
      }
    }
    this.unlisten = broker.listen(value.id, (event) => this.event(event));
    void broker.rpc({ method: "spawn", launch }).then(
      (response) => {
        this.value.pid = (response as { pid: number }).pid;
        if (this.value.exit === null) this.value.state = "running";
        this.publish();
        this.ready.resolve();
      },
      (error: unknown) => {
        this.ready.reject(error);
        if (this.value.exit === null) this.failed(error);
      },
    );
    void this.ready.promise.catch(() => {});
    void this.settled.promise.catch(() => {});
    void this.physicalExit.promise.catch(() => {});
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) {
      this.deadline = setTimeout(() => {
        void this.stop("deadline_exceeded").catch(() => {});
      }, request.timeoutMs);
    }
  }

  snapshot() {
    return structuredClone(this.value);
  }
  output(offset: number, maxBytes: number, stream?: ProcessOutputStream) {
    return this.capture.read(
      offset,
      maxBytes,
      this.value.exit !== null,
      stream,
    );
  }
  wait() {
    return this.settled.promise;
  }

  async stdin(data: string): Promise<void> {
    if (this.stopReason !== null || this.value.state !== "running")
      throw new ProcessSandboxError("process_closed", "命令已停止或退出。");
    await this.broker.rpc({ method: "stdin", processId: this.value.id, data });
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (
      !this.request.pty ||
      this.stopReason !== null ||
      this.value.state !== "running"
    )
      throw new ProcessSandboxError("process_closed", "终端已停止或退出。");
    // COORD uses signed 16-bit dimensions; this is a fixed Win32 argument boundary.
    if (
      !Number.isSafeInteger(cols) ||
      cols < 2 ||
      cols > 0x7fff ||
      !Number.isSafeInteger(rows) ||
      rows < 1 ||
      rows > 0x7fff
    )
      throw new ProcessSandboxError(
        "invalid_process_request",
        "ConPTY 尺寸超出 COORD 范围。",
      );
    await this.broker.rpc({
      method: "resize",
      processId: this.value.id,
      cols,
      rows,
    });
  }

  async acknowledgeOutput(
    sequence: number,
    stream?: ProcessOutputStream,
  ): Promise<void> {
    await this.relay(stream).acknowledge(sequence);
  }

  async setOutputReader(
    active: boolean,
    stream?: ProcessOutputStream,
  ): Promise<void> {
    await this.relay(stream).setReader(active);
  }

  private relay(stream?: ProcessOutputStream): WindowsLiveOutput {
    const output = this.live.get(stream ?? "stdout");
    if (!output)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "命令没有完整实时流。",
      );
    return output;
  }

  async endStdin(): Promise<void> {
    if (this.request.pty)
      throw new ProcessSandboxError(
        "invalid_process_request",
        "PTY 不提供独立 EOF；请发送终端控制键或停止。",
      );
    if (this.value.exit !== null) return;
    await this.broker.rpc({ method: "endstdin", processId: this.value.id });
  }

  stop(reason: string): Promise<ProcessExit> {
    if (this.value.exit !== null) return Promise.resolve(this.value.exit);
    this.stopReason = reason;
    for (const output of this.live.values()) output.close();
    this.stopPromise ??= (async () => {
      try {
        await this.broker.rpc({ method: "stop", processId: this.value.id });
      } catch {
        /* A controller reply is not a physical exit fact; await the signed Job event. */
      }
      return this.physicalExit.promise;
    })();
    return this.stopPromise;
  }

  private event(event: NativeProcessEvent): void {
    if (event.event === "output") {
      try {
        const bytes = Buffer.from(event.data, "base64");
        this.capture.append(bytes, event.stream);
        if (event.sequence !== null)
          this.live.get(event.stream)?.receive(event.sequence, bytes);
        this.publish();
      } catch (error) {
        this.failed(error);
        void this.stop("output_failed").catch(() => {});
      }
      return;
    }
    if (event.event === "stream-end") {
      try {
        this.live.get(event.stream)?.end();
      } catch (error) {
        this.failed(error);
        void this.stop("output_failed").catch(() => {});
      }
      return;
    }
    if (event.event === "native-exit") {
      for (const output of this.live.values()) output.exited();
      return;
    }
    if (event.event === "failure") {
      for (const output of this.live.values()) output.close();
      const failure = new ProcessSandboxError(
        "stop_unconfirmed",
        event.message,
      );
      if (event.code === "stop_unconfirmed") this.physicalExit.reject(failure);
      this.failed(failure);
      return;
    }
    if (!event.rangeEmpty) {
      const failure = new ProcessSandboxError(
        "stop_unconfirmed",
        "原生 Job 尚未确认清空。",
      );
      this.physicalExit.reject(failure);
      this.failed(failure);
      return;
    }
    const failure =
      event.failure && this.stopReason === null ? event.failure : null;
    const exit: ProcessExit = {
      exitCode: event.exitCode,
      signal: null,
      reason: this.stopReason ?? (failure ? "native_process_failed" : null),
      stopped: this.stopReason !== null,
      rangeEmpty: true,
    };
    this.value.exit = exit;
    this.value.finishedAt = new Date().toISOString();
    this.value.state = failure ? "failed" : exit.stopped ? "stopped" : "exited";
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.physicalExit.resolve(exit);
    this.capture.close();
    this.publish();
    if (failure)
      this.settled.reject(new ProcessSandboxError("output_failed", failure));
    else this.settled.resolve(exit);
    this.unlisten();
  }

  private failed(error: unknown): void {
    this.value.state = "failed";
    this.publish();
    this.settled.reject(error);
  }

  private publish(): void {
    this.value.retainedBytes = this.capture.retainedBytes;
    this.value.totalBytes = this.capture.totalBytes;
    this.value.discardedBytes =
      this.capture.totalBytes - this.capture.retainedBytes;
    this.changed(this.snapshot());
  }
}
