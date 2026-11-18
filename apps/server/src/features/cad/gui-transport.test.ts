import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test as baseTest, expect, vi } from "vitest";
import { runCadGuiNativeCommand } from "./gui-native.js";
import type { CadGuiApplication, CadGuiProbeContext } from "./gui-probe.js";
import {
  type CadGuiTransportCommand,
  CadGuiTransportError,
  createMacosCadGuiTransport,
} from "./gui-transport.js";
import { FREECAD_GUI_TRANSPORT_SOURCE } from "./gui-transport-source.js";

const test = baseTest.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-cad-transport-")),
  );
  roots.push(root);
  const bundlePath = join(root, "FreeCAD.app");
  const python = join(bundlePath, "Contents", "Resources", "bin", "python");
  await mkdir(join(bundlePath, "Contents", "Resources", "bin"), {
    recursive: true,
  });
  await writeFile(python, "fixture; never executed\n", { mode: 0o755 });
  const macroPath = join(root, "query.FCMacro");
  await writeFile(macroPath, "# fixed test macro; never executed\n");
  const application: CadGuiApplication = {
    pid: 42424,
    bundleId: "org.freecad.FreeCAD",
    name: "FreeCAD",
    executablePath: join(bundlePath, "Contents", "Resources", "bin", "freecad"),
    bundlePath,
    launchedAt: 1700000000000,
    birth: { startSeconds: 1700000000, startMicroseconds: 123456 },
  };
  const context: CadGuiProbeContext = { timeoutMs: 5000, maxOutputBytes: 8000 };
  const sockets = [
    join(root, "instance-a", "FreeCAD"),
    join(root, "instance-b", "FreeCAD"),
  ];
  const discovered = `p${application.pid}\nf21\nn${sockets[0]}\nf22\nn${sockets[0]}\nf23\nn${sockets[1]}\nn${join(root, "FreeCAD-other")}\nnrelative/FreeCAD\n`;
  const run = vi
    .fn<(command: CadGuiTransportCommand) => Promise<string>>()
    .mockResolvedValueOnce(discovered)
    .mockResolvedValueOnce('{"ok":true,"actionSent":true}');
  return { root, application, python, macroPath, context, sockets, run };
}

