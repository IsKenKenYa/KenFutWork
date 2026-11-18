import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlobStore } from "../blob/types.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { ProjectService } from "../projects/project-service.js";
import type { ProjectDetailRow } from "../projects/repository.js";
import { createProjectFileService } from "./service.js";
import type { ProjectFileRecord, ProjectFileRepository } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "flow-file-delete-"));
  roots.push(dataDir);
  const projectRoot = join(dataDir, "project");
  await mkdir(projectRoot);
  const instanceId = randomUUID();
  const projectId = randomUUID();
  const actor: LocalActor = { instanceId, accessClientId: "client-1" };
  const records = new Map<string, ProjectFileRecord>();
  const repository: ProjectFileRepository = {
    relinkBatch: async () => {},
    relink: async () => {},
    find: async (instance, id) => {
      const row = records.get(id);
      return row?.instance_id === instance ? structuredClone(row) : null;
    },
    prepare: async (record) => {
      if (!records.has(record.id))
        records.set(record.id, structuredClone(record));
      const stored = records.get(record.id);
      if (!stored) throw new Error("missing row");
      return structuredClone(stored);
    },
    complete: async (_instance, id, _fingerprint, byteSize) => {
      const row = records.get(id);
      if (!row) throw new Error("missing row");
      records.set(id, {
        ...row,
        file_state: "ready",
        byte_size: byteSize,
      } as ProjectFileRecord);
    },
    beginMove: async (_instance, id, previous, next) => {
      const row = records.get(id);
      if (!row || row.relative_path !== previous)
        throw new Error("move conflict");
      records.set(id, { ...row, pending_relative_path: next });
    },
    finishMove: async (_instance, id, previous, next) => {
      const row = records.get(id);
      if (
        !row ||
        row.relative_path !== previous ||
        row.pending_relative_path !== next
      )
        throw new Error("move conflict");
      records.set(id, {
        ...row,
        relative_path: next,
        pending_relative_path: null,
      });
    },
  };
  const localInstance: LocalInstanceService = {
    getContext: async () => ({ instanceId, dataDir }),
    resolve: async (forActor: LocalActor) => {
      if (forActor.instanceId !== instanceId)
        throw new Error("foreign instance");
      return { instanceId, dataDir };
    },
    serviceActor: async () => ({ instanceId, accessClientId: null }),
    isDraining: () => false,
    assertReady: () => {},
    beginAdmission: () => () => {},
    activeAdmissionCount: () => 0,
    beginMaintenance: async () => {},
    cancelMaintenance: () => {},
  };
  const executionScopes = createExecutionScopes({
    localInstance,
    repository: { load: async () => null },
  });
  const projects: Pick<ProjectService, "getProject"> = {
    getProject: async (
      _forActor: LocalActor,
      id: string,
    ): Promise<ProjectDetailRow> => ({
      id,
      kind: "flow",
      enabled_modes: ["flow"],
      name: "Flow 项目",
      slug: "flow-project",
      description: null,
      instance_id: instanceId,
      brand_kit_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      work_dir: projectRoot,
      additional_directories: [],
    }),
  };
  const service = createProjectFileService({
    repository,
    localInstance,
    executionScopes,
    projects,
  });
  return { actor, projectId, projectRoot, records, service };
}

const bytes = Buffer.from("saved Flow document");
const fingerprint = createHash("sha256").update(bytes).digest("hex");

describe("project file conditional removal", () => {
  it("removes only the indexed version and keeps an externally changed file", async () => {
    const f = await fixture();
    const input = {
      target: { kind: "project" as const, projectId: f.projectId },
      assetId: randomUUID(),
      relativePath: "workflows/main.json",
      mimeType: "application/json",
      writeFingerprint: fingerprint,
    };
    const receipt = await f.service.publish(f.actor, input, bytes);

    await expect(
      f.service.remove(f.actor, input.assetId, {
        projectId: f.projectId,
        expectedVersion: fingerprint,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(f.projectRoot, receipt.relativePath)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      f.service.remove(f.actor, input.assetId, {
        projectId: f.projectId,
        expectedVersion: fingerprint,
      }),
    ).resolves.toBeUndefined();

    const nextBytes = Buffer.from("external edit");
    const nextFingerprint = createHash("sha256")
      .update(nextBytes)
      .digest("hex");
    const other = {
      ...input,
      assetId: randomUUID(),
      writeFingerprint: nextFingerprint,
    };
    const otherReceipt = await f.service.publish(f.actor, other, nextBytes);
    await writeFile(
      join(f.projectRoot, otherReceipt.relativePath),
      "changed outside Flow",
    );
    await expect(
      f.service.remove(f.actor, other.assetId, {
        projectId: f.projectId,
        expectedVersion: nextFingerprint,
      }),
    ).rejects.toMatchObject({ code: "file_conflict" });
    await expect(
      readFile(join(f.projectRoot, otherReceipt.relativePath), "utf8"),
    ).resolves.toBe("changed outside Flow");
  });

  it("proves project ownership before treating an already missing file as deleted", async () => {
    const f = await fixture();
    const input = {
      target: { kind: "project" as const, projectId: f.projectId },
      assetId: randomUUID(),
      relativePath: "workflows/missing.json",
      mimeType: "application/json",
      writeFingerprint: fingerprint,
    };
    const receipt = await f.service.publish(f.actor, input, bytes);
    await rm(join(f.projectRoot, receipt.relativePath));

    await expect(
      f.service.remove(f.actor, input.assetId, {
        projectId: f.projectId,
        expectedVersion: fingerprint,
      }),
    ).resolves.toBeUndefined();
    await expect(
      f.service.remove(f.actor, input.assetId, {
        projectId: randomUUID(),
        expectedVersion: fingerprint,
      }),
    ).rejects.toMatchObject({ code: "file_conflict" });
  });
});
