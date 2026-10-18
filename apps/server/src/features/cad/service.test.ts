import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ProcessSandbox,
  ProcessStdioSpawnRequest,
  TerminalOutputListener,
} from "../process-sandbox/types.js";
import { createCadBundleGate } from "./plugin.js";
import { createCadService } from "./service.js";
import {
  cadTestExit,
  cadTestLimits,
  createCadTestContext,
  executeCadTestTool,
} from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(options?: {
  gate?:
    | { ok: boolean; message?: string }
    | (() => Promise<{ ok: boolean; message?: string }>);
  data?: unknown;
  maxOutputBytes?: number;
  mode?:
    | "success"
    | "silent"
    | "invalid-json"
    | "wrong-id"
    | "failed"
    | "cancel"
    | "stop-unconfirmed"
    | "unconfirmed";
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-cad-unit-")));
  roots.push(root);
  const task = await createCadTestContext(root);
  const lifecycle: string[] = [];
  const stdoutDisposer = vi.fn(() => lifecycle.push("stdout-disposed"));
  const stderrDisposer = vi.fn(() => lifecycle.push("stderr-disposed"));
  const stop = vi.fn(async () => ({ ...cadTestExit, stopped: true }));
  const spawn = vi.fn(async (request: ProcessStdioSpawnRequest) => {
    const input = JSON.parse(
      await readFile(request.env?.KFW_CAD_REQUEST ?? "", "utf8"),
    );
    let completion!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      completion = resolve;
    });
    stop.mockImplementation(async () => {
      completion();
      return {
        ...cadTestExit,
        stopped: true,
        rangeEmpty: options?.mode !== "stop-unconfirmed",
      };
    });
    if (options?.mode === "cancel" || options?.mode === "stop-unconfirmed")
      task.controller.abort();
    let stdout: TerminalOutputListener | undefined;
    let stderr: TerminalOutputListener | undefined;
    return {
      id: "cad-process",
      onStdout(listener: TerminalOutputListener) {
        lifecycle.push("stdout-attached");
        stdout = listener;
        return stdoutDisposer;
      },
      onStderr(listener: TerminalOutputListener) {
        lifecycle.push("stderr-attached");
        stderr = listener;
        return stderrDisposer;
      },
      endStdin: vi.fn(async () => {
        lifecycle.push("stdin-ended");
      }),
      stop,
      async waitForExit() {
        lifecycle.push("waiting");
        if (!stdout || !stderr) throw new Error("CAD输出管道没有consumer ACK");
        if (options?.mode !== "silent") {
          await stdout("startup\n", { sequence: 1, offset: 0, nextOffset: 8 });
          await stderr("diagnostic\n", {
            sequence: 1,
            offset: 0,
            nextOffset: 11,
          });
          lifecycle.push("output-acked");
        }
        if (
          options?.mode === "cancel" ||
          options?.mode === "stop-unconfirmed"
        ) {
          await cancelled;
          return { ...cadTestExit, stopped: true };
        }
        if (input.outputPath)
          await writeFile(input.outputPath, "fixture artifact");
        const result = {
          protocol: "kfw-cad/1",
          executionId:
            options?.mode === "wrong-id" ? "old-execution" : input.executionId,
          success: options?.mode !== "failed",
          version: ["1", "1", "4"],
          document: { name: "Model", label: "Model", objects: [] },
          outputPath: input.outputPath,
          ...(options && Object.hasOwn(options, "data")
            ? { data: options.data }
            : {}),
          ...(options?.mode === "failed"
            ? { error: "对象几何为空或无效: Broken" }
            : {}),
        };
        await writeFile(
          request.env?.KFW_CAD_RESULT ?? "",
          options?.mode === "invalid-json"
            ? "FreeCAD noise"
            : JSON.stringify(result),
        );
        return {
          ...cadTestExit,
          exitCode: options?.mode === "failed" ? 1 : 0,
          rangeEmpty: options?.mode !== "unconfirmed",
        };
      },
    };
  });
  const service = createCadService({
    sandbox: { spawnStdio: spawn } as unknown as ProcessSandbox,
    gate: async () => {
      const gate = options?.gate;
      return typeof gate === "function" ? gate() : (gate ?? { ok: true });
    },
    detectRuntime: async () => ({
      executable: "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd",
      runtimeRoot: "/Applications/FreeCAD.app",
    }),
    resolveLimits: async () => ({
      limits: {
        ...cadTestLimits,
        ...(options?.maxOutputBytes
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
      },
      timeoutMs: 30_000,
    }),
  });
  return {
    ...task,
    root,
    service,
    spawn,
    stop,
    lifecycle,
    stdoutDisposer,
    stderrDisposer,
  };
}