test("固定 lsof 发现候选，验证 bundle Python 后隔离执行固定脚本，协议缓冲不受模型预览截断", async () => {
  const f = await fixture();
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await transport.send(f.application, f.macroPath, {
    ...f.context,
    maxOutputBytes: 1,
  });
  expect(f.run).toHaveBeenCalledTimes(2);
  const discovery = f.run.mock.calls[0]?.[0];
  const delivery = f.run.mock.calls[1]?.[0];
  if (!discovery || !delivery) throw new Error("缺少固定发现/发送调用");
  expect(discovery.executable).toBe("/usr/sbin/lsof");
  expect(discovery.args).toEqual([
    "-a",
    "-p",
    String(f.application.pid),
    "-U",
    "-Fn",
  ]);
  expect(discovery.maxOutputBytes).toBeGreaterThan(1024);
  expect(delivery.executable).toBe(await realpath(f.python));
  expect(delivery.args.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
  expect(delivery.args).toHaveLength(5);
  expect(delivery.args.join(" ")).not.toContain(f.macroPath);
  expect(JSON.parse(delivery.stdin ?? "")).toMatchObject({
    application: f.application,
    macroPath: f.macroPath,
    socketPaths: f.sockets,
  });
  expect(JSON.parse(delivery.stdin ?? "")).not.toHaveProperty("pid");
  expect(delivery.maxOutputBytes).toBeGreaterThan(1024);
});

test("不支持的平台不会发现 socket、启动 Python 或启动 GUI", async () => {
  const f = await fixture();
  const transport = createMacosCadGuiTransport({
    platform: "linux",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "not_supported", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test("Python 软链逃出已验证的 bundle 时拒绝，不能改用 PATH", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside-python");
  await writeFile(outside, "never executed\n", { mode: 0o755 });
  await rm(f.python);
  await symlink(outside, f.python);
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test.each(["directory", "not-executable"])(
  "Python 为 %s 时拒绝发送",
  async (kind) => {
    const f = await fixture();
    if (kind === "directory") {
      await rm(f.python);
      await mkdir(f.python);
    } else await chmod(f.python, 0o644);
    const transport = createMacosCadGuiTransport({
      platform: "darwin",
      run: f.run,
    });
    await expect(
      transport.send(f.application, f.macroPath, f.context),
    ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
    expect(f.run).not.toHaveBeenCalled();
  },
);

test.each([
  "relative.FCMacro",
  "/tmp/query\nOpenFile:other.FCMacro",
  "/tmp/query\0.FCMacro",
])("无效宏路径 %j 不能进入 OpenFile 行协议", async (macroPath) => {
  const f = await fixture();
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, macroPath, f.context),
  ).rejects.toMatchObject({ code: "transport_failed", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test("lsof 没有精确 basename FreeCAD 的绝对 socket 时拒绝，不猜路径", async () => {
  const f = await fixture();
  f.run
    .mockReset()
    .mockResolvedValue(
      `p${f.application.pid}\nn/tmp/FreeCAD-other\nnrelative/FreeCAD\n`,
    );
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "transport_failed", actionSent: false });
  expect(f.run).toHaveBeenCalledTimes(1);
});

test("lsof 响应带另一个 PID 时不接纳候选", async () => {
  const f = await fixture();
  f.run
    .mockReset()
    .mockResolvedValue(`p${f.application.pid + 1}\nn${f.sockets[0]}\n`);
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
  expect(f.run).toHaveBeenCalledTimes(1);
});

test("同一连接的 peer PID 不符时拒绝且不重试", async () => {
  const f = await fixture();
  f.run
    .mockReset()
    .mockResolvedValueOnce(
      `p${f.application.pid}\nn${f.sockets[0]}\nn${f.sockets[1]}\n`,
    )
    .mockResolvedValueOnce(
      '{"ok":false,"actionSent":false,"code":"peer_mismatch"}',
    );
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
  expect(f.run).toHaveBeenCalledTimes(2);
});

test.each([
  "not JSON",
  '{"ok":true,"actionSent":false}',
  '{"ok":true,"actionSent":true,"extra":"untrusted"}',
])("Python 无可信回执 %j 时保留未知送达状态", async (output) => {
  const f = await fixture();
  f.run
    .mockReset()
    .mockResolvedValueOnce(`p${f.application.pid}\nn${f.sockets[0]}\n`)
    .mockResolvedValueOnce(output);
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "transport_failed", actionSent: undefined });
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("可能发送后失败不重试，即使还有其它 socket 候选", async () => {
  const f = await fixture();
  f.run
    .mockReset()
    .mockResolvedValueOnce(
      `p${f.application.pid}\nn${f.sockets[0]}\nn${f.sockets[1]}\n`,
    )
    .mockResolvedValueOnce(
      '{"ok":false,"actionSent":null,"code":"send_failed"}',
    );
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "transport_failed", actionSent: undefined });
  expect(f.run).toHaveBeenCalledTimes(2);
});

test("调用前已经取消时不执行 helper", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort(new Error("private cancellation reason"));
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, {
      ...f.context,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ code: "transport_failed", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test("Python 已启动时取消等待自己的 helper 收束，送达状态保持未知", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const started = deferred();
  const cleanup = deferred();
  f.run
    .mockReset()
    .mockResolvedValueOnce(`p${f.application.pid}\nn${f.sockets[0]}\n`)
    .mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            void cleanup.promise.then(() =>
              reject(new Error("private helper stderr")),
            );
          },
          { once: true },
        );
      });
      return "";
    });
  let settled = false;
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  const sending = transport.send(f.application, f.macroPath, {
    ...f.context,
    signal: abort.signal,
  });
  const outcome = sending.catch((error: unknown) => {
    settled = true;
    return error;
  });
  await Promise.race([started.promise, sending]);
  abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  cleanup.resolve();
  expect(await outcome).toMatchObject({
    code: "transport_failed",
    actionSent: undefined,
  });
});

test("总超时取消自己的 helper，不把底层 stderr 或私有参数放进错误", async () => {
  const f = await fixture();
  const started = deferred();
  f.run
    .mockReset()
    .mockResolvedValueOnce(`p${f.application.pid}\nn${f.sockets[0]}\n`)
    .mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE_STDERR ENV_SECRET")),
          { once: true },
        );
      });
    });
  vi.useFakeTimers();
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  const sending = transport.send(f.application, f.macroPath, {
    ...f.context,
    timeoutMs: 100,
  });
  const outcome = sending.catch((error: unknown) => error);
  await Promise.race([started.promise, sending]);
  await vi.advanceTimersByTimeAsync(101);
  const error = await outcome;
  expect(error).toBeInstanceOf(CadGuiTransportError);
  expect(error).toMatchObject({
    code: "transport_failed",
    actionSent: undefined,
  });
  expect(String(error)).not.toMatch(/PRIVATE_STDERR|ENV_SECRET/u);
});

