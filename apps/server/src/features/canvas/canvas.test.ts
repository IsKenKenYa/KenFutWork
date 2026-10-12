import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlobStore } from "../blob/types.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import type {
  ProjectFileReceipt,
  ProjectFileService,
} from "../project-files/types.js";
import { ProjectFileError } from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { ProjectDetailRow } from "../projects/repository.js";
import { createCanvasAssetLocations } from "./asset-locations.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasFileStore } from "./file-store.js";

it("素材处理期间Task撤权，原子发布拒绝旧布局并保留原版本", async () => {
  const f = await fileService();
  const before = await f.service.getCanvas(ACTOR, CANVAS_ID);
  let revoked = false;
  const prepare = f.projectFiles.prepareWrite.bind(f.projectFiles);
  f.projectFiles.prepareWrite = async (...args) => {
    const receipt = await prepare(...args);
    revoked = true;
    return receipt;
  };
  await expect(
    f.service.saveCanvasContent(
      ACTOR,
      CANVAS_ID,
      {
        elements: [{ id: "late-layout" }],
        appState: {},
        files: { image: { dataURL: "data:image/png;base64,YQ==" } },
      },
      before.revision,
      async () => {
        if (revoked) throw new Error("Task权限已撤销");
      },
    ),
  ).rejects.toThrow("权限已撤销");
  const after = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(after.revision).toBe(before.revision);
  expect(after.content.elements).toEqual(before.content.elements);
});
it.each(["moved", "version", "missing"] as const)(
  "Git恢复image/video布局后%s索引不能改写权威引用，显式恢复后才提供URL",
  async (state) => {
    const f = await fileService();
    const initial = await f.service.getCanvas(ACTOR, CANVAS_ID);
    const image = randomUUID(),
      video = randomUUID();
    const bytes = Buffer.from("old-Git-material");
    const version = createHash("sha256").update(bytes).digest("hex");
    const newer = createHash("sha256").update("new-material").digest("hex");
    for (const name of ["old-image.png", "old-video.mp4"])
      await writeFile(join(f.root, name), bytes);
    for (const name of ["new-image.png", "new-video.mp4"])
      await writeFile(join(f.root, name), "new-material");
    const refs = new Map<string, { path: string; mime: string }>([
      [image, { path: "old-image.png", mime: "image/png" }],
      [video, { path: "old-video.mp4", mime: "video/mp4" }],
    ]);
    let restored = false;
    f.projectFiles.describe = async (_actor, assetId) => {
      const ref = refs.get(assetId)!;
      if (!restored && state === "missing")
        throw new ProjectFileError("file_missing", "素材缺失");
      return {
        assetId,
        bucket: "project-assets",
        objectPath: `${INSTANCE_ID}/project-files/${assetId}`,
        relativePath:
          !restored && state === "moved"
            ? ref.path.replace("old-", "new-")
            : ref.path,
        version: restored ? version : newer,
      };
    };
    const marker = (assetId: string) =>
      `oss://project-assets/${INSTANCE_ID}/project-files/${assetId}`;
    const content = {
      elements: [
        { id: "image", type: "image", fileId: "image" },
        {
          id: "video",
          link: marker(video),
          customData: {
            isVideo: true,
            assetId: video,
            relativePath: "old-video.mp4",
            version,
          },
        },
      ],
      appState: {},
      files: {
        image: {
          assetId: image,
          relativePath: "old-image.png",
          version,
          mimeType: "image/png",
          storageRef: marker(image),
          dataURL: marker(image),
        },
      },
    };
    const store = createCanvasFileStore({ projectRoot: f.root });
    const saved = await store.save(CANVAS_ID, content, initial.revision);
    const path = join(f.root, ".kenfutwork", "canvases", `${CANVAS_ID}.json`);
    const before = await readFile(path);
    const view = await f.service.getCanvas(ACTOR, CANVAS_ID);
    expect(view.revision).toBe(saved.revision);
    expect(await readFile(path)).toEqual(before);
    expect(view.content.files.image).toMatchObject({
      relativePath: "old-image.png",
      version,
      assetError: "请恢复素材索引",
    });
    expect(view.content.files.image?.storageUrl).toBeUndefined();
    expect(view.content.elements[1]).toMatchObject({
      link: null,
      customData: {
        relativePath: "old-video.mp4",
        version,
        assetError: "请恢复素材索引",
      },
    });
    expect(await f.service.readCanvasContent(ACTOR, CANVAS_ID)).toEqual(
      content,
    );
    await expect(
      f.service.saveCanvasContent(ACTOR, CANVAS_ID, content, saved.revision),
    ).rejects.toThrow(state === "missing" ? "素材缺失" : "恢复素材索引");
    expect(await readFile(path)).toEqual(before);
    f.projectFiles.restoreIndex = async (
      _actor,
      _project,
      references,
      beforePublish,
    ) => {
      expect(references).toEqual([
        { assetId: image, relativePath: "old-image.png", version },
        { assetId: video, relativePath: "old-video.mp4", version },
      ]);
      for (const ref of references)
        expect(
          createHash("sha256")
            .update(await readFile(join(f.root, ref.relativePath)))
            .digest("hex"),
        ).toBe(ref.version);
      await beforePublish();
      restored = true;
      return Promise.all(
        references.map(async (ref) => ({
          ...(await f.projectFiles.describe(ACTOR, ref.assetId)),
          projectId: "project",
          taskId: null,
          version,
        })),
      );
    };
    const assets = createCanvasAssetLocations({
      canvases: {
        findById: async () => f.row(),
        claimRoot: async () => f.root,
      },
      localInstance: {
        resolve: async () => ({ instanceId: INSTANCE_ID, dataDir: f.root }),
      },
      projects: { getProject: async () => ({ work_dir: f.root }) },
      projectFiles: f.projectFiles,
    } as unknown as Parameters<typeof createCanvasAssetLocations>[0]);
    await assets.restoreReferences(ACTOR, CANVAS_ID, saved.revision);
    const recovered = await f.service.getCanvas(ACTOR, CANVAS_ID);
    expect(recovered.content.files.image?.storageUrl).toContain(image);
    expect(recovered.content.files.image?.relativePath).toBe("old-image.png");
    expect(recovered.content.elements[1]?.link).toBe(marker(video));
    expect(recovered.revision).toBe(saved.revision);
    expect(await readFile(path)).toEqual(before);
  },
);

