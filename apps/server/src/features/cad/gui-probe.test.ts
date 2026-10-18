import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CadGuiApplication,
  type CadGuiProbeContext,
  CadGuiProbeError,
  createMacosCadGuiProbe,
} from "./gui-probe.js";

const bundle = "/Applications/FreeCAD.app";
const volume = "/Volumes/FreeCAD/FreeCAD.app";
const context: CadGuiProbeContext = { timeoutMs: 1_000, maxOutputBytes: 8_192 };

function application(
  pid = 101,
  bundlePath = bundle,
): CadGuiApplication & {
  birth: { startSeconds: number; startMicroseconds: number };
} {
  return {
    pid,
    bundleId: "org.freecad.FreeCAD",
    name: "FreeCAD",
    executablePath: `${bundlePath}/Contents/Resources/bin/freecad`,
    bundlePath,
    launchedAt: 1_760_000_000_123.25,
    birth: { startSeconds: 1_760_000_000, startMicroseconds: 174_553 },
  };
}

function snapshot(app = application()) {
  const { birth: _birth, ...registered } = app;
  return {
    ...registered,
    activationPolicy: 0,
    bundleIdentifier: "org.freecad.FreeCAD",
    bundleExecutablePath: `${app.bundlePath}/Contents/MacOS/FreeCAD`,
  };
}

function status(path: string) {
  const directory = path.endsWith(".app");
  return {
    isDirectory: () => directory,
    isFile: () => !directory,
    mode: directory ? 0o40755 : 0o100755,
  };
}

