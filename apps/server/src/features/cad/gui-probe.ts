import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { runJxa } from "../computer-use/jxa.js";
import {
  cadGuiApplicationSchema as applicationSchema,
  type CadGuiApplication,
  cadGuiProcessBirthSchema,
} from "./gui-document-contracts.js";
import { readCadGuiProcessIdentity } from "./gui-native.js";

export type { CadGuiApplication } from "./gui-document-contracts.js";

export interface CadGuiProbeContext {
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CadGuiProbe {
  list(context: CadGuiProbeContext): Promise<CadGuiApplication[]>;
  verify(
    binding: CadGuiApplication,
    context: CadGuiProbeContext,
  ): Promise<CadGuiApplication>;
}

export class CadGuiProbeError extends Error {
  constructor(
    readonly code: "not_supported" | "application_changed" | "probe_failed",
    message: string,
  ) {
    super(message);
    this.name = "CadGuiProbeError";
  }
}

type FileStatus = Pick<Stats, "isDirectory" | "isFile" | "mode">;
export interface CadGuiProbeOptions {
  platform?: NodeJS.Platform;
  run?: typeof runJxa;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<FileStatus>;
  access?: (path: string, mode: number) => Promise<void>;
  readIdentity?: (
    application: Pick<CadGuiApplication, "pid" | "bundlePath">,
    context: CadGuiProbeContext,
  ) => Promise<{
    birth: CadGuiApplication["birth"];
    executablePath: string;
  }>;
}

const absolutePath = z.string().min(1).refine(posix.isAbsolute);
const snapshotSchema = z.array(
  applicationSchema
    .omit({ birth: true })
    .extend({
      activationPolicy: z.literal(0),
      bundleIdentifier: z.literal("org.freecad.FreeCAD"),
      bundleExecutablePath: absolutePath,
    })
    .strict(),
);
type ApplicationSnapshot = z.infer<typeof snapshotSchema>[number];

// 固定可信脚本：只读 NSWorkspace/NSBundle，不读取 AX、不激活或启动应用。
const LIST_APPLICATIONS_SCRIPT = `
ObjC.import('AppKit');
const running = $.NSWorkspace.sharedWorkspace.runningApplications;
const applications = [];
for (let index = 0; index < Number(running.count); index++) {
  const app = running.objectAtIndex(index);
  const bundleId = ObjC.unwrap(app.bundleIdentifier);
  const activationPolicy = Number(app.activationPolicy);
  if (bundleId !== 'org.freecad.FreeCAD' || activationPolicy !== 0) continue;
  const bundle = $.NSBundle.bundleWithURL(app.bundleURL);
  applications.push({
    pid: Number(app.processIdentifier),
    bundleId,
    name: ObjC.unwrap(app.localizedName) || '',
    executablePath: ObjC.unwrap(app.executableURL.path),
    bundlePath: ObjC.unwrap(app.bundleURL.path),
    launchedAt: Number(app.launchDate.timeIntervalSince1970) * 1000,
    activationPolicy,
    bundleIdentifier: ObjC.unwrap(bundle.bundleIdentifier),
    bundleExecutablePath: ObjC.unwrap(bundle.executableURL.path),
  });
}
JSON.stringify(applications);
`;

function cancelled(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error && signal.reason.name === "AbortError")
    return signal.reason;
  return new DOMException("FreeCAD 应用查询已取消", "AbortError");
}

async function withDeadline<T>(
  context: CadGuiProbeContext,
  operation: (context: CadGuiProbeContext) => Promise<T>,
): Promise<T> {
  if (context.signal?.aborted) throw cancelled(context.signal);
  if (
    !Number.isSafeInteger(context.timeoutMs) ||
    context.timeoutMs <= 0 ||
    context.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(context.maxOutputBytes) ||
    context.maxOutputBytes <= 0
  ) {
    throw new CadGuiProbeError("probe_failed", "FreeCAD 应用查询限制无效");
  }
  const controller = new AbortController();
  let timedOut = false;
  let interrupt = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", interrupt, { once: true });
  });
  const abort = () => controller.abort(cancelled(context.signal));
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new CadGuiProbeError("probe_failed", "FreeCAD 应用查询超时，请重试"),
    );
  }, context.timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation({ ...context, signal: controller.signal });
      }),
      interrupted,
    ]);
  } catch (error) {
    if (context.signal?.aborted) throw cancelled(context.signal);
    if (timedOut)
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCAD 应用查询超时，请重试",
      );
    if (error instanceof CadGuiProbeError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new CadGuiProbeError("probe_failed", "无法读取 FreeCAD 运行应用信息");
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", interrupt);
  }
}