test.each(["discovery", "delivery"])(
  "%s runner 错误不泄露 stderr/env，动作状态按阶段区分",
  async (stage) => {
    const f = await fixture();
    f.run.mockReset();
    if (stage === "delivery")
      f.run.mockResolvedValueOnce(`p${f.application.pid}\nn${f.sockets[0]}\n`);
    f.run.mockRejectedValueOnce(
      new Error(`PRIVATE_STDERR ${f.macroPath} ENV_SECRET`),
    );
    const transport = createMacosCadGuiTransport({
      platform: "darwin",
      run: f.run,
    });
    const error = await transport
      .send(f.application, f.macroPath, f.context)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "transport_failed",
      actionSent: stage === "delivery" ? undefined : false,
    });
    expect(String(error)).not.toMatch(
      /PRIVATE_STDERR|ENV_SECRET|query\.FCMacro/u,
    );
  },
);

test("缺少精确 birth 时在启动任何 helper 前拒绝，不从 launchDate 推算", async () => {
  const f = await fixture();
  Reflect.deleteProperty(f.application, "birth");
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test.each([
  null,
  { startSeconds: 0, startMicroseconds: 0 },
  { startSeconds: Number.MAX_SAFE_INTEGER + 1, startMicroseconds: 0 },
  { startSeconds: 1700000000, startMicroseconds: -1 },
  { startSeconds: 1700000000, startMicroseconds: 1_000_000 },
  { startSeconds: 1700000000, startMicroseconds: 0.25 },
])("非法 birth %j 不能启动 helper", async (birth) => {
  const f = await fixture();
  Reflect.set(f.application, "birth", birth);
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  await expect(
    transport.send(f.application, f.macroPath, f.context),
  ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
  expect(f.run).not.toHaveBeenCalled();
});

test("等待 socket 发现时调用方修改原对象，不改变已接纳的完整出生身份", async () => {
  const f = await fixture();
  const original = structuredClone(f.application);
  const discovering = deferred();
  const releaseDiscovery = deferred();
  f.run
    .mockReset()
    .mockImplementationOnce(async () => {
      discovering.resolve();
      await releaseDiscovery.promise;
      return `p${original.pid}\nn${f.sockets[0]}\n`;
    })
    .mockResolvedValueOnce('{"ok":true,"actionSent":true}');
  const transport = createMacosCadGuiTransport({
    platform: "darwin",
    run: f.run,
  });
  const sending = transport.send(f.application, f.macroPath, f.context);
  const outcome = sending.then(
    () => ({ sent: true }),
    (error: unknown) => error,
  );
  await Promise.race([discovering.promise, sending]);
  f.application.pid++;
  f.application.birth.startMicroseconds++;
  f.application.executablePath = join(f.root, "replacement");
  releaseDiscovery.resolve();
  expect(await outcome).toEqual({ sent: true });
  const delivery = f.run.mock.calls[1]?.[0];
  if (!delivery) throw new Error("未进入固定发送 helper");
  expect(JSON.parse(delivery.stdin ?? "").application).toEqual(original);
});

test.each(["identity_changed", "identity_unavailable"])(
  "发送前 %s 明确拒绝，不能降格为未知送达",
  async (code) => {
    const f = await fixture();
    f.run
      .mockReset()
      .mockResolvedValueOnce(`p${f.application.pid}\nn${f.sockets[0]}\n`)
      .mockResolvedValueOnce(
        JSON.stringify({ ok: false, actionSent: false, code }),
      );
    const transport = createMacosCadGuiTransport({
      platform: "darwin",
      run: f.run,
    });
    await expect(
      transport.send(f.application, f.macroPath, f.context),
    ).rejects.toMatchObject({ code: "application_changed", actionSent: false });
    expect(f.run).toHaveBeenCalledTimes(2);
  },
);

// 只运行固定客户端源码的受控行为夹具：所有 socket/libproc 操作为内存替身。
// 不连接任何真实 socket，不读取或操作 FreeCAD GUI；缺少测试解释器时不冒充通过。
const python = "/Applications/FreeCAD.app/Contents/Resources/bin/python";
const sourceTest = baseTest.skipIf(
  process.platform !== "darwin" || !existsSync(python),
);
const CLIENT_BEHAVIOR_HARNESS = String.raw`
import ctypes, io, json, os, socket, stat, struct, sys, types
input_data = json.loads(sys.stdin.buffer.read())
scenario = input_data['scenario']
request = input_data['request']
sent = []
connected = []
birth_reads = []
expected = request['application']

class Function:
    def __init__(self, action): self.action = action
    def __call__(self, *args): return self.action(*args)

def info(pid, flavor, arg, pointer, size):
    value = pointer._obj
    value.pbi_pid = pid
    value.pbi_status = scenario.get('status', 2)
    birth = scenario.get('birth', expected['birth'])
    value.pbi_start_tvsec = birth['startSeconds']
    value.pbi_start_tvusec = birth['startMicroseconds']
    birth_reads.append(bool(connected))
    return size

def path(pid, buffer, size):
    data = scenario.get('executablePath', expected['executablePath']).encode()
    ctypes.memmove(buffer, data + b'\0', len(data) + 1)
    return len(data)

libproc = types.SimpleNamespace(proc_pidinfo=Function(info), proc_pidpath=Function(path))
ctypes.CDLL = lambda *args, **kwargs: libproc
os.lstat = lambda path, **kwargs: types.SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=os.getuid(), st_dev=1, st_ino=1)

class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, path): connected.append(path)
    def getsockopt(self, *args): return struct.pack('=i', expected['pid'])
    def sendall(self, data): sent.append(data.decode())

socket.socket = lambda *args, **kwargs: Connection()
sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
captured = io.StringIO()
sys.stdout = captured
exec(compile(input_data['source'], '<fixed-cad-client>', 'exec'), {})
sys.__stdout__.write(json.dumps({'reply':json.loads(captured.getvalue()),'sent':sent,'birthReadsAfterConnect':birth_reads}))
`;

sourceTest.each([
  {
    name: "相同PID但出生相差1微秒",
    scenario: {
      birth: { startSeconds: 1700000000, startMicroseconds: 123457 },
    },
    code: "identity_changed",
  },
  {
    name: "同出生但可执行文件不同",
    scenario: { executablePath: "/fixture/replaced-executable" },
    code: "identity_changed",
  },
  {
    name: "暂停进程不签发活动身份",
    scenario: { status: 4 },
    code: "identity_unavailable",
  },
])("固定客户端$name时发送零字节", async ({ scenario, code }) => {
  const f = await fixture();
  const output = await runCadGuiNativeCommand({
    executable: python,
    args: ["-I", "-S", "-B", "-c", CLIENT_BEHAVIOR_HARNESS],
    stdin: JSON.stringify({
      source: FREECAD_GUI_TRANSPORT_SOURCE,
      scenario,
      request: {
        application: f.application,
        macroPath: f.macroPath,
        socketPaths: f.sockets,
        timeoutMs: 1000,
      },
    }),
    signal: AbortSignal.timeout(5000),
    timeoutMs: 5000,
    maxOutputBytes: 16384,
  });
  const result = JSON.parse(output);
  expect(result.reply).toEqual({ ok: false, actionSent: false, code });
  expect(result.sent).toEqual([]);
  expect(result.birthReadsAfterConnect.length).toBeGreaterThan(0);
  expect(result.birthReadsAfterConnect.every((after: boolean) => after)).toBe(
    true,
  );
});

sourceTest(
  "固定客户端仅在同连接精确出生和可执行路径均匹配后发送一次",
  async () => {
    const f = await fixture();
    const output = await runCadGuiNativeCommand({
      executable: python,
      args: ["-I", "-S", "-B", "-c", CLIENT_BEHAVIOR_HARNESS],
      stdin: JSON.stringify({
        source: FREECAD_GUI_TRANSPORT_SOURCE,
        scenario: {},
        request: {
          application: f.application,
          macroPath: f.macroPath,
          socketPaths: f.sockets,
          timeoutMs: 1000,
        },
      }),
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
      maxOutputBytes: 16384,
    });
    const result = JSON.parse(output);
    expect(result.reply).toEqual({ ok: true, actionSent: true });
    expect(result.sent).toEqual([`OpenFile:${f.macroPath}\n`]);
    expect(result.birthReadsAfterConnect.length).toBeGreaterThan(0);
    expect(result.birthReadsAfterConnect.every((after: boolean) => after)).toBe(
      true,
    );
  },
);