function fixture(rows: unknown = [snapshot()]) {
  const run = vi.fn(
    async (
      _script: string,
      _timeoutMs: number,
      _signal?: AbortSignal,
      _maxOutputBytes?: number,
    ): Promise<unknown> => rows,
  );
  const resolvePath = vi.fn(async (path: string) => path);
  const readStatus = vi.fn(async (path: string) => status(path));
  const readAccess = vi.fn(async (_path: string, _mode: number) => {});
  const readIdentity = vi.fn(
    async (app: { pid: number; bundlePath: string }) => ({
      birth: application(app.pid, app.bundlePath).birth,
      executablePath: (Array.isArray(rows) ? rows : [])
        .find((row) => row?.pid === app.pid)
        ?.executablePath.replace("/Applications/FreeCAD Alias.app", volume),
    }),
  );
  const probe = createMacosCadGuiProbe({
    platform: "darwin",
    run,
    realpath: resolvePath,
    stat: readStatus,
    access: readAccess,
    readIdentity,
  });
  return { probe, run, resolvePath, readStatus, readAccess, readIdentity };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FreeCAD 只读 GUI 应用探针", () => {
  it("两个安装和同 bundleId 的运行实例保持独立身份", async () => {
    const first = application(101, bundle);
    const second = application(202, volume);
    const f = fixture([snapshot(first), snapshot(second)]);
    expect(await f.probe.list(context)).toEqual([first, second]);
    expect(await f.probe.verify(second, context)).toEqual(second);
    expect(f.run).toHaveBeenCalledTimes(2);
    const call = f.run.mock.calls[0];
    expect(call?.[1]).toBe(context.timeoutMs);
    expect(call?.[2]?.aborted).toBe(false);
    expect(call?.[3]).toBe(context.maxOutputBytes);
  });

  it("接受官方 GUI 启动器与内部 GUI bin 两种真实入口", async () => {
    const internal = application();
    const launcher = {
      ...application(202),
      executablePath: `${bundle}/Contents/MacOS/FreeCAD`,
    };
    const f = fixture([snapshot(internal), snapshot(launcher)]);
    expect(await f.probe.list(context)).toEqual([internal, launcher]);
  });

  it("只返回实际观察到的安装，空枚举不制造默认安装进程", async () => {
    const f = fixture([]);
    expect(await f.probe.list(context)).toEqual([]);
    expect(f.resolvePath).not.toHaveBeenCalled();
    expect(f.readStatus).not.toHaveBeenCalled();
    await expect(f.probe.verify(application(), context)).rejects.toMatchObject({
      code: "application_changed",
    });
  });

  it("返回 realpath 规范路径并保留精确启动时间", async () => {
    const alias = "/Applications/FreeCAD Alias.app";
    const f = fixture([snapshot(application(101, alias))]);
    f.resolvePath.mockImplementation(async (path) =>
      path.replace(alias, volume),
    );
    expect(await f.probe.list(context)).toEqual([application(101, volume)]);
  });

  it("名称变化不改变 PID、启动时间和安装路径组成的身份", async () => {
    const app = application();
    const renamed = { ...app, name: "FreeCAD 工程" };
    const f = fixture([snapshot(renamed)]);
    expect(await f.probe.verify(app, context)).toEqual(renamed);
  });

  it("启动时间仅作NS登记事实，内核出生身份独立签发且不能由NSDate换算", async () => {
    const f = fixture();
    const [actual] = await f.probe.list(context);
    expect(f.readIdentity).toHaveBeenCalledOnce();
    expect(actual?.birth).toEqual(application().birth);
    expect(actual?.launchedAt).toBe(application().launchedAt);
    expect(actual?.birth.startMicroseconds).not.toBe(
      (application().launchedAt % 1000) * 1000,
    );
  });

  it("NS登记未变化但同PID出生身份变化时拒绝旧绑定", async () => {
    const f = fixture();
    f.readIdentity.mockResolvedValue({
      birth: { ...application().birth, startMicroseconds: 174_554 },
      executablePath: application().executablePath,
    });
    await expect(f.probe.verify(application(), context)).rejects.toMatchObject({
      code: "application_changed",
    });
  });

  it("内核可执行路径与NS登记不符或身份读取失败时不签发应用", async () => {
    const f = fixture();
    f.readIdentity.mockResolvedValue({
      birth: application().birth,
      executablePath: "/tmp/other-executable",
    });
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
    f.readIdentity.mockRejectedValue(
      new Error("private identity read failure"),
    );
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it.each([
    { name: "PID复用", change: { launchedAt: 1_760_000_001_123.25 } },
    { name: "PID替换", change: { pid: 999 } },
    {
      name: "GUI可执行文件变化",
      change: { executablePath: `${bundle}/Contents/MacOS/FreeCAD` },
    },
  ])("拒绝已有绑定的$name", async ({ change }) => {
    const app = application();
    const f = fixture([snapshot({ ...app, ...change })]);
    await expect(f.probe.verify(app, context)).rejects.toMatchObject({
      code: "application_changed",
    });
  });

  it("同 PID/启动时间迁移到另一个安装不能沿用旧绑定", async () => {
    const f = fixture([snapshot(application(101, volume))]);
    f.resolvePath.mockImplementation(async (path) =>
      path.replace(bundle, volume),
    );
    await expect(f.probe.verify(application(), context)).rejects.toMatchObject({
      code: "application_changed",
    });
  });

  it.each([
    "Contents/Resources/bin/freecadcmd",
    "Contents/Resources/bin/FreeCADCmd",
    "Contents/Resources/bin/python",
    "Contents/MacOS/Helper",
  ])("不把%s冒充 GUI 可执行文件", async (relativePath) => {
    const f = fixture([
      snapshot({
        ...application(),
        executablePath: `${bundle}/${relativePath}`,
      }),
    ]);
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it("拒绝可执行文件逃出 bundle 及相似目录前缀", async () => {
    for (const executablePath of [
      "/tmp/freecad",
      `${bundle}-other/Contents/Resources/bin/freecad`,
    ]) {
      const f = fixture([snapshot({ ...application(), executablePath })]);
      await expect(f.probe.list(context)).rejects.toMatchObject({
        code: "probe_failed",
      });
    }
  });

  it("拒绝 realpath 后逃出安装根的符号链接", async () => {
    const f = fixture();
    f.resolvePath.mockImplementation(async (path) =>
      path.endsWith("/Resources/bin/freecad") ? "/tmp/freecad" : path,
    );
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it("NSBundle 主程序必须属于同一安装的 GUI 启动器", async () => {
    const f = fixture([
      {
        ...snapshot(),
        bundleExecutablePath: `${volume}/Contents/MacOS/FreeCAD`,
      },
    ]);
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it.each(["bundle", "runtime", "launcher"])(
    "拒绝不可用的安装路径：%s",
    async (target) => {
      const f = fixture();
      f.readStatus.mockImplementation(async (path) => {
        if (target === "bundle" && path === bundle)
          return {
            isDirectory: () => false,
            isFile: () => true,
            mode: 0o100755,
          };
        if (
          (target === "runtime" && path.endsWith("/Resources/bin/freecad")) ||
          (target === "launcher" && path.endsWith("/MacOS/FreeCAD"))
        )
          return {
            isDirectory: () => false,
            isFile: () => true,
            mode: 0o100644,
          };
        return status(path);
      });
      await expect(f.probe.list(context)).rejects.toMatchObject({
        code: "probe_failed",
      });
    },
  );

  it.each(
    [
      null,
      "[]",
      {},
      [null],
      [{ ...snapshot(), pid: 0 }],
      [{ ...snapshot(), launchedAt: 0 }],
      [{ ...snapshot(), launchedAt: Number.NaN }],
      [{ ...snapshot(), bundleId: "other.app" }],
      [{ ...snapshot(), activationPolicy: 2 }],
      [{ ...snapshot(), bundleIdentifier: "other.app" }],
      [{ ...snapshot(), executablePath: "relative/freecad" }],
      [{ ...snapshot(), bundleExecutablePath: undefined }],
    ].map((raw) => ({ raw })),
  )("异常应用数据明确失败：%j", async ({ raw }) => {
    const f = fixture(raw);
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
    expect(f.resolvePath).not.toHaveBeenCalled();
  });

  it("真实 X_OK 检查失败时不返回 GUI 绑定", async () => {
    const f = fixture();
    f.readAccess.mockRejectedValue(new Error("EACCES"));
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it("重复 PID 是歧义数据而不是挑选第一项", async () => {
    const f = fixture([snapshot(), snapshot(application(101, volume))]);
    await expect(f.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
    expect(f.resolvePath).not.toHaveBeenCalled();
  });

  it("桥和文件读取失败保留受控错误，不返回空枚举", async () => {
    const bridge = fixture();
    bridge.run.mockRejectedValue(new Error("bridge details"));
    await expect(bridge.probe.list(context)).rejects.toBeInstanceOf(
      CadGuiProbeError,
    );
    const files = fixture();
    files.resolvePath.mockRejectedValue(new Error("ENOENT"));
    await expect(files.probe.list(context)).rejects.toMatchObject({
      code: "probe_failed",
    });
  });

  it("已取消时不派发桥或文件查询", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    await expect(
      f.probe.list({ ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      f.probe.verify(application(), { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.resolvePath).not.toHaveBeenCalled();
  });

  it("进行中的取消保留 AbortError，并传给桥的 signal", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.run.mockImplementation(() => new Promise(() => {}));
    const pending = f.probe.list({ ...context, signal: controller.signal });
    const outcome = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    controller.abort();
    await outcome;
    expect(f.run.mock.calls[0]?.[2]?.aborted).toBe(true);
  });

  it.each(["bridge", "filesystem"])(
    "超时覆盖整个%s阶段并停止接受迟到结果",
    async (target) => {
      vi.useFakeTimers();
      const f = fixture();
      if (target === "bridge")
        f.run.mockImplementation(() => new Promise(() => {}));
      else f.resolvePath.mockImplementation(() => new Promise(() => {}));
      const pending = f.probe.list({ ...context, timeoutMs: 25 });
      const outcome = expect(pending).rejects.toMatchObject({
        name: "CadGuiProbeError",
        code: "probe_failed",
        message: "FreeCAD 应用查询超时，请重试",
      });
      await vi.advanceTimersByTimeAsync(25);
      await outcome;
      expect(f.run.mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { ...context, timeoutMs: 0 },
    { ...context, timeoutMs: Number.NaN },
    { ...context, maxOutputBytes: 0 },
  ])("无效查询限制不派发：%j", async (limits) => {
    const f = fixture();
    await expect(f.probe.list(limits)).rejects.toMatchObject({
      code: "probe_failed",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("非 mac 平台可装配，但调用明确不支持", async () => {
    const run = vi.fn(async () => []);
    const probe = createMacosCadGuiProbe({ platform: "linux", run });
    await expect(probe.list(context)).rejects.toMatchObject({
      code: "not_supported",
    });
    await expect(probe.verify(application(), context)).rejects.toMatchObject({
      code: "not_supported",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
