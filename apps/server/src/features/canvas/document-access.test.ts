import { createHash, randomUUID } from "node:crypto";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { CodeUiConversationState } from "../code-ui/conversation.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { ProjectFileError } from "../project-files/types.js";
import { createCanvasDocumentAccess } from "./document-access.js";

function fixture() {
  const actor = { instanceId: "instance", accessClientId: "client" };
  const original: protocol.ConversationWorkContext = {
    preset: "design",
    canvasId: "canvas",
  };
  const row = {
    project_id: "project",
    active_run_id: "run",
    scope_generation: 1,
    branch_generation: 2,
    execution_state: "ready",
    state: {
      runWorkContexts: [["run", original]],
      snapshots: [],
      closedRuns: [],
    } as Pick<
      CodeUiConversationState,
      "runWorkContexts" | "snapshots" | "closedRuns"
    >,
  };
  let enabledModes = ["code", "design"];
  let canvasProject = "project";
  let deleted = false;
  const query = vi.fn(async () => ({ rowCount: 1, rows: [row] }));
  const runner = {
    query,
    acquire: async () => ({ query, release() {} }),
    end: async () => {},
  } as unknown as PostgresQueryRunner;
  const resolvePath = vi.fn(async () => "/fixed-task");
  const scope = {
    instanceId: "instance",
    taskId: "task",
    projectId: "project",
    generation: 1,
    rootDirectory: "/fixed-task",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const handle = {
    preset: "code",
    branchGeneration: 2,
    role: "main",
    resolvePath,
    describe: () => scope,
  } as unknown as ExecutionScopeHandle;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const assetId = randomUUID();
  const media = {
    missing: false,
    projectId: "project",
    version: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
  const limits = {
    codeAttachmentMaxBytes: 100,
    codeAttachmentStagedMaxBytes: 200,
    codeAttachmentMaxPerInput: 8,
  };
  const read = vi.fn(async () => media.bytes);
  const brandRead = vi.fn(async () => ({
    bytes,
    mimeType: "image/png",
    version: media.version,
  }));
  const documents = createCanvasDocumentAccess({
    persistence: createPersistenceFromRunner(runner),
    localInstance: createLocalInstanceService({
      repository: { ensure: async () => "instance" },
      dataDir: "/tmp/canvas-access-test",
    }),
    projects: {
      getProject: async () => ({ enabled_modes: enabledModes }),
    } as never,
    canvases: {
      findById: async (_instance, id) =>
        deleted
          ? null
          : { id, name: "文档", project_id: canvasProject, content: {} },
    },
    projectFiles: {
      inspect: async (_actor, id) => {
        if (media.missing)
          throw new ProjectFileError("not_found", "素材不存在");
        return {
          assetId: id,
          projectId: media.projectId,
          taskId: "task",
          version: media.version,
          bucket: "project-assets",
          objectPath: "trusted-asset",
          relativePath: "image.png",
        };
      },
      read,
    },
    brandKit: { readAsset: brandRead },
    settings: { getInstanceSettings: async () => limits as never },
    canvas: {
      getCanvas: async (_actor, id) => ({
        id,
        name: "文档",
        projectId: canvasProject,
        revision: "a".repeat(64),
        content: {
          elements: [{ id: "element", text: "真实内容" }],
          files: {},
          appState: {},
        },
      }),
    },
  });
  const context: ToolExecutionContext = {
    actor,
    instanceId: "instance",
    runId: "run",
    scopeHandle: handle,
    canvasId: "canvas",
    workContext: original,
  };
  return {
    documents,
    actor,
    row,
    context,
    resolvePath,
    query,
    scope,
    assetId,
    media,
    limits,
    read,
    brandRead,
    deleteCanvas: () => {
      deleted = true;
    },
    crossProject: () => {
      canvasProject = "other";
    },
    disableDesign: () => {
      enabledModes = ["code"];
    },
  };
}

it("选区从权威文档重新解析，模型提交的内容不能签发事实或目录权限", async () => {
  const f = fixture();
  const prepared = await f.documents.prepare({
    actor: f.actor,
    projectId: "project",
    context: {
      preset: "design",
      canvasId: "canvas",
      selectedCanvasElements: [{ id: "element", text: "伪造内容" }],
    },
  });
  expect(prepared.selectedCanvasElements).toEqual([
    { id: "element", text: "真实内容" },
  ]);
  expect(f.resolvePath).not.toHaveBeenCalled();
  await expect(
    f.documents.prepare({
      actor: f.actor,
      projectId: "project",
      context: {
        preset: "design",
        canvasId: "canvas",
        selectedCanvasElements: [{ id: "missing" }],
      },
    }),
  ).rejects.toThrow("选区已改变");
});

it("统一Code Task可承载Design文档工具，同项目显式目标不会修改冻结输入或cwd", async () => {
  const f = fixture();
  await expect(
    f.documents.authorize(f.context, "another-document", "write"),
  ).resolves.toEqual(f.actor);
  expect(f.context.canvasId).toBe("canvas");
  expect(f.context.workContext).toEqual({
    preset: "design",
    canvasId: "canvas",
  });
  expect(f.resolvePath).not.toHaveBeenCalled();
});

it.each(["run", "scope", "branch", "state", "frozen"])(
  "%s事实改变时拒绝原文档调用",
  async (change) => {
    const f = fixture();
    if (change === "run") f.row.active_run_id = "next-run";
    if (change === "scope") f.row.scope_generation++;
    if (change === "branch") f.row.branch_generation++;
    if (change === "state") f.row.execution_state = "failed";
    if (change === "frozen")
      f.row.state.runWorkContexts = [
        ["run", { preset: "design", canvasId: "other" }],
      ];
    await expect(
      f.documents.authorize(f.context, "canvas", "write"),
    ).rejects.toThrow("授权已改变");
    expect(f.resolvePath).not.toHaveBeenCalled();
  },
);

it.each(["deleted", "cross-project", "disabled"])(
  "%s文档或项目不可用时拒绝，不从路径猜授权",
  async (change) => {
    const f = fixture();
    if (change === "deleted") f.deleteCanvas();
    if (change === "cross-project") f.crossProject();
    if (change === "disabled") f.disableDesign();
    await expect(f.documents.authorize(f.context, "canvas")).rejects.toThrow();
    expect(f.resolvePath).not.toHaveBeenCalled();
  },
);

it.each(["explore", "review"] as const)(
  "%s角色可以读文档但不能修改",
  async (role) => {
    const f = fixture();
    const scopeHandle = f.context.scopeHandle;
    if (!scopeHandle) throw new Error("测试前置缺失");
    f.context.scopeHandle = { ...scopeHandle, role };
    await expect(
      f.documents.authorize(f.context, "canvas", "read"),
    ).resolves.toEqual(f.actor);
    await expect(
      f.documents.authorize(f.context, "canvas", "write"),
    ).rejects.toThrow("只读");
  },
);

it("计划权限在执行中收紧，最终写入guard拒绝", async () => {
  const f = fixture();
  f.context.codeApproval = {
    ceiling: "build",
    resolve: async () => ({
      mode: "plan",
      scopeGeneration: 1,
      branchGeneration: 2,
    }),
  };
  await expect(
    f.documents.authorize(f.context, "canvas", "write"),
  ).rejects.toThrow("只读");
});

it("Code显式资源引用也校验真实项目文档，不能借mode跳过引用校验", async () => {
  const f = fixture();
  await expect(
    f.documents.prepare({
      actor: f.actor,
      projectId: "project",
      context: { preset: "code", canvasId: "canvas" },
    }),
  ).resolves.toEqual({ preset: "code", canvasId: "canvas" });
  f.crossProject();
  await expect(
    f.documents.prepare({
      actor: f.actor,
      projectId: "project",
      context: { preset: "code", canvasId: "canvas" },
    }),
  ).rejects.toThrow("不属于当前项目");
});

it("父Run已结束时活跃只读子Run仍可读冻结文档，结束后拒绝迟到请求", async () => {
  const f = fixture();
  f.row.active_run_id = "next-parent-run";
  const runWorkContexts = f.row.state.runWorkContexts;
  if (!runWorkContexts) throw new Error("测试前置缺失");
  runWorkContexts.push(["child-run", { preset: "design", canvasId: "canvas" }]);
  f.row.state.snapshots = [
    {
      sessionId: "child",
      control: { activeWorks: [{ foregroundExecutionId: "child-run" }] },
    },
  ] as never;
  f.query.mockImplementation(async (...args: unknown[]) => {
    const sql = String(args[0]);
    return {
      rowCount: 1,
      rows: sql.includes("select s.id") ? [{ id: "child" }] : [f.row],
    } as never;
  });
  f.context.sessionId = "child";
  f.context.runId = "child-run";
  const scopeHandle = f.context.scopeHandle;
  if (!scopeHandle) throw new Error("测试前置缺失");
  f.context.scopeHandle = { ...scopeHandle, role: "explore" };
  await expect(
    f.documents.authorize(f.context, "canvas", "read"),
  ).resolves.toEqual(f.actor);
  await expect(
    f.documents.authorize(f.context, "canvas", "write"),
  ).rejects.toThrow("只读");
  f.row.state.closedRuns.push("child-run");
  await expect(
    f.documents.authorize(f.context, "canvas", "read"),
  ).rejects.toThrow("授权已改变");
});

it("选区assetId解析实际字节，冻结版本改变时拒绝且不扩目录授权", async () => {
  const f = fixture();
  const workContext = f.context.workContext;
  if (!workContext) throw new Error("测试前置缺失");
  workContext.selectedCanvasElements = [
    {
      id: "image",
      customData: { assetId: f.assetId, assetVersion: f.media.version },
    },
  ];
  const refs = [{ reference: f.assetId, mediaType: "image" as const }];
  expect(await f.documents.resolveMediaReferences(f.context, refs)).toEqual([
    `data:image/png;base64,${f.media.bytes.toString("base64")}`,
  ]);
  expect(f.read).toHaveBeenCalledWith(f.actor, f.assetId, { maxBytes: 100 });
  expect(f.resolvePath).not.toHaveBeenCalled();
  f.media.version = "b".repeat(64);
  await expect(
    f.documents.resolveMediaReferences(f.context, refs),
  ).rejects.toThrow("选区素材已变化");
  expect(f.read).toHaveBeenCalledTimes(1);
});

it("未知、删除、跨项目和MIME错误的引用不能静默变成无参考生成", async () => {
  const f = fixture();
  const refs = [{ reference: f.assetId, mediaType: "image" as const }];
  await expect(
    f.documents.resolveMediaReferences(f.context, [
      { reference: "canvas-element-id", mediaType: "image" },
    ]),
  ).rejects.toThrow("无法识别");
  f.media.projectId = "foreign";
  await expect(
    f.documents.resolveMediaReferences(f.context, refs),
  ).rejects.toThrow("不属于当前项目");
  f.media.projectId = "project";
  f.media.missing = true;
  await expect(
    f.documents.resolveMediaReferences(f.context, refs),
  ).rejects.toThrow("已删除");
  expect(f.read).not.toHaveBeenCalled();
  f.media.missing = false;
  f.media.bytes = Buffer.from("not-an-image");
  f.media.version = createHash("sha256").update(f.media.bytes).digest("hex");
  await expect(
    f.documents.resolveMediaReferences(f.context, refs),
  ).rejects.toThrow("格式不匹配");
});

it("品牌素材只从冻结套件父链读取，未知品牌素材错误不吞掉", async () => {
  const f = fixture();
  f.media.missing = true;
  const workContext = f.context.workContext;
  if (!workContext) throw new Error("测试前置缺失");
  workContext.brandKitId = randomUUID();
  const refs = [{ reference: f.assetId, mediaType: "image" as const }];
  expect(
    (await f.documents.resolveMediaReferences(f.context, refs))[0],
  ).toMatch(/^data:image\/png;base64,/);
  expect(f.brandRead).toHaveBeenCalledWith(
    f.actor,
    workContext.brandKitId,
    f.assetId,
    100,
  );
  f.brandRead.mockRejectedValueOnce(new Error("品牌素材不属于所选品牌"));
  await expect(
    f.documents.resolveMediaReferences(f.context, refs),
  ).rejects.toThrow("不属于所选品牌");
  expect(f.resolvePath).not.toHaveBeenCalled();
});

it("单项、重复引用总量和数量预算同时约束真实读取，已接纳附件也受限", async () => {
  const f = fixture();
  const reference = { reference: f.assetId, mediaType: "image" as const };
  f.limits.codeAttachmentMaxBytes = 4;
  await expect(
    f.documents.resolveMediaReferences(f.context, [reference]),
  ).rejects.toThrow("超过读取限制");
  f.limits.codeAttachmentMaxBytes = 100;
  f.limits.codeAttachmentStagedMaxBytes = 12;
  await expect(
    f.documents.resolveMediaReferences(f.context, [reference, reference]),
  ).rejects.toThrow("超过读取限制");
  f.limits.codeAttachmentStagedMaxBytes = 100;
  f.limits.codeAttachmentMaxPerInput = 1;
  await expect(
    f.documents.resolveMediaReferences(f.context, [reference, reference]),
  ).rejects.toThrow("数量超过限制");
  f.context.userAttachmentMap = {
    accepted: `data:image/png;base64,${f.media.bytes.toString("base64")}`,
  };
  expect(
    await f.documents.resolveMediaReferences(f.context, [
      { reference: "accepted", mediaType: "image" },
    ]),
  ).toEqual([f.context.userAttachmentMap.accepted]);
  expect(f.context.workContext).not.toHaveProperty("userAttachmentMap");
});

it("视频字节与图片附件分别核验，本机下载URL不得猜路径", async () => {
  const f = fixture();
  await expect(
    f.documents.resolveMediaReferences(f.context, [
      { reference: "http://127.0.0.1:3001/assets/file", mediaType: "image" },
    ]),
  ).rejects.toThrow("本机素材地址");
  f.media.bytes = Buffer.from("0000ftypisomvideo");
  f.media.version = createHash("sha256").update(f.media.bytes).digest("hex");
  expect(
    await f.documents.resolveMediaReferences(f.context, [
      { reference: f.assetId, mediaType: "video" },
    ]),
  ).toEqual([`data:video/mp4;base64,${f.media.bytes.toString("base64")}`]);
  await expect(
    f.documents.resolveMediaReferences(f.context, [
      { reference: "data:image/png;base64,ZmFrZQ==", mediaType: "image" },
    ]),
  ).rejects.toThrow("格式与内容不一致");
});
