import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlobStore } from "../blob/types.js";
import type { LocalAccessService } from "../local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  ProjectFileService,
  ProjectFileWrite,
} from "../project-files/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { ProjectDetailRow } from "../projects/repository.js";
import {
  createFlowProjectFiles,
  FlowProjectFileError,
  type FlowProjectFiles,
} from "./project-files.js";

const roots: string[] = [];
const services: FlowProjectFiles[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(now: () => number = Date.now) {
  const dataDir = await mkdtemp(join(tmpdir(), "flow-project-files-"));
  roots.push(dataDir);
  const projectRoot = join(dataDir, "project");
  await mkdir(projectRoot);
  const instanceId = randomUUID();
  const projectId = randomUUID();
  const actor: LocalActor = { instanceId, accessClientId: "client-1" };
  const rows = new Map<
    string,
    {
      projectId: string;
      relativePath: string;
      version: string;
      mimeType: string;
      bytes: Uint8Array;
    }
  >();
  let revokedListener: ((clientId: string) => void) | undefined;
  let currentRoot = projectRoot;
  let projectKind: "flow" | "design" = "flow";
  let admissions = 0;
  const projectFiles: ProjectFileService = {
    restoreIndex: async () => [],
    async inspect(_actor: LocalActor, assetId: string) {
      const row = rows.get(assetId);
      if (!row || !row.bytes) throw new Error("asset missing");
      return {
        assetId,
        projectId: row.projectId,
        taskId: null,
        canvasId: null,
        relativePath: row.relativePath,
        version: row.version,
        bucket: "project-assets" as const,
        objectPath: `${instanceId}/project-files/${assetId}`,
      };
    },
    relink: async () => {
      throw new Error("test does not relink files");
    },
    describe: async () => {
      throw new Error("test does not describe files directly");
    },
    prepareWrite: async () => {
      throw new Error("test uses the guarded publish port");
    },
    async read(_actor: LocalActor, assetId: string) {
      const row = rows.get(assetId);
      if (!row?.bytes) throw new Error("asset missing");
      return row.bytes;
    },
    async publish(
      _actor: LocalActor,
      input: ProjectFileWrite,
      bytes: Uint8Array,
      beforePublish?: () => Promise<void>,
    ) {
      if (input.target.kind !== "project")
        throw new Error("Flow test only publishes project files");
      await beforePublish?.();
      rows.set(input.assetId, {
        projectId: input.target.projectId,
        relativePath: input.relativePath,
        version: input.writeFingerprint,
        mimeType: input.mimeType,
        bytes,
      });
      return {
        assetId: input.assetId,
        relativePath: input.relativePath,
        version: input.writeFingerprint,
        bucket: "project-assets" as const,
        objectPath: `${instanceId}/project-files/${input.assetId}`,
      };
    },
    async move(
      _actor: LocalActor,
      assetId: string,
      relativePath: string,
      expected?: { expectedRelativePath: string; expectedVersion: string },
      beforePublish?: () => Promise<void>,
    ) {
      const row = rows.get(assetId);
      if (
        !row ||
        !expected ||
        row.relativePath !== expected.expectedRelativePath ||
        row.version !== expected.expectedVersion
      )
        throw new Error("stale move");
      await beforePublish?.();
      row.relativePath = relativePath;
      return {
        assetId,
        relativePath,
        version: row.version,
        bucket: "project-assets" as const,
        objectPath: `${instanceId}/project-files/${assetId}`,
      };
    },
    async remove(
      _actor: LocalActor,
      assetId: string,
      expected: { projectId: string; expectedVersion: string },
      beforeDelete?: () => Promise<void>,
    ) {
      const row = rows.get(assetId);
      if (
        !row ||
        row.projectId !== expected.projectId ||
        row.version !== expected.expectedVersion
      )
        throw new Error("stale remove");
      await beforeDelete?.();
      row.bytes = new Uint8Array();
    },
    namespaceProvider: {
      upload: async () => {},
      download: async () => new Uint8Array(),
      copy: async () => {},
      remove: async () => {},
    },
  };
  const localInstance: LocalInstanceService = {
    getContext: async () => ({ instanceId, dataDir }),
    resolve: async (forActor) => ({
      instanceId: forActor.instanceId,
      dataDir,
    }),
    serviceActor: async () => ({ instanceId, accessClientId: null }),
    isDraining: () => false,
    assertReady: () => {},
    beginAdmission: () => {
      admissions += 1;
      return () => {
        admissions -= 1;
      };
    },
    activeAdmissionCount: () => admissions,
    beginMaintenance: async () => {},
    cancelMaintenance: () => {},
  };
  const localAccess: Pick<LocalAccessService, "onRevoked"> = {
    onRevoked(listener) {
      revokedListener = listener;
      return () => {
        revokedListener = undefined;
      };
    },
  };
  const projects: Pick<ProjectService, "getProject"> = {
    getProject: async (
      _actor: LocalActor,
      id: string,
    ): Promise<ProjectDetailRow> => ({
      id,
      kind: projectKind,
      enabled_modes: [projectKind],
      name: "Flow 项目",
      slug: "flow-project",
      description: null,
      instance_id: instanceId,
      brand_kit_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      work_dir: currentRoot,
      additional_directories: [],
    }),
  };
  const blob: BlobStore = {
    bucket: () => {
      throw new Error("test does not use the raw Blob bucket");
    },
    registerNamespace: () => {},
    resolveNamespace: (_bucket, objectPath) => {
      const assetId = objectPath.split("/").at(-1) ?? "";
      const row = rows.get(assetId);
      return row
        ? {
            bucket: "project-assets",
            namespace: "project-files",
            publicRead: false,
            provider: {
              upload: async () => {},
              download: async () => new Uint8Array(),
              copy: async () => {},
              remove: async () => {},
              contentType: async () => row.mimeType,
            },
          }
        : null;
    },
  };
  let gate = { generation: 1, draining: false };
  const files = createFlowProjectFiles({
    projectControl: { snapshot: async () => ({ ...gate }) },
    now,
    localInstance,
    localAccess,
    projects,
    projectFiles,
    blob,
  });
  services.push(files);
  return {
    actor,
    projectId,
    dataDir,
    rows,
    files,
    revoke(clientId: string) {
      revokedListener?.(clientId);
    },
    changeRoot(root: string) {
      currentRoot = root;
    },
    changeKind(kind: "flow" | "design") {
      projectKind = kind;
    },
    changeGate(generation: number, draining = false) {
      gate = { generation, draining };
    },
    admissions: () => admissions,
  };
}

describe("Flow project file binding", () => {
  it("binds operations to a Flow project and enforces asset version receipts", async () => {
    const f = await fixture();
    const binding = await f.files.issue(f.actor, f.projectId);
    const bytes = Buffer.from("flow asset");
    const version = createHash("sha256").update(bytes).digest("hex");
    const assetId = randomUUID();

    const uploaded = await f.files.upload(
      binding.bindingToken,
      {
        assetId,
        relativePath: "media/image.png",
        mimeType: "image/png",
        writeFingerprint: version,
      },
      bytes,
    );
    const otherProject = await f.files.issue(f.actor, randomUUID());
    await expect(
      f.files.metadata(otherProject.bindingToken, assetId),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.files.metadata(binding.bindingToken, assetId),
    ).resolves.toEqual({
      ...uploaded,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
    });
    await expect(
      f.files.read(binding.bindingToken, assetId, version),
    ).resolves.toEqual(bytes);
    await expect(
      f.files.read(binding.bindingToken, assetId, "0".repeat(64)),
    ).rejects.toBeInstanceOf(FlowProjectFileError);

    await f.files.move(binding.bindingToken, assetId, {
      relativePath: "media/renamed.png",
      expectedRelativePath: uploaded.relativePath,
      expectedVersion: version,
    });
    await f.files.remove(binding.bindingToken, assetId, version);
    expect(f.admissions()).toBe(0);
  });

  it("invalidates all bindings on client revocation, expiry, root changes, and kind changes", async () => {
    let timestamp = 1_000;
    const f = await fixture(() => timestamp);
    const revoked = await f.files.issue(f.actor, f.projectId);
    const revokedSecond = await f.files.issue(f.actor, f.projectId);
    f.revoke("client-1");
    await expect(
      f.files.readLayout(revoked.bindingToken, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      f.files.readLayout(revokedSecond.bindingToken, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 401 });

    const afterRevoke = { ...f.actor, accessClientId: "client-2" };
    const expiring = await f.files.issue(afterRevoke, f.projectId);
    timestamp += 7 * 24 * 60 * 60 * 1000;
    await expect(
      f.files.readLayout(expiring.bindingToken, randomUUID()),
    ).rejects.toMatchObject({
      statusCode: 401,
    });

    const rootBound = await f.files.issue(afterRevoke, f.projectId);
    f.changeRoot(join(f.dataDir, "other-root"));
    await expect(
      f.files.readLayout(rootBound.bindingToken, randomUUID()),
    ).rejects.toMatchObject({
      code: "flow_file_project_changed",
    });
    f.changeRoot(join(f.dataDir, "project"));
    f.changeKind("design");
    // 任意工作方式的项目都可绑定 Flow（用户 2026-10-27 口径）。
    const designBinding = await f.files.issue(afterRevoke, f.projectId);
    expect(designBinding.projectId).toBe(f.projectId);
  });

  it("stores workflow JSON under the fixed managed path with revision CAS", async () => {
    const f = await fixture();
    const binding = await f.files.issue(f.actor, f.projectId);
    const workflowId = randomUUID();
    const first = await f.files.saveLayout(binding.bindingToken, workflowId, {
      content: { nodes: [{ id: "start" }] },
      expectedVersion: null,
    });
    await expect(
      f.files.readLayout(binding.bindingToken, workflowId),
    ).resolves.toEqual(first);
    await expect(
      f.files.saveLayout(binding.bindingToken, workflowId, {
        content: { nodes: [] },
        expectedVersion: null,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const second = await f.files.saveLayout(binding.bindingToken, workflowId, {
      content: { nodes: [] },
      expectedVersion: first.version,
    });
    expect(second.version).not.toBe(first.version);
  });
});

describe("Flow project generation fence", () => {
  it("rejects old bindings and refuses new bindings while draining", async () => {
    const f = await fixture();
    const binding = await f.files.issue(f.actor, f.projectId);
    expect(binding.generation).toBe(1);
    f.changeGate(2, true);
    await expect(
      f.files.readLayout(binding.bindingToken, randomUUID()),
    ).rejects.toThrow("已撤销");
    await expect(f.files.issue(f.actor, f.projectId)).rejects.toThrow("已撤销");
    f.changeGate(2);
    const next = await f.files.issue(f.actor, f.projectId);
    expect(next.generation).toBe(2);
    await expect(
      f.files.readLayout(binding.bindingToken, randomUUID()),
    ).rejects.toThrow("已撤销");
    expect(
      await f.files.readLayout(next.bindingToken, randomUUID()),
    ).toBeNull();
    expect(f.admissions()).toBe(0);
  });
});