describe("官方 CAD Task 执行", () => {
  it("结构化操作完整传递 JSON 并沿用离屏沙箱与结果回执", async () => {
    const data = {
      operations: [{ objectName: "Sketch", fullyConstrained: true }],
    };
    const f = await fixture({ data });
    const tool = createCadTools(f.service).find(
      (item) => item.name === "cad_apply_operations",
    );
    if (!tool) throw new Error("缺少结构化 CAD 工具");
    const args = {
      operations: [
        { kind: "create_body", name: "Body", label: "板" },
        {
          kind: "create_sketch",
          name: "Sketch",
          body: "Body",
          profiles: [
            { kind: "rectangle", name: "Plate", width: 40, height: 20 },
            { kind: "circle", name: "Hole", radius: 3, center: [20, 10] },
          ],
        },
      ],
    };
    const result = await executeCadTestTool(tool, args, f.context);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.data).toEqual(data);
    expect(tool).toMatchObject({
      scope: "shared",
      exposure: "deferred",
      access: "execute",
      approvalReviewKind: "cad-operations",
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const request = f.spawn.mock.calls[0]?.[0];
    expect(request?.env?.QT_QPA_PLATFORM).toBe("offscreen");
    const wire = JSON.parse(
      await readFile(request?.env?.KFW_CAD_REQUEST ?? "", "utf8"),
    );
    expect(wire).toMatchObject({ action: "operations", input: args });
  });

  it.each(["depth", "through_all"])(
    "结构化 Pad、孔草图与 Pocket JSON 原样传入沙箱：%s",
    async (mode) => {
      const data = {
        operations: [{ kind: "create_pocket", objectName: "Pocket", mode }],
      };
      const f = await fixture({ data });
      const tool = createCadTools(f.service).find(
        (item) => item.name === "cad_apply_operations",
      );
      if (!tool) throw new Error("缺少结构化 CAD 工具");
      const args = {
        operations: [
          { kind: "create_body", name: "Body", label: "圆板" },
          {
            kind: "create_sketch",
            name: "BaseProfile",
            body: "Body",
            profiles: [{ kind: "circle", name: "Base", radius: 20 }],
          },
          {
            kind: "create_pad",
            name: "Pad",
            label: "底板",
            body: "Body",
            profile: "BaseProfile",
            length: 10,
          },
          {
            kind: "create_sketch",
            name: "HoleSketch",
            body: "Body",
            supportPad: "Pad",
            profiles: [
              { kind: "circle", name: "Hole", radius: 2, center: [10, 0] },
            ],
          },
          {
            kind: "create_pocket",
            name: "Pocket",
            label: "圆孔",
            body: "Body",
            profile: "HoleSketch",
            mode,
            ...(mode === "depth" ? { depth: 4 } : {}),
          },
          {
            kind: "set_dimension",
            object: "Pad",
            dimension: "length",
            value: 12,
          },
          ...(mode === "depth"
            ? [
                {
                  kind: "set_dimension",
                  object: "Pocket",
                  dimension: "depth",
                  value: 6,
                },
              ]
            : []),
          {
            kind: "set_dimension",
            object: "HoleSketch",
            profile: "Hole",
            dimension: "radius",
            value: 3,
          },
        ],
      };
      const original = structuredClone(args);
      expect(z.fromJSONSchema(tool.parameters).safeParse(args).success).toBe(
        true,
      );
      const result = await executeCadTestTool(tool, args, f.context);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent.data).toEqual(data);
      expect(f.spawn).toHaveBeenCalledOnce();
      const request = f.spawn.mock.calls[0]?.[0];
      const wire = JSON.parse(
        await readFile(request?.env?.KFW_CAD_REQUEST ?? "", "utf8"),
      );
      expect(wire.action).toBe("operations");
      expect(wire.input).toEqual(args);
      expect(args).toEqual(original);
    },
  );

  it("特征操作的无效字段组合在 service 和沙箱派发前拒绝", async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.service, "execute");
    const tool = createCadTools(f.service).find(
      (item) => item.name === "cad_apply_operations",
    );
    if (!tool) throw new Error("缺少结构化 CAD 工具");
    const pad = {
      kind: "create_pad",
      name: "Pad",
      body: "Body",
      profile: "BaseProfile",
      length: 10,
    };
    const pocket = {
      kind: "create_pocket",
      name: "Pocket",
      body: "Body",
      profile: "HoleSketch",
    };
    const operations = [
      {
        kind: "create_sketch",
        name: "HoleSketch",
        supportPad: "Pad",
        profiles: [{ kind: "circle", name: "Hole", radius: 2 }],
      },
      { ...pad, body: undefined },
      { ...pad, profile: undefined },
      { ...pad, length: undefined },
      { ...pad, reversed: true },
      { ...pocket, mode: "depth" },
      { ...pocket, mode: "length", depth: 4 },
      { ...pocket, mode: "through_all", depth: 4 },
      { ...pocket, mode: "through_all", depth: undefined },
      { ...pocket, mode: "through_all", supportPad: "Pad" },
      { ...pocket, mode: "through_all", body: undefined },
      { ...pocket, mode: "through_all", profile: undefined },
      ...["width", "height", "radius"].map((dimension) => ({
        kind: "set_dimension",
        object: "BaseProfile",
        dimension,
        value: 3,
      })),
      ...["length", "depth"].flatMap((dimension) => [
        {
          kind: "set_dimension",
          object: "Pad",
          profile: "Base",
          dimension,
          value: 3,
        },
        {
          kind: "set_dimension",
          object: "Pad",
          profile: undefined,
          dimension,
          value: 3,
        },
      ]),
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].flatMap((value) => [
        { ...pad, length: value },
        { ...pocket, mode: "depth", depth: value },
        { kind: "set_dimension", object: "Pad", dimension: "length", value },
        { kind: "set_dimension", object: "Pocket", dimension: "depth", value },
      ]),
    ];
    for (const operation of operations) {
      expect(
        await tool.execute({ operations: [operation] }, f.context),
        JSON.stringify(operation),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    const discoverySchema = z.fromJSONSchema(tool.parameters);
    for (const operation of [
      { ...pocket, mode: "depth" },
      { ...pocket, mode: "through_all", depth: 4 },
      { ...pocket, mode: "through_all", supportPad: "Pad" },
      {
        kind: "set_dimension",
        object: "BaseProfile",
        dimension: "width",
        value: 40,
      },
      {
        kind: "set_dimension",
        object: "Pad",
        profile: "Base",
        dimension: "length",
        value: 12,
      },
    ]) {
      expect(
        discoverySchema.safeParse({ operations: [operation] }).success,
        JSON.stringify(operation),
      ).toBe(false);
    }
  });

  it("结构化操作拒绝空批次、重复轮廓、无效尺寸、未知操作和权限注入", async () => {
    const f = await fixture();
    const tool = createCadTools(f.service).find(
      (item) => item.name === "cad_apply_operations",
    );
    if (!tool) throw new Error("缺少结构化 CAD 工具");
    const rectangle = {
      kind: "rectangle",
      name: "Plate",
      width: 40,
      height: 20,
    };
    const sketch = {
      kind: "create_sketch",
      name: "Sketch",
      profiles: [rectangle],
    };
    for (const args of [
      { operations: [] },
      { operations: [{ ...sketch, profiles: [] }] },
      {
        operations: [
          {
            ...sketch,
            profiles: [rectangle, { kind: "circle", name: "Plate", radius: 3 }],
          },
        ],
      },
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((width) => ({
        operations: [{ ...sketch, profiles: [{ ...rectangle, width }] }],
      })),
      {
        operations: [
          { ...sketch, profiles: [{ ...rectangle, origin: [0, Number.NaN] }] },
        ],
      },
      {
        operations: [
          {
            kind: "set_dimension",
            object: "Sketch",
            profile: "Plate",
            dimension: "height",
            value: 0,
          },
        ],
      },
      {
        operations: [
          {
            kind: "set_property",
            object: "Body",
            property: "Tip",
            value: "Sketch",
          },
        ],
      },
      { operations: [sketch], source: "arbitrary Python" },
      { operations: [sketch], runtimeReadRoots: ["/"] },
      {
        operations: [
          {
            ...sketch,
            profiles: [{ ...rectangle, source: "arbitrary Python" }],
          },
        ],
      },
    ]) {
      expect(
        await tool.execute(args, f.context),
        JSON.stringify(args),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([null, false, 0, "value", [1, "mm"], { radius: 10, valid: true }])(
    "Python自定义JSON data原样保留：%j",
    async (data) => {
      const f = await fixture({ data });
      const result = await f.service.execute(
        { action: "python", input: { source: "result = {'radius': 10}" } },
        f.context,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.data).toEqual(data);
      expect(JSON.stringify(result.structuredContent)).not.toContain("startup");
    },
  );

  it("data不覆盖宿主回执，省略时保持无字段；大JSON按既有进程输出设置拒绝", async () => {
    const f = await fixture({
      data: { success: false, executionId: "forged", protocol: "not-host" },
    });
    const request = {
      action: "python" as const,
      input: { source: "result = {'success': False}" },
    };
    const result = await f.service.execute(request, f.context);
    expect(result.structuredContent).toMatchObject({
      protocol: "kfw-cad/1",
      success: true,
      data: { success: false, executionId: "forged" },
    });
    expect(result.structuredContent.executionId).not.toBe("forged");
    const legacy = await fixture();
    expect(
      (await legacy.service.execute(request, legacy.context)).structuredContent,
    ).not.toHaveProperty("data");
    const large = await fixture({
      data: "x".repeat(4096),
      maxOutputBytes: 1024,
    });
    expect(await large.service.execute(request, large.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "result_too_large" } },
    });
    expect(cadResultSchema.shape.data.safeParse(Number.NaN).success).toBe(
      false,
    );
    expect(cadResultSchema.shape.data.safeParse(new Set([1])).success).toBe(
      false,
    );
  });
  it.each(["success", "silent", "cancel", "invalid-json"] as const)(
    "%s 在首帧/EOF/退出前接管两条pipe，所有终态释放订阅",
    async (mode) => {
      const f = await fixture({ mode });
      const result = await f.service.execute(
        { action: "primitive", input: { kind: "sphere", radius: 2 } },
        f.context,
      );
      expect(result.isError).toBe(
        mode === "success" || mode === "silent" ? undefined : true,
      );
      expect(f.lifecycle.slice(0, 3)).toEqual([
        "stdout-attached",
        "stderr-attached",
        "waiting",
      ]);
      expect(f.lifecycle.indexOf("stdin-ended")).toBeGreaterThan(
        f.lifecycle.indexOf("stderr-attached"),
      );
      expect(f.stdoutDisposer).toHaveBeenCalledOnce();
      expect(f.stderrDisposer).toHaveBeenCalledOnce();
    },
  );
  it("安装态实时查询：未安装/停用/注册表错误均拒绝", async () => {
    const bundle = {
      id: "kenfutwork-cad",
      name: "kenfutwork-cad",
      installed: false,
      enabled: true,
    };
    let entries = [bundle];
    const gate = createCadBundleGate(() => ({ list: async () => entries }));
    expect((await gate()).ok).toBe(false);
    entries = [{ ...bundle, installed: true, enabled: false }];
    expect((await gate()).ok).toBe(false);
    entries = [{ ...bundle, installed: true, enabled: true }];
    expect((await gate()).ok).toBe(true);
    expect((await createCadBundleGate(() => undefined)()).ok).toBe(false);
    expect(
      (
        await createCadBundleGate(() => ({
          list: async () => {
            throw new Error("offline");
          },
        }))()
      ).ok,
    ).toBe(false);
  });

  it("门控或可信上下文不满足时不能启动FreeCAD", async () => {
    const f = await fixture({ gate: { ok: false, message: "已停用" } });
    const request = {
      action: "primitive" as const,
      input: { kind: "sphere" as const, radius: 2 },
    };
    expect(await f.service.execute(request, f.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "plugin_disabled" } },
    });
    expect(
      await f.service.execute(request, {
        ...f.context,
        instanceId: "other-instance",
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "context_required" } },
    });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("准确argv/独立配置/真实Task派发，成功只来自本次JSON回执和产物", async () => {
    const f = await fixture();
    const result = await f.service.execute(
      {
        action: "primitive",
        input: { kind: "box", length: 10, width: 20, height: 30 },
      },
      f.context,
    );
    expect(result).not.toHaveProperty("isError", true);
    const request = f.spawn.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      scope: f.scope,
      agentId: "main",
      background: false,
      runtimeReadRoots: ["/Applications/FreeCAD.app"],
    });
    expect(request?.argv.args).toEqual([
      "--user-cfg",
      expect.stringContaining("user.cfg"),
      "--system-cfg",
      expect.stringContaining("system.cfg"),
      expect.stringContaining("runner.py"),
    ]);
    expect(request).not.toHaveProperty("command");
    expect(request?.cwd).toContain(join(f.root, ".kfw-cad"));
    expect(request?.env).toMatchObject({
      QT_QPA_PLATFORM: "offscreen",
      FREECAD_USER_HOME: request?.cwd,
      FREECAD_USER_DATA: request?.cwd,
      FREECAD_USER_TEMP: request?.cwd,
    });
    expect(request?.env).not.toHaveProperty("HOME");
    const output = result.structuredContent.outputPath;
    expect(typeof output).toBe("string");
    expect(await readFile(String(output), "utf8")).toBe("fixture artifact");
  });

  it("检查已有工程不启动离屏GUI保存宿主", async () => {
    const f = await fixture();
    const documentPath = join(f.root, "existing.FCStd");
    await writeFile(documentPath, "input fixture");
    const result = await f.service.execute(
      { action: "describe", input: { documentPath } },
      f.context,
    );
    expect(result.isError).not.toBe(true);
    expect(f.spawn.mock.calls[0]?.[0].env).not.toHaveProperty(
      "QT_QPA_PLATFORM",
    );
  });

  it.each(["invalid-json", "wrong-id", "failed", "unconfirmed"] as const)(
    "%s 不能把残留文件当成功",
    async (mode) => {
      const f = await fixture({ mode });
      expect(
        await f.service.execute(
          { action: "primitive", input: { kind: "sphere", radius: 2 } },
          f.context,
        ),
      ).toMatchObject({ isError: true });
    },
  );

  it("原文件或已有输出不覆盖；越界和旧代际在spawn前拒绝", async () => {
    const f = await fixture();
    const output = join(f.root, "original.FCStd");
    await writeFile(output, "original");
    const request = {
      action: "python" as const,
      input: { source: "doc.recompute()", outputPath: output },
    };
    expect(await f.service.execute(request, f.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "output_exists" } },
    });
    expect(await readFile(output, "utf8")).toBe("original");
    expect(
      await f.service.execute(
        {
          ...request,
          input: { ...request.input, outputPath: "../escape.FCStd" },
        },
        f.context,
      ),
    ).toMatchObject({ isError: true });
    f.stored.scope.generation = 2;
    expect(
      await f.service.execute(
        { action: "primitive", input: { kind: "sphere", radius: 2 } },
        f.context,
      ),
    ).toMatchObject({ isError: true });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("进程退出后读取回执期间撤权，未取消的Run也不能发布旧代际成功或重放进程", async () => {
    const f = await fixture();
    const handle = f.context.scopeHandle;
    if (!handle) throw new Error("测试缺少真实Task作用域");
    const resolvePath = handle.resolvePath.bind(handle);
    let revoked = false;
    vi.spyOn(handle, "resolvePath").mockImplementation(async (path, access) => {
      if (!revoked && access === "read" && path.endsWith("result.json")) {
        await readFile(path, "utf8");
        revoked = true;
        f.stored.scope = {
          ...f.stored.scope,
          generation: f.stored.scope.generation + 1,
          sandboxMode: "read-only",
        };
      }
      return resolvePath(path, access);
    });
    const request = {
      action: "primitive" as const,
      input: { kind: "sphere" as const, radius: 2 },
    };
    const result = await f.service.execute(request, f.context);
    expect(revoked).toBe(true);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.context.taskWorkContext?.scope.generation).toBe(1);
    expect(handle.describe().generation).toBe(2);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "context_required" } },
    });
    expect(result.structuredContent).not.toHaveProperty("outputPath");
    expect(await f.service.execute(request, f.context)).toEqual(result);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("派发前最后输出路径解析期间代际改变，不能用刷新后的权限启动旧调用", async () => {
    let gateCalls = 0;
    const f = await fixture({
      gate: async () => {
        gateCalls++;
        return { ok: true };
      },
    });
    const handle = f.context.scopeHandle;
    if (!handle) throw new Error("测试缺少真实Task作用域");
    const outputPath = join(f.root, "last-dispatch.FCStd");
    const resolvePath = handle.resolvePath.bind(handle);
    let replaced = false;
    vi.spyOn(handle, "resolvePath").mockImplementation(async (path, access) => {
      if (
        !replaced &&
        gateCalls === 2 &&
        access === "write" &&
        path === outputPath
      ) {
        replaced = true;
        f.stored.scope = {
          ...f.stored.scope,
          generation: f.stored.scope.generation + 1,
        };
      }
      return resolvePath(path, access);
    });
    const result = await f.service.execute(
      { action: "primitive", input: { kind: "sphere", radius: 2, outputPath } },
      f.context,
    );
    expect(replaced).toBe(true);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.context.taskWorkContext?.scope.generation).toBe(1);
    expect(handle.describe().generation).toBe(2);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "context_required" } },
    });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("最终安装门控等待期间代际改变，Run未取消也不能继续派发", async () => {
    let gateCalls = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredFinalGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumeFinalGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      gate: async () => {
        gateCalls++;
        if (gateCalls === 2) {
          entered();
          await resumeFinalGate;
        }
        return { ok: true };
      },
    });
    const pending = f.service.execute(
      { action: "primitive", input: { kind: "sphere", radius: 2 } },
      f.context,
    );
    await enteredFinalGate;
    f.stored.scope = {
      ...f.stored.scope,
      generation: f.stored.scope.generation + 1,
    };
    release();
    const result = await pending;
    expect(gateCalls).toBe(2);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.context.taskWorkContext?.scope.generation).toBe(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "context_required" } },
    });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("取消等待进程Stop且不接受迟到回执", async () => {
    const f = await fixture({ mode: "cancel" });
    expect(
      await f.service.execute(
        { action: "primitive", input: { kind: "sphere", radius: 2 } },
        f.context,
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "cancelled" } },
    });
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("6个共享按需工具，执行工具全部有完整审批kind且严格拒绝未知参数", async () => {
    const f = await fixture();
    const tools = createCadTools(f.service);
    expect(
      tools.map((tool) => [
        tool.name,
        tool.scope,
        tool.exposure,
        tool.approvalReviewKind,
      ]),
    ).toEqual([
      ["cad_status", "shared", "deferred", undefined],
      ["cad_describe_document", "shared", "deferred", "cad-describe"],
      ["cad_create_primitive", "shared", "deferred", "cad-primitive"],
      ["cad_apply_operations", "shared", "deferred", "cad-operations"],
      ["cad_export", "shared", "deferred", "cad-export"],
      ["cad_preview", "shared", "deferred", "cad-preview"],
      ["cad_run_python", "shared", "deferred", "cad-python"],
    ]);
    const python = tools.find((tool) => tool.name === "cad_run_python");
    if (!python) throw new Error("缺少 CAD Python 工具");
    expect(
      await python.execute(
        { source: "print('x')", runtimeReadRoots: ["/"] },
        f.context,
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_arguments" } },
    });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("相同调用并发只启动一次，完成后重放复用结果，参数变更拒绝", async () => {
    const f = await fixture();
    const request = {
      action: "primitive" as const,
      input: { kind: "sphere" as const, radius: 2 },
    };
    const [first, replay] = await Promise.all([
      f.service.execute(request, f.context),
      f.service.execute(request, f.context),
    ]);
    expect(first.isError).not.toBe(true);
    expect(replay).toEqual(first);
    expect(await f.service.execute(request, f.context)).toEqual(first);
    expect(
      await f.service.execute(
        { ...request, input: { kind: "sphere", radius: 3 } },
        f.context,
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invocation_conflict" } },
    });
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("失败调用重放保留原失败而不重新执行；Stop未确认不能降格为已取消", async () => {
    const f = await fixture({ mode: "invalid-json" });
    const request = {
      action: "primitive" as const,
      input: { kind: "sphere" as const, radius: 2 },
    };
    expect((await f.service.execute(request, f.context)).isError).toBe(true);
    expect((await f.service.execute(request, f.context)).isError).toBe(true);
    expect(f.spawn).toHaveBeenCalledOnce();
    const pending = await fixture({ mode: "stop-unconfirmed" });
    expect(
      await pending.service.execute(request, pending.context),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "stop_unconfirmed" } },
    });
  });
});