function insideBundle(bundlePath: string, executablePath: string): boolean {
  const relative = posix.relative(bundlePath, executablePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}

/** 只观察实际运行的 GUI 实例；安装位置与 bundleId 均不能单独构成绑定。 */
export function createMacosCadGuiProbe(
  options: CadGuiProbeOptions = {},
): CadGuiProbe {
  const platform = options.platform ?? process.platform;
  function requireSupported() {
    if (platform !== "darwin")
      throw new CadGuiProbeError(
        "not_supported",
        "当前系统不支持 FreeCAD 应用查询",
      );
  }
  const run = options.run ?? runJxa;
  const resolvePath = options.realpath ?? realpath;
  const readStatus = options.stat ?? stat;
  const readAccess = options.access ?? access;
  const readIdentity = options.readIdentity ?? readCadGuiProcessIdentity;

  async function normalize(
    snapshot: ApplicationSnapshot,
    context: CadGuiProbeContext,
  ): Promise<CadGuiApplication> {
    context.signal?.throwIfAborted();
    const [bundlePath, executablePath, bundleExecutablePath] =
      await Promise.all([
        resolvePath(snapshot.bundlePath),
        resolvePath(snapshot.executablePath),
        resolvePath(snapshot.bundleExecutablePath),
      ]);
    context.signal?.throwIfAborted();
    if (
      !posix.isAbsolute(bundlePath) ||
      !insideBundle(bundlePath, executablePath) ||
      !insideBundle(bundlePath, bundleExecutablePath)
    )
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCAD 可执行文件不属于该安装目录",
      );

    const launcher = await resolvePath(
      posix.join(bundlePath, "Contents/MacOS/FreeCAD"),
    );
    if (bundleExecutablePath !== launcher)
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCAD 应用主程序与安装目录不符",
      );
    // 官方 macOS 包的主程序是启动器；实际 GUI 可运行 bundle 内的 freecad。
    if (
      executablePath !== launcher &&
      executablePath !==
        (await resolvePath(
          posix.join(bundlePath, "Contents/Resources/bin/freecad"),
        ))
    )
      throw new CadGuiProbeError(
        "probe_failed",
        "运行进程不是该安装的 FreeCAD GUI 程序",
      );
    if (posix.basename(executablePath).toLowerCase() === "freecadcmd")
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCADCmd 不能作为 GUI 应用绑定",
      );
    const [bundleStatus, executableStatus, launcherStatus] = await Promise.all([
      readStatus(bundlePath),
      readStatus(executablePath),
      readStatus(launcher),
    ]);
    context.signal?.throwIfAborted();
    if (
      !bundleStatus.isDirectory() ||
      !executableStatus.isFile() ||
      (executableStatus.mode & 0o111) === 0 ||
      !launcherStatus.isFile() ||
      (launcherStatus.mode & 0o111) === 0
    )
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCAD 安装目录或可执行文件不可用",
      );
    await Promise.all([
      readAccess(executablePath, constants.X_OK),
      readAccess(launcher, constants.X_OK),
    ]);
    context.signal?.throwIfAborted();
    const identity = z
      .object({
        birth: cadGuiProcessBirthSchema,
        executablePath: absolutePath,
      })
      .strict()
      .parse(await readIdentity({ pid: snapshot.pid, bundlePath }, context));
    if ((await resolvePath(identity.executablePath)) !== executablePath)
      throw new CadGuiProbeError(
        "probe_failed",
        "FreeCAD 内核进程与应用登记不符，请重新查询",
      );
    context.signal?.throwIfAborted();
    return {
      pid: snapshot.pid,
      bundleId: snapshot.bundleId,
      name: snapshot.name,
      executablePath,
      bundlePath,
      launchedAt: snapshot.launchedAt,
      birth: identity.birth,
    };
  }

  async function list(
    context: CadGuiProbeContext,
  ): Promise<CadGuiApplication[]> {
    requireSupported();
    return withDeadline(context, async (active) => {
      const raw = await run(
        LIST_APPLICATIONS_SCRIPT,
        active.timeoutMs,
        active.signal,
        active.maxOutputBytes,
      );
      active.signal?.throwIfAborted();
      const parsed = snapshotSchema.safeParse(raw);
      if (!parsed.success)
        throw new CadGuiProbeError(
          "probe_failed",
          "FreeCAD 应用信息不完整或无效",
        );
      const pids = new Set<number>();
      for (const app of parsed.data) {
        if (pids.has(app.pid))
          throw new CadGuiProbeError(
            "probe_failed",
            "FreeCAD 应用信息包含重复进程",
          );
        pids.add(app.pid);
      }
      return Promise.all(parsed.data.map((app) => normalize(app, active)));
    });
  }

  return {
    list,
    async verify(binding, context) {
      requireSupported();
      if (context.signal?.aborted) throw cancelled(context.signal);
      const parsed = applicationSchema.safeParse(binding);
      if (!parsed.success)
        throw new CadGuiProbeError(
          "application_changed",
          "FreeCAD 应用绑定无效，请重新查询",
        );
      const expected = parsed.data;
      const application = (await list(context)).find(
        (app) => app.pid === expected.pid,
      );
      // 绑定已保存 list 返回的 realpath；不重新解析旧路径以悄悄迁移原身份。
      if (
        !application ||
        application.launchedAt !== expected.launchedAt ||
        application.birth.startSeconds !== expected.birth.startSeconds ||
        application.birth.startMicroseconds !==
          expected.birth.startMicroseconds ||
        application.bundleId !== expected.bundleId ||
        application.executablePath !== expected.executablePath ||
        application.bundlePath !== expected.bundlePath
      )
        throw new CadGuiProbeError(
          "application_changed",
          "FreeCAD 应用已退出或发生变化，请重新查询",
        );
      return application;
    },
  };
}
