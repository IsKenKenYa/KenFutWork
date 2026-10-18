import { mkdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAD_GUI_OPERATION_RECEIPT_MAX_BYTES,
  type CadGuiOperationBinding,
  type CadGuiOperationPaths,
  createCadGuiOperationStore,
} from "./gui-operation-store.js";

const roots: string[] = [];
const operationId = "b357cc8d-e5a1-4a3e-b23f-c145e99f163d";
const binding: CadGuiOperationBinding = {
  instanceId: "instance-1",
  projectId: "project-1",
  taskId: "task-1",
  scopeGeneration: 1,
  branchGeneration: 1,
  runId: "run-1",
  toolCallId: "tool-1",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "kfw-cad-operation-"));
  roots.push(rootDirectory);
  return {
    rootDirectory,
    first: createCadGuiOperationStore({ rootDirectory }),
    second: createCadGuiOperationStore({ rootDirectory }),
  };
}

describe("CAD GUI 操作持久认领", () => {
  it("两个独立 store 并发认领同一个操作时仅一个 caller 可以派发", async () => {
    const { first, second } = await fixture();
    const input = {
      binding,
      operationId,
      payload: { action: "box" },
      buildMacro: () => "pass\n",
    };
    const one = await first.prepare(input);
    const two = await second.prepare(input);

    const claims = await Promise.all([
      first.claimDispatch(one),
      second.claimDispatch(two),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

const request = (overrides: Partial<CadGuiOperationBinding> = {}) => ({
  binding: { ...binding, ...overrides },
  operationId,
  payload: { action: "box", dimensions: [10, 20, 30] },
  buildMacro: (paths: CadGuiOperationPaths) => `# ${paths.requestPath}\npass\n`,
});

describe("CAD GUI 操作不可变记录", () => {
  it("首份准备时间持久保存，新 store 与新 Run 重放不会延长过期时间", async () => {
    const { first, second } = await fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const original = await first.prepare(request());
      now.mockReturnValue(9999);
      const replay = await second.prepare(
        request({ runId: "run-2", toolCallId: "tool-2" }),
      );

      expect(original.preparedAt).toBe(1234);
      expect(replay.preparedAt).toBe(1234);
      expect(
        JSON.parse(await readFile(original.manifestPath, "utf8")),
      ).toMatchObject({ preparedAt: 1234 });
    } finally {
      now.mockRestore();
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "0"])(
    "拒绝manifest中无效的准备时间：%j",
    async (preparedAt) => {
      const { first, second } = await fixture();
      const original = await first.prepare(request());
      const manifest = JSON.parse(
        await readFile(original.manifestPath, "utf8"),
      );
      await writeFile(
        original.manifestPath,
        JSON.stringify({ ...manifest, preparedAt }),
      );

      await expect(
        second.lookup({ ...binding, operationId }),
      ).rejects.toMatchObject({ code: "invalid_record" });
    },
  );

  it("新 store 与新 Run 重放规范化参数保留原始来源及固定宏", async () => {
    const { first, second } = await fixture();
    const one = await first.prepare(request());
    const two = await second.prepare({
      ...request({ runId: "run-2", toolCallId: "tool-2" }),
      operationId: operationId.toUpperCase(),
      payload: { dimensions: [10, 20, 30], action: "box" },
      buildMacro: () => {
        throw new Error("已发布的宏不应重建");
      },
    });

    expect(two).toEqual(one);
    expect(two.binding).toEqual(binding);
    expect(await second.lookup({ ...binding, operationId })).toEqual(one);
    expect(await readFile(one.requestPath, "utf8")).toBe(
      '{"action":"box","dimensions":[10,20,30]}\n',
    );
  });

  it.each([
    { projectId: "other-project" },
    { scopeGeneration: 2 },
    { branchGeneration: 2 },
  ])("同一键不能跨项目或代际复用：%j", async (changed) => {
    const { first, second } = await fixture();
    await first.prepare(request());

    await expect(second.prepare(request(changed))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("同一键的不同参数明确冲突", async () => {
    const { first, second } = await fixture();
    const original = await first.prepare(request());

    await expect(
      second.prepare({ ...request(), payload: { action: "sphere" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await second.lookup({ ...binding, operationId })).toEqual(original);
  });

  it("Task 和 Instance 分别隔离，相同操作编号不复用目录", async () => {
    const { first } = await fixture();
    const original = await first.prepare(request());
    const anotherTask = await first.prepare(request({ taskId: "../task-2" }));
    const anotherInstance = await first.prepare(
      request({ instanceId: "../instance-2" }),
    );

    expect(
      new Set([
        original.directory,
        anotherTask.directory,
        anotherInstance.directory,
      ]).size,
    ).toBe(3);
    expect(await first.claimDispatch(original)).toBe(true);
    expect(await first.claimDispatch(anotherTask)).toBe(true);
    expect(await first.claimDispatch(anotherInstance)).toBe(true);
    expect(anotherTask.directory).not.toContain("task-2");
    expect(anotherInstance.directory).not.toContain("instance-2");
  });

  it("第一次 await 前深复制输入，调用方在准备中和准备后修改都不能漂移", async () => {
    const { first, second } = await fixture();
    const input = request();
    const pending = first.prepare(input);
    input.payload.dimensions[0] = 999;
    input.binding.runId = "changed-during-prepare";
    const record = await pending;
    input.payload.dimensions.push(999);
    input.binding.projectId = "changed-after-prepare";

    expect(record.payload).toEqual({ action: "box", dimensions: [10, 20, 30] });
    expect(record.binding).toEqual(binding);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(await second.prepare(request())).toEqual(record);
    expect(await readFile(record.manifestPath, "utf8")).not.toContain(
      "changed-",
    );
  });

  it("只持久化白名单绑定，不写入调用方携带的凭据或 scope 对象", async () => {
    const { first } = await fixture();
    const record = await first.prepare({
      ...request(),
      binding: {
        ...binding,
        token: "secret-token",
        scope: { secret: "scope-secret" },
      } as CadGuiOperationBinding,
    });

    const manifest = JSON.parse(await readFile(record.manifestPath, "utf8"));
    expect(Object.keys(manifest)).toEqual([
      "binding",
      "fingerprint",
      "operationId",
      "payload",
      "preparedAt",
      "sourceHash",
      "version",
    ]);
    expect(manifest.binding).toEqual(binding);
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });

  it("读取结果只供查询，调用方不能用它认领旧请求", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    const lookup = await second.lookup({ ...binding, operationId });
    if (!lookup) throw new Error("查询应找到原记录");

    await expect(second.claimDispatch(lookup)).rejects.toMatchObject({
      code: "read_only",
    });
    expect(await second.readState({ ...binding, operationId })).toMatchObject({
      status: "prepared",
    });
    expect(
      await second.readState({
        ...record,
        receiptPath: "/untrusted/receipt.json",
      }),
    ).toMatchObject({ status: "prepared" });
  });

  it.each(["../outside", "", "b357cc8d-e5a1-4a3e-b23f-c145e99f163d/child"])(
    "拒绝非 UUID 操作编号：%s",
    async (invalidId) => {
      const { first } = await fixture();
      await expect(
        first.prepare({ ...request(), operationId: invalidId }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    },
  );
});

describe("CAD GUI 派发与取消的持久状态", () => {
  it("认领后发送前崩溃，新实例及新 Run 都不会再次派发", async () => {
    const { first, second } = await fixture();
    const original = await first.prepare(request());
    expect(await first.claimDispatch(original)).toBe(true);
    const replay = await second.prepare(
      request({ runId: "recovery-run", toolCallId: "recovery-tool" }),
    );

    expect(await second.claimDispatch(replay)).toBe(false);
    expect(await second.readState(replay)).toMatchObject({
      status: "dispatched",
      outcome: "unknown",
      cancelled: false,
    });
    expect(await readFile(replay.dispatchClaimPath, "utf8")).toMatch(
      /^[a-f0-9-]+\n$/u,
    );
  });

  it("认领前取消的墓碑跨 store 保留，迟到请求不能派发", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.cancel(record);
    await first.cancel(record);
    const replay = await second.prepare(request());

    expect(await second.claimDispatch(replay)).toBe(false);
    expect(await second.readState(replay)).toMatchObject({
      status: "cancelled",
      cancelled: true,
    });
    await expect(lstat(replay.dispatchClaimPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("认领后取消不声称副作用已撤销，也不能重派发", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    expect(await first.claimDispatch(record)).toBe(true);
    await second.cancel(record);

    expect(await first.claimDispatch(record)).toBe(false);
    expect(await second.readState(record)).toMatchObject({
      status: "dispatched",
      outcome: "unknown",
      cancelled: true,
    });
  });

  it("GUI execution claim 只说明已执行，只有回执提供 terminal 原文", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    await writeFile(record.executionClaimPath, "gui-owner\n", {
      flag: "wx",
      mode: 0o600,
    });
    expect(await second.readState(record)).toMatchObject({
      status: "executing",
      outcome: "unknown",
    });
    await writeFile(
      record.receiptPath,
      JSON.stringify({ status: "committed", custom: { count: 1 } }),
      { flag: "wx", mode: 0o600 },
    );
    await second.cancel(record);

    expect(await second.readState(record)).toMatchObject({
      status: "terminal",
      cancelled: true,
      receipt: { status: "committed", custom: { count: 1 } },
    });
    expect(await second.claimDispatch(await second.prepare(request()))).toBe(
      false,
    );
  });

  it("缺少派发claim但已有GUI执行或回执时也不派发", async () => {
    const { first } = await fixture();
    const record = await first.prepare(request());
    await writeFile(record.receiptPath, "null", { flag: "wx", mode: 0o600 });

    expect(await first.claimDispatch(record)).toBe(false);
    expect(await first.readState(record)).toMatchObject({
      status: "terminal",
      receipt: null,
    });
  });
});

describe("CAD GUI 回执安全读取", () => {
  it("无claim的损坏回执保持prepared和unknown，不伪造已派发事实", async () => {
    const { first } = await fixture();
    const record = await first.prepare(request());
    await writeFile(record.receiptPath, "{", { mode: 0o600 });

    expect(await first.readState(record)).toMatchObject({
      status: "prepared",
      outcome: "unknown",
      receiptError: "invalid_json",
    });
    expect(await first.claimDispatch(record)).toBe(false);
  });

  it.each([
    { text: '{"status":', error: "invalid_json" },
    {
      text: `"${"x".repeat(CAD_GUI_OPERATION_RECEIPT_MAX_BYTES)}"`,
      error: "too_large",
    },
  ])("非法回执后仍为unknown：$error", async ({ text, error }) => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    await writeFile(record.receiptPath, text, { mode: 0o600 });

    const state = await second.readState(record);
    expect(state).toMatchObject({
      status: "dispatched",
      outcome: "unknown",
      receiptError: error,
    });
    expect(state).not.toHaveProperty("receipt");
  });

  it("不跟随receipt symlink，也不把外部JSON当回执", async () => {
    const { first, rootDirectory } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    const external = join(rootDirectory, "external.json");
    await writeFile(external, '{"status":"committed"}');
    await symlink(external, record.receiptPath);

    expect(await first.readState(record)).toMatchObject({
      status: "dispatched",
      outcome: "unknown",
      receiptError: "unsafe_file",
    });
  });
});

describe("CAD GUI 记录发布边界", () => {
  it("准备目录和不可变文件使用精确私有权限", async () => {
    const { first } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    await first.cancel(record);

    expect((await lstat(record.directory)).mode & 0o777).toBe(0o700);
    for (const path of [
      record.manifestPath,
      record.requestPath,
      record.macroPath,
      record.dispatchClaimPath,
      record.cancelledPath,
    ])
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(record.directory)).not.toContain(
      expect.stringMatching(/^\.prepare-/u),
    );
  });

  it("已有空目录视为残缺记录，不能覆盖发布", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await rm(record.directory, { recursive: true });
    mkdirSync(record.directory, { mode: 0o700 });

    await expect(second.prepare(request())).rejects.toMatchObject({
      code: "busy",
    });
    expect(await readdir(record.directory)).toEqual([]);
  });

  it("目标竞争写入不被覆盖，也不发布半个manifest", async () => {
    const { first, second } = await fixture();
    let paths: CadGuiOperationPaths | undefined;

    await expect(
      first.prepare({
        ...request(),
        buildMacro: (prepared) => {
          paths = prepared;
          writeFileSync(prepared.requestPath, "racing-writer", {
            flag: "wx",
            mode: 0o600,
          });
          return "pass\n";
        },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    if (!paths) throw new Error("应已创建准备目录");
    expect(await readFile(paths.requestPath, "utf8")).toBe("racing-writer");
    await expect(lstat(paths.manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(second.prepare(request())).rejects.toMatchObject({
      code: "busy",
    });
  });

  it("宏构建失败遗留slot，后续请求不重建或自动清理", async () => {
    const { first, second } = await fixture();
    await expect(
      first.prepare({
        ...request(),
        buildMacro: () => {
          throw new Error("builder stopped");
        },
      }),
    ).rejects.toThrow("builder stopped");

    await expect(second.prepare(request())).rejects.toMatchObject({
      code: "busy",
    });
  });

  it.each(["requestPath", "macroPath", "manifestPath"] as const)(
    "已发布的%s改变后不可重用",
    async (field) => {
      const { first, second } = await fixture();
      const record = await first.prepare(request());
      await writeFile(record[field], "tampered");

      await expect(second.prepare(request())).rejects.toMatchObject({
        code: "invalid_record",
      });
      await expect(first.claimDispatch(record)).rejects.toMatchObject({
        code: "invalid_record",
      });
    },
  );

  it("目录symlink不被用作操作记录", async () => {
    const { first, second, rootDirectory } = await fixture();
    const record = await first.prepare(request());
    const external = join(rootDirectory, "external");
    mkdirSync(external, { mode: 0o700 });
    await rm(record.directory, { recursive: true });
    await symlink(external, record.directory);

    await expect(second.prepare(request())).rejects.toMatchObject({
      code: "invalid_record",
    });
    expect(await readdir(external)).toEqual([]);
  });
});

describe("CAD GUI 重建服务后的持久取消", () => {
  it("忽略固定hash层级旁杂的.DS_Store，同时取消合法pending记录", async () => {
    const { first, second, rootDirectory } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    const metadata = join(rootDirectory, "cad", "gui-operations", ".DS_Store");
    await writeFile(metadata, "Finder metadata");

    await second.cancelPending();

    expect(await first.readState(record)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    expect(await readFile(metadata, "utf8")).toBe("Finder metadata");
  });

  it("按run取消不校验其它已知run的损坏宏，全量撤销仍严格校验", async () => {
    const { first, second } = await fixture();
    const selected = await first.prepare(request());
    const other = await first.prepare({
      ...request({ runId: "run-2" }),
      operationId: "e4034716-7273-45ee-8ed1-23ce085324f8",
    });
    await first.claimDispatch(selected);
    await first.claimDispatch(other);
    await writeFile(other.macroPath, "damaged-other-run");

    await second.cancelPending({ runId: "run-1" });

    expect(await first.readState(selected)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    await expect(lstat(other.cancelledPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(other.macroPath, "utf8")).toBe("damaged-other-run");
    await expect(second.cancelPending()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
  });

  it("新store没有内存active记录时仍取消旧派发认领，保留unknown事实", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    expect(await first.claimDispatch(record)).toBe(true);

    await second.cancelPending();

    expect(await first.readState(record)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    expect(await readFile(record.cancelledPath, "utf8")).toBe("cancelled\n");
    expect(await readFile(record.dispatchClaimPath, "utf8")).toMatch(
      /^[a-f0-9-]+\n$/u,
    );
  });

  it("按原来源run筛选，保留其它run及终态记录的原始文件", async () => {
    const { first, second } = await fixture();
    const selected = await first.prepare(request());
    const other = await first.prepare({
      ...request({ runId: "run-2" }),
      operationId: "dc3573c0-cf0e-44b3-8974-cce099dc39bc",
    });
    const terminal = await first.prepare({
      ...request(),
      operationId: "1298cf74-4232-4825-89e3-79a6f868cbe4",
    });
    await first.claimDispatch(selected);
    await first.claimDispatch(other);
    await first.claimDispatch(terminal);
    await writeFile(terminal.receiptPath, '{"completed":true}\n', {
      flag: "wx",
      mode: 0o600,
    });
    const terminalBefore = await readFile(terminal.receiptPath, "utf8");

    await second.cancelPending({ runId: "run-1" });

    expect(await first.readState(selected)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    expect(await first.readState(other)).toMatchObject({
      status: "dispatched",
      cancelled: false,
      outcome: "unknown",
    });
    expect(await first.readState(terminal)).toMatchObject({
      status: "terminal",
      cancelled: false,
    });
    expect(await readFile(terminal.receiptPath, "utf8")).toBe(terminalBefore);
    expect(await readFile(other.macroPath, "utf8")).toContain("pass");
  });

  it("不重建残缺未发布slot，仍取消其它完整prepared记录", async () => {
    const { first, second } = await fixture();
    await expect(
      first.prepare({
        ...request(),
        buildMacro: () => {
          throw new Error("准备尚未发布");
        },
      }),
    ).rejects.toThrow("准备尚未发布");
    const prepared = await first.prepare({
      ...request(),
      operationId: "6119e42c-4e5c-4287-9a3b-a7de83db8ed5",
    });

    await second.cancelPending();

    await expect(
      first.lookup({ ...binding, operationId }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(await first.readState(prepared)).toMatchObject({
      status: "cancelled",
      cancelled: true,
    });
  });

  it("已发布记录损坏时不能声称停止已确认", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    await writeFile(record.manifestPath, "damaged");

    await expect(second.cancelPending()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect(await readFile(record.dispatchClaimPath, "utf8")).toMatch(
      /^[a-f0-9-]+\n$/u,
    );
  });

  it("manifest缺失但已有认领痕迹时不能冒充未发布slot跳过", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimDispatch(record);
    await rm(record.manifestPath);

    await expect(second.cancelPending()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect(await readFile(record.dispatchClaimPath, "utf8")).toMatch(
      /^[a-f0-9-]+\n$/u,
    );
  });

  it("一个损坏记录不阻止其它合法pending收到持久取消标记", async () => {
    const { first, second } = await fixture();
    const damaged = await first.prepare(request());
    const pending = await first.prepare({
      ...request({ runId: "run-2" }),
      operationId: "38431b57-9fb7-44a6-bc0c-b12e62753899",
    });
    await first.claimDispatch(damaged);
    await first.claimDispatch(pending);
    const sourceBefore = await readFile(pending.macroPath, "utf8");
    await writeFile(damaged.manifestPath, "damaged");

    await expect(second.cancelPending()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect(await first.readState(pending)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    expect(await readFile(pending.macroPath, "utf8")).toBe(sourceBefore);
  });

  it("不跟随hash层级中的目录symlink，也不修改其外部目标", async () => {
    const { first, second, rootDirectory } = await fixture();
    const record = await first.prepare(request());
    const external = join(rootDirectory, "external");
    mkdirSync(external, { mode: 0o700 });
    await writeFile(join(external, "keep"), "外部文件");
    await rm(record.directory, { recursive: true });
    await symlink(external, record.directory);

    await expect(second.cancelPending()).rejects.toMatchObject({
      code: "stop_unconfirmed",
    });
    expect(await readFile(join(external, "keep"), "utf8")).toBe("外部文件");
    expect(await readdir(external)).toEqual(["keep"]);
  });
});

describe("CAD GUI Task副本发布的持久日志", () => {
  it("两个独立store只允许一个Node发布认领，完成回执跨重建可读", async () => {
    const { first, second } = await fixture();
    const one = await first.prepare(request());
    const two = await second.prepare(request());
    const claim = {
      destination: "parts/copy.FCStd",
      artifactSha256: "a".repeat(64),
    };

    const claimed = await Promise.all([
      first.claimPublication(one, claim),
      second.claimPublication(two, claim),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const receipt = {
      outcome: "published",
      destination: "parts/copy.FCStd",
      sha256: "a".repeat(64),
    };
    await first.completePublication(one, receipt);
    expect(await second.readPublication(two)).toEqual({ claim, receipt });
  });

  it("发布认领后无完成回执始终保留claim，新store不能重发或重建", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    const payload = {
      destination: "copy.FCStd",
      artifactSha256: "a".repeat(64),
      nested: { version: 1 },
    };
    const pending = first.claimPublication(record, payload);
    payload.destination = "changed.FCStd";
    payload.nested.version = 2;
    expect(await pending).toBe(true);

    expect(await second.readPublication(record)).toEqual({
      claim: {
        destination: "copy.FCStd",
        artifactSha256: "a".repeat(64),
        nested: { version: 1 },
      },
    });
    expect(
      await second.claimPublication(record, { destination: "different.FCStd" }),
    ).toBe(false);
    await expect(
      lstat(join(record.directory, "publication.receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("发布完成需要既有claim，回执同内容幂等而不同内容冲突", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    const receipt = { outcome: "published", destination: "copy.FCStd" };
    await expect(
      first.completePublication(record, receipt),
    ).rejects.toMatchObject({ code: "invalid_record" });
    await first.claimPublication(record, { destination: "copy.FCStd" });
    await first.completePublication(record, receipt);
    await second.completePublication(record, {
      destination: "copy.FCStd",
      outcome: "published",
    });

    await expect(
      second.completePublication(record, {
        ...receipt,
        destination: "other.FCStd",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await second.readPublication(record)).receipt).toEqual(receipt);
    expect(
      await readFile(
        join(record.directory, "publication.receipt.json"),
        "utf8",
      ),
    ).toBe('{"destination":"copy.FCStd","outcome":"published"}\n');
  });

  it("完成回执存在但claim丢失时拒绝重建或再次认领", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimPublication(record, { destination: "copy.FCStd" });
    await first.completePublication(record, { outcome: "published" });
    await rm(join(record.directory, "publication.claim.json"));

    await expect(second.readPublication(record)).rejects.toMatchObject({
      code: "invalid_record",
    });
    await expect(
      second.claimPublication(record, { destination: "copy.FCStd" }),
    ).rejects.toMatchObject({ code: "invalid_record" });
    expect(
      await readFile(
        join(record.directory, "publication.receipt.json"),
        "utf8",
      ),
    ).toBe('{"outcome":"published"}\n');
  });

  it.each([
    { name: "publication.claim.json", text: "{" },
    { name: "publication.receipt.json", text: "{" },
    {
      name: "publication.claim.json",
      text: "x".repeat(CAD_GUI_OPERATION_RECEIPT_MAX_BYTES + 1),
    },
    {
      name: "publication.receipt.json",
      text: "x".repeat(CAD_GUI_OPERATION_RECEIPT_MAX_BYTES + 1),
    },
  ])("损坏或超界的$name保留unknown，不覆盖日志", async ({ name, text }) => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimPublication(record, { destination: "copy.FCStd" });
    await writeFile(join(record.directory, name), text);

    await expect(second.readPublication(record)).rejects.toMatchObject({
      code: "invalid_record",
    });
    await expect(
      second.claimPublication(record, { destination: "copy.FCStd" }),
    ).rejects.toMatchObject({ code: "invalid_record" });
    expect(await readFile(join(record.directory, name), "utf8")).toBe(text);
  });

  it("发布日志不跟随symlink，取消pending不删除已认领和已完成日志", async () => {
    const { first, second, rootDirectory } = await fixture();
    const record = await first.prepare(request());
    await first.claimPublication(record, { destination: "copy.FCStd" });
    const external = join(rootDirectory, "external-publication.json");
    await writeFile(external, '{"outcome":"published"}');
    await symlink(external, join(record.directory, "publication.receipt.json"));
    await expect(second.readPublication(record)).rejects.toMatchObject({
      code: "invalid_record",
    });
    await rm(join(record.directory, "publication.receipt.json"));
    await first.completePublication(record, { outcome: "published" });

    await second.cancelPending();

    expect(await second.readPublication(record)).toEqual({
      claim: { destination: "copy.FCStd" },
      receipt: { outcome: "published" },
    });
    for (const name of ["publication.claim.json", "publication.receipt.json"])
      expect((await lstat(join(record.directory, name))).mode & 0o777).toBe(
        0o600,
      );
    expect(await readFile(external, "utf8")).toBe('{"outcome":"published"}');
  });
});

describe("CAD GUI 发布控制JSON边界", () => {
  it("并发完成回执不相同时仅一个成功，另一个冲突且原回执不改", async () => {
    const { first, second } = await fixture();
    const record = await first.prepare(request());
    await first.claimPublication(record, { destination: "copy.FCStd" });
    const one = { outcome: "published", version: "one" };
    const two = { outcome: "published", version: "two" };

    const completed = await Promise.allSettled([
      first.completePublication(record, one),
      second.completePublication(record, two),
    ]);

    expect(
      completed.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = completed.find((entry) => entry.status === "rejected");
    if (rejected?.status !== "rejected")
      throw new Error("并发不同回执应有一次冲突");
    expect(rejected.reason).toMatchObject({ code: "conflict" });
    expect([one, two]).toContainEqual(
      (await first.readPublication(record)).receipt,
    );
  });

  it("发布控制JSON输入超过64KiB时拒绝，不创建或补写日志", async () => {
    const { first } = await fixture();
    const record = await first.prepare(request());
    const tooLarge = { value: "x".repeat(CAD_GUI_OPERATION_RECEIPT_MAX_BYTES) };
    await expect(
      first.claimPublication(record, tooLarge),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await first.readPublication(record)).toEqual({});
    await first.claimPublication(record, { destination: "copy.FCStd" });
    await expect(
      first.completePublication(record, tooLarge),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await first.readPublication(record)).toEqual({
      claim: { destination: "copy.FCStd" },
    });
  });
});