describe("结构化旋转契约", () => {
  it.each(["x", "y"])(
    "%s轴旋转与角度修改沿用同一工具JSON和沙箱",
    async (axis) => {
      const f = await fixture({
        data: { operations: [{ objectName: "Revolution", angle: 90, axis }] },
      });
      const tool = createCadTools(f.service).find(
        (item) => item.name === "cad_apply_operations",
      );
      if (!tool) throw new Error("缺少结构化 CAD 工具");
      const input = {
        operations: [
          { kind: "create_body", name: "Body" },
          {
            kind: "create_sketch",
            name: "Profile",
            body: "Body",
            profiles: [
              {
                kind: "circle",
                name: "Ring",
                radius: 2,
                center: axis === "x" ? [0, 10] : [10, 0],
              },
            ],
          },
          {
            kind: "create_revolution",
            name: "Revolution",
            label: "旋转体",
            body: "Body",
            profile: "Profile",
            axis,
            angle: 360,
          },
          {
            kind: "set_dimension",
            object: "Revolution",
            dimension: "angle",
            value: 90,
          },
        ],
      };
      const original = structuredClone(input);
      expect(z.fromJSONSchema(tool.parameters).safeParse(input).success).toBe(
        true,
      );
      const result = await executeCadTestTool(tool, input, f.context);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent.data).toEqual({
        operations: [{ objectName: "Revolution", angle: 90, axis }],
      });
      expect(f.spawn).toHaveBeenCalledOnce();
      const request = f.spawn.mock.calls[0]?.[0];
      const wire = JSON.parse(
        await readFile(request?.env?.KFW_CAD_REQUEST ?? "", "utf8"),
      );
      expect(wire.input).toEqual(original);
      expect(request?.env?.QT_QPA_PLATFORM).toBe("offscreen");
      expect(input).toEqual(original);
    },
  );

  it("缺失或非法旋转轴、角度及混入尺寸字段在派发前拒绝", async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.service, "execute");
    const tool = createCadTools(f.service).find(
      (item) => item.name === "cad_apply_operations",
    );
    if (!tool) throw new Error("缺少结构化 CAD 工具");
    const revolution = {
      kind: "create_revolution",
      name: "Revolution",
      body: "Body",
      profile: "Profile",
      axis: "y",
      angle: 180,
    };
    const angle = {
      kind: "set_dimension",
      object: "Revolution",
      dimension: "angle",
      value: 90,
    };
    const invalid = [
      { ...revolution, axis: undefined },
      { ...revolution, axis: "z" },
      { ...revolution, body: undefined },
      { ...revolution, profile: undefined },
      { ...revolution, reversed: true },
      { ...revolution, midplane: true },
      { ...angle, profile: "Ring" },
      { ...angle, axis: "x" },
      ...[
        undefined,
        0,
        -1,
        360.001,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ].flatMap((value) => [
        { ...revolution, angle: value },
        { ...angle, value },
      ]),
    ];
    for (const operation of invalid) {
      expect(
        await tool.execute({ operations: [operation] }, f.context),
        JSON.stringify(operation),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