it("登记视频保存稳定位置与版本，跨项目视频拒绝插入", async () => {
  const f = await fileService();
  const assetId = randomUUID();
  let projectId = "project";
  let relativePath = "clips/video.mp4";
  f.projectFiles.inspect = async () => ({
    assetId,
    projectId,
    taskId: null,
    bucket: "project-assets",
    objectPath: `${INSTANCE_ID}/project-files/${assetId}`,
    relativePath,
    version: "original-sha",
  });
  f.projectFiles.describe = f.projectFiles.inspect;
  const request = {
    canvasId: CANVAS_ID,
    assetId,
    signedUrl: "https://wrong.test/video.mp4",
    width: 640,
    height: 360,
    mimeType: "video/mp4",
  };
  await f.service.insertVideoElement(ACTOR, request);
  const saved = await f.service.readCanvasContent(ACTOR, CANVAS_ID);
  expect(saved.elements[0]?.customData).toMatchObject({
    assetId,
    relativePath: "clips/video.mp4",
    version: "original-sha",
  });
  expect(saved.elements[0]?.link).toBe(
    `https://assets.test/${INSTANCE_ID}/project-files/${assetId}`,
  );
  relativePath = "renamed/video.mp4";
  const moved = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(moved.content.elements[0]?.customData).toMatchObject({
    relativePath: "clips/video.mp4",
    version: "original-sha",
    assetError: "请恢复素材索引",
  });
  expect(moved.content.elements[0]?.link).toBeNull();
  const stored = await f.service.readCanvasContent(ACTOR, CANVAS_ID);
  expect(stored.elements[0]?.customData).toMatchObject({
    relativePath: "clips/video.mp4",
  });
  projectId = "other-project";
  await expect(f.service.insertVideoElement(ACTOR, request)).rejects.toThrow(
    "不属于",
  );
  expect(
    (await f.service.readCanvasContent(ACTOR, CANVAS_ID)).elements,
  ).toHaveLength(1);
  expect(f.uploads).toHaveLength(0);
});

it("外部移走登记图片后仍可打开布局，保存拒绝缺失引用且不重建或删除文件", async () => {
  const f = await fileService();
  const initial = await f.service.getCanvas(ACTOR, CANVAS_ID);
  await f.service.saveCanvasContent(
    ACTOR,
    CANVAS_ID,
    {
      elements: [{ id: "image", type: "image", fileId: "image" }],
      appState: {},
      files: { image: { dataURL: "data:image/png;base64,YQ==" } },
    },
    initial.revision,
  );
  const before = await f.service.readCanvasContent(ACTOR, CANVAS_ID);
  f.projectFiles.describe = async () => {
    throw new ProjectFileError("file_missing", "素材缺失，请重新关联");
  };
  const view = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(view.content.elements).toEqual(before.elements);
  expect(view.content.files.image?.assetId).toBe(before.files.image?.assetId);
  const writes = f.writes.length;
  await expect(
    f.service.saveCanvasContent(ACTOR, CANVAS_ID, before, view.revision),
  ).rejects.toThrow("素材缺失");
  expect(f.writes).toHaveLength(writes);
  expect((await f.service.getCanvas(ACTOR, CANVAS_ID)).revision).toBe(
    view.revision,
  );
});

import {
  type CanvasRepository,
  type CanvasRow,
  createCanvasRepository,
} from "./repository.js";

const CLIENT_ID = "client-1";
const INSTANCE_ID = "instance-1";
const CANVAS_ID = "canvas-1";

const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: CLIENT_ID,
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

const CANVAS_ROW = {
  id: CANVAS_ID,
  name: "Main Canvas",
  project_id: "project-1",
  content: { elements: [], appState: {} },
};

describe("canvas repository（canvases 无 instance_id 列 → JOIN projects）", () => {
  it("读取画布经项目父链施加实例谓词", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [CANVAS_ROW],
    }));

    const row = await createCanvasRepository(
      createPersistenceFromRunner(runner),
    ).findById(INSTANCE_ID, CANVAS_ID);

    expect(row?.id).toBe(CANVAS_ID);
    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("from public.canvases c");
    expect(sql).toContain("join public.projects p on p.id = c.project_id");
    expect(sql).toContain("where c.id = $1 and p.instance_id = $2");
    expect(calls[0]?.values).toEqual([CANVAS_ID, INSTANCE_ID]);
  });

  it("写入画布同样带父链谓词，jsonb 显式序列化", async () => {
    const { calls, runner } = createRunner(() => ({ rowCount: 1, rows: [] }));

    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(runner),
      ).recordFileIndex(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBe(1);

    const sql = calls[0]?.text.replace(/\s+/g, " ").trim() ?? "";
    expect(sql).toContain("update public.canvases c set content = $2::jsonb");
    expect(sql).toContain("from public.projects p");
    expect(sql).toContain("and p.instance_id = $3");
    expect(calls[0]?.values).toEqual([
      CANVAS_ID,
      JSON.stringify({
        storage: "project-files",
        path: `.kenfutwork/canvases/${CANVAS_ID}.json`,
      }),
      INSTANCE_ID,
    ]);
  });

  it("按实例读取画布绑定品牌套件：走同一父链，且用实例谓词", async () => {
    const brandKit = createRunner(() => ({
      rowCount: 1,
      rows: [{ brand_kit_id: "kit-1" }],
    }));
    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(brandKit.runner),
      ).findProjectBrandKitId(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBe("kit-1");
    expect(brandKit.sqls()[0]).toContain(
      "where c.id = $1 and p.instance_id = $2",
    );
    expect(brandKit.calls[0]?.values).toEqual([CANVAS_ID, INSTANCE_ID]);

    const empty = createRunner();
    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(empty.runner),
      ).findProjectBrandKitId(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBeNull();
  });

  it("0 行受影响即未命中（不属本实例或不存在）", async () => {
    const { runner } = createRunner();
    await expect(
      createCanvasRepository(
        createPersistenceFromRunner(runner),
      ).recordFileIndex(INSTANCE_ID, CANVAS_ID),
    ).resolves.toBe(0);
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fileService(options: { uploadFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-service-"));
  roots.push(root);
  let row: CanvasRow | null = {
    id: CANVAS_ID,
    name: "画布",
    project_id: "project",
    content: { elements: [], appState: {}, files: {} },
  };
  let active = true;
  const uploads: string[] = [];
  const downloads: string[] = [];
  const sourceBytes = new Map<string, Uint8Array>([
    ["existing.png", Buffer.from("legacy-image")],
    ["generated.png", Buffer.from("generated-image")],
  ]);
  const prepared = new Map<string, string>();
  const assetReceipts = new Map<string, ProjectFileReceipt>();
  const descriptions: string[] = [];
  const reads: string[] = [];
  const projectFileBytes = new Map<string, Uint8Array>();
  const writes: Array<{
    assetId: string;
    relativePath: string;
    writeFingerprint: string;
    projectId: string;
  }> = [];
  const instance = createLocalInstanceService({
    repository: { ensure: async () => INSTANCE_ID },
    dataDir: root,
  });
  const repository: CanvasRepository = {
    claimRoot: async () => root,
    findById: async (id) => (id === INSTANCE_ID ? structuredClone(row) : null),
    findProjectBrandKitId: async () => null,
    recordFileIndex: async () => {
      if (!row || !active) return 0;
      row.content = {
        storage: "project-files",
        path: `.kenfutwork/canvases/${CANVAS_ID}.json`,
      };
      return 1;
    },
  };
  const blob = {
    bucket: () => ({
      upload: async (path: string, body: Uint8Array) => {
        uploads.push(path);
        if (options.uploadFails) throw new Error("素材上传失败");
        const assetId = prepared.get(path);
        if (assetId) projectFileBytes.set(assetId, Buffer.from(body));
      },
      resolveUrl: async (path: string) => `https://assets.test/${path}`,
      download: async (path: string) => {
        downloads.push(path);
        const bytes = sourceBytes.get(path);
        if (!bytes) throw new Error(`素材不存在: ${path}`);
        return Buffer.from(bytes);
      },
    }),
  } as unknown as BlobStore;
  const projects = {
    getProject: async (
      _actor: LocalActor,
      projectId: string,
    ): Promise<ProjectDetailRow> => {
      if (!active) throw new Error("项目已归档");
      return {
        id: projectId,
        kind: "design",
        name: "测试项目",
        slug: "test-project",
        description: null,
        instance_id: INSTANCE_ID,
        brand_kit_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        work_dir: root,
        additional_directories: [],
      };
    },
  } satisfies Pick<ProjectService, "getProject">;
  const projectFiles: ProjectFileService = {
    async describe(_actor, assetId) {
      descriptions.push(assetId);
      const receipt = assetReceipts.get(assetId);
      if (!receipt) throw new Error(`项目素材不存在: ${assetId}`);
      return receipt;
    },
    async prepareWrite(_actor, input) {
      if (input.target.kind !== "canvas" || input.target.canvasId !== CANVAS_ID)
        throw new Error("画布素材必须绑定父项目");
      writes.push({
        assetId: input.assetId,
        relativePath: input.relativePath,
        writeFingerprint: input.writeFingerprint,
        projectId: input.target.projectId,
      });
      const objectPath = `${INSTANCE_ID}/project-files/${input.assetId}`;
      prepared.set(objectPath, input.assetId);
      const receipt: ProjectFileReceipt = {
        assetId: input.assetId,
        bucket: "project-assets",
        objectPath,
        relativePath: input.relativePath,
      };
      assetReceipts.set(input.assetId, receipt);
      return receipt;
    },
    async publish() {
      throw new Error("画布测试不发布项目素材");
    },
    async read(_actor, assetId) {
      reads.push(assetId);
      const bytes = projectFileBytes.get(assetId);
      if (!bytes) throw new Error(`项目素材不存在: ${assetId}`);
      return Buffer.from(bytes);
    },
    async move() {
      throw new Error("画布测试不移动项目素材");
    },
    async remove() {
      throw new Error("画布测试不删除项目素材");
    },
    async inspect() {
      throw new Error("日常画布保存不重读素材哈希");
    },
    async relink() {
      throw new Error("画布保存不重关联素材");
    },
    async restoreIndex() {
      throw new Error("画布保存不恢复素材索引");
    },
    namespaceProvider: {
      upload: async () => {},
      download: async () => new Uint8Array(),
      copy: async () => {},
      remove: async () => {},
    },
  };
  const service = createCanvasService({
    blob,
    repository,
    localInstance: instance,
    projects,
    projectFiles,
  });
  return {
    root,
    service,
    projectFiles,
    uploads,
    downloads,
    writes,
    descriptions,
    reads,
    seedProjectFile: (assetId: string, relativePath: string) => {
      assetReceipts.set(assetId, {
        assetId,
        bucket: "project-assets",
        objectPath: `${INSTANCE_ID}/project-files/${assetId}`,
        relativePath,
      });
    },
    row: () => row,
    remove: () => {
      row = null;
    },
    archive: () => {
      active = false;
    },
    hasSource: (path: string) => sourceBytes.has(path),
  };
}

it("显式读取首次导入旧内容，DB仅索引，GET返回文件revision与轻量素材引用", async () => {
  const f = await fileService();
  f.row()!.content = {
    elements: [],
    appState: { theme: "dark" },
    files: {
      image: {
        dataURL: "oss://project-assets/existing.png",
        mimeType: "image/png",
      },
    },
  };
  const detail = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(detail.revision).toMatch(/^[a-f0-9]{64}$/u);
  expect(detail.content.files.image).toMatchObject({
    relativePath: expect.stringMatching(/^canvas-[a-f0-9-]{36}\.png$/u),
    storageRef: expect.stringMatching(
      /^oss:\/\/project-assets\/instance-1\/project-files\/[a-f0-9-]{36}$/u,
    ),
  });
  expect(detail.content.files.image).toHaveProperty("assetId");
  expect(detail.content.files.image?.storageUrl).toContain(
    "/instance-1/project-files/",
  );
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.projectId).toBe("project");
  expect(f.writes[0]?.writeFingerprint).toBe(
    createHash("sha256").update("legacy-image").digest("hex"),
  );
  expect(f.hasSource("existing.png")).toBe(true);
  const lean = await f.service.readCanvasContent(ACTOR, CANVAS_ID);
  expect(lean.files.image).toMatchObject({
    assetId: expect.any(String),
    relativePath: expect.stringMatching(/^canvas-[a-f0-9-]{36}\.png$/u),
    storageRef: expect.stringMatching(
      /^oss:\/\/project-assets\/instance-1\/project-files\//u,
    ),
  });
  expect(f.row()!.content).toEqual({
    storage: "project-files",
    path: `.kenfutwork/canvases/${CANVAS_ID}.json`,
  });
  expect(
    JSON.parse(
      await readFile(
        join(f.root, ".kenfutwork", "canvases", `${CANVAS_ID}.json`),
        "utf8",
      ),
    ),
  ).toMatchObject({
    appState: { theme: "dark" },
    files: {
      image: {
        storageRef: expect.stringMatching(
          /^oss:\/\/project-assets\/instance-1\/project-files\//u,
        ),
      },
    },
  });
});
it("生成的project-files namespace引用直连索引，不下载或复制素材", async () => {
  const f = await fileService();
  const assetId = randomUUID();
  const relativePath = "media/已登记.png";
  f.seedProjectFile(assetId, relativePath);
  await f.service.getCanvas(ACTOR, CANVAS_ID);

  await f.service.insertImageElement(ACTOR, {
    canvasId: CANVAS_ID,
    objectPath: `${INSTANCE_ID}/project-files/${assetId}`,
    width: 100,
    height: 100,
    mimeType: "image/png",
  });

  const detail = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(Object.values(detail.content.files)).toEqual([
    expect.objectContaining({
      assetId,
      relativePath,
      storageRef: `oss://project-assets/${INSTANCE_ID}/project-files/${assetId}`,
    }),
  ]);
  expect(f.descriptions).toContain(assetId);
  expect(f.reads).toEqual([]);
  expect(f.uploads).toEqual([]);
  expect(f.downloads).toEqual([]);
  expect(f.writes).toEqual([]);
});
it("已登记素材读取时用describe同步移动后的relativePath，不读取二进制", async () => {
  const f = await fileService();
  const assetId = randomUUID();
  const storageRef = `oss://project-assets/${INSTANCE_ID}/project-files/${assetId}`;
  f.seedProjectFile(assetId, "media/current.png");
  f.row()!.content = {
    elements: [],
    appState: {},
    files: {
      image: {
        id: "image",
        assetId,
        relativePath: "media/old.png",
        storageRef,
        dataURL: storageRef,
        mimeType: "image/png",
      },
    },
  };

  const detail = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(detail.content.files.image).toMatchObject({
    assetId,
    relativePath: "media/current.png",
    storageRef,
  });
  expect(f.downloads).toEqual([]);
  expect(f.reads).toEqual([]);
  expect(f.uploads).toEqual([]);
  expect(f.writes).toEqual([]);
});
it("namespace素材describe失败时不伪造引用或登记Canvas索引", async () => {
  const f = await fileService();
  const assetId = randomUUID();
  const storageRef = `oss://project-assets/${INSTANCE_ID}/project-files/${assetId}`;
  f.row()!.content = {
    elements: [],
    appState: {},
    files: { image: { dataURL: storageRef, mimeType: "image/png" } },
  };

  await expect(f.service.getCanvas(ACTOR, CANVAS_ID)).rejects.toThrow(
    "项目素材不存在",
  );
  expect(f.row()!.content).toMatchObject({
    files: { image: { dataURL: storageRef } },
  });
  expect(f.row()!.content).not.toHaveProperty("storage");
  expect(f.descriptions).toContain(assetId);
  expect(f.downloads).toEqual([]);
  expect(f.reads).toEqual([]);
  expect(f.uploads).toEqual([]);
  expect(f.writes).toEqual([]);
});
it("用户save强制字节CAS，冲突发生在素材上传之前", async () => {
  const f = await fileService();
  const initial = await f.service.getCanvas(ACTOR, CANVAS_ID);
  const input = {
    ...initial.content,
    files: { image: { dataURL: "data:image/png;base64,YQ==" } },
  };
  await expect(
    f.service.saveCanvasContent(ACTOR, CANVAS_ID, input, null),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(f.uploads).toEqual([]);
  const saved = await f.service.saveCanvasContent(
    ACTOR,
    CANVAS_ID,
    input,
    initial.revision,
  );
  expect(saved.fileReferences.image).toEqual(
    expect.stringMatching(
      /^oss:\/\/project-assets\/instance-1\/project-files\/[a-f0-9-]{36}$/u,
    ),
  );
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.relativePath).toMatch(/^canvas-[a-f0-9-]{36}\.png$/u);
  expect(f.writes[0]?.writeFingerprint).toBe(
    createHash("sha256").update("a").digest("hex"),
  );
  const reloaded = await f.service.getCanvas(ACTOR, CANVAS_ID);
  await f.service.saveCanvasContent(
    ACTOR,
    CANVAS_ID,
    reloaded.content,
    saved.revision,
  );
  expect(f.uploads).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
});
it("新base64上传失败不降级保存内联内容", async () => {
  const f = await fileService({ uploadFails: true });
  const initial = await f.service.getCanvas(ACTOR, CANVAS_ID);
  await expect(
    f.service.saveCanvasContent(
      ACTOR,
      CANVAS_ID,
      {
        ...initial.content,
        files: { image: { dataURL: "data:image/png;base64,YQ==" } },
      },
      initial.revision,
    ),
  ).rejects.toThrow("素材上传失败");
  expect((await f.service.getCanvas(ACTOR, CANVAS_ID)).revision).toBe(
    initial.revision,
  );
});
it("旧blob迁移失败时不登记项目文件索引", async () => {
  const f = await fileService({ uploadFails: true });
  f.row()!.content = {
    elements: [],
    appState: {},
    files: {
      image: {
        dataURL: "oss://project-assets/existing.png",
        mimeType: "image/png",
      },
    },
  };
  await expect(f.service.getCanvas(ACTOR, CANVAS_ID)).rejects.toThrow(
    "素材上传失败",
  );
  expect(f.row()!.content).toMatchObject({
    files: {
      image: {
        dataURL: "oss://project-assets/existing.png",
        mimeType: "image/png",
      },
    },
  });
  expect(f.row()!.content).not.toHaveProperty("storage");
});
it("生成图片与视频接文件追加，已有图片blob迁移一次并保留源", async () => {
  const f = await fileService();
  await f.service.getCanvas(ACTOR, CANVAS_ID);
  await Promise.all([
    f.service.insertImageElement(ACTOR, {
      canvasId: CANVAS_ID,
      objectPath: "generated.png",
      width: 100,
      height: 100,
      mimeType: "image/png",
    }),
    f.service.insertVideoElement(ACTOR, {
      canvasId: CANVAS_ID,
      signedUrl: "https://assets.test/video.mp4",
      width: 100,
      height: 100,
      mimeType: "video/mp4",
    }),
  ]);
  const detail = await f.service.getCanvas(ACTOR, CANVAS_ID);
  expect(detail.content.elements).toHaveLength(2);
  expect(Object.values(detail.content.files)).toMatchObject([
    {
      assetId: expect.any(String),
      relativePath: expect.stringMatching(/^canvas-[a-f0-9-]{36}\.png$/u),
      storageRef: expect.stringMatching(
        /^oss:\/\/project-assets\/instance-1\/project-files\//u,
      ),
    },
  ]);
  expect(f.uploads).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.writeFingerprint).toBe(
    createHash("sha256").update("generated-image").digest("hex"),
  );
  expect(f.hasSource("generated.png")).toBe(true);
});
it("索引存在但文件缺失不fallback，删除及项目归档后不可迟到写", async () => {
  const f = await fileService();
  const initial = await f.service.getCanvas(ACTOR, CANVAS_ID);
  await rm(join(f.root, ".kenfutwork", "canvases", `${CANVAS_ID}.json`));
  await expect(f.service.getCanvas(ACTOR, CANVAS_ID)).rejects.toMatchObject({
    code: "canvas_file_missing",
  });
  await expect(
    f.service.saveCanvasContent(
      ACTOR,
      CANVAS_ID,
      initial.content,
      initial.revision,
    ),
  ).rejects.toMatchObject({ code: "canvas_file_missing" });
  f.remove();
  await expect(f.service.getCanvas(ACTOR, CANVAS_ID)).rejects.toMatchObject({
    statusCode: 404,
  });
  const archived = await fileService();
  const previous = await archived.service.getCanvas(ACTOR, CANVAS_ID);
  archived.archive();
  await expect(
    archived.service.saveCanvasContent(
      ACTOR,
      CANVAS_ID,
      previous.content,
      previous.revision,
    ),
  ).rejects.toThrow("项目已归档");
});
it("不可信Actor在画布读写前拒绝", async () => {
  const f = await fileService();
  await expect(
    f.service.getCanvas({ ...ACTOR, instanceId: "foreign" }, CANVAS_ID),
  ).rejects.toThrow();
});
