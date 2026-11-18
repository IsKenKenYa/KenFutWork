import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import type { ExecutionScopes } from "../execution/scope-service.js";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createProjectFileRepository } from "../project-files/repository.js";
import { createProjectFileService } from "../project-files/service.js";
import type { ProjectFileService } from "../project-files/types.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例画布真实 Postgres",
  () => {
    it("真实父链、内容覆盖、原子并发追加和越界拒绝成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const projectRoot = join(database.directory, "canvas-project");
        await mkdir(projectRoot);
        const { canvas, project } = await createProjectRepository(
          database.persistence,
        ).createProject({
          instanceId,
          createdByClientId: null,
          name: "画布",
          slug: `canvas-${randomUUID()}`,
          description: null,
          kind: "design",
          canvasName: "主画布",
          workDir: projectRoot,
        });
        if (!canvas) throw new Error("主画布未创建。");
        const repository = createCanvasRepository(database.persistence);
        const actor = { instanceId, accessClientId: null };
        const projects = createProjectRepository(database.persistence);
        const blob = createLocalFsBlobStore({
          rootDir: join(database.directory, "canvas-blob"),
          publicBaseUrl: "http://localhost/api/blobs",
          signingSecret: "canvas-blob-test-secret",
        });
        const projectFileRepository = createProjectFileRepository(
          database.persistence,
        );
        const projectFiles: ProjectFileService = createProjectFileService({
          repository: projectFileRepository,
          canvases: repository,
          localInstance: database.localInstance,
          projects: {
            getProject: async (current, id) => {
              const project = await projects.findActiveById(
                current.instanceId,
                id,
              );
              if (!project) throw new Error("项目不存在");
              return project;
            },
          },
          executionScopes: {
            openTask: async () => {
              throw new Error("Canvas project assets do not use Code Tasks");
            },
          } as Pick<ExecutionScopes, "openTask">,
        });
        blob.registerNamespace({
          bucket: "project-assets",
          namespace: "project-files",
          provider: projectFiles.namespaceProvider,
          publicRead: false,
        });
        const legacyBucket = blob.bucket("project-assets");
        const sourceBytes = new Map([
          ["first.png", Buffer.from("first-image")],
          ["second.png", Buffer.from("second-image")],
        ]);
        for (const [objectPath, bytes] of sourceBytes) {
          await blob.bucket("project-assets").upload(objectPath, bytes, {
            contentType: "image/png",
          });
        }
        const service = createCanvasService({
          repository,
          localInstance: database.localInstance,
          projects: {
            getProject: async (_actor, id) => {
              const project = await projects.findActiveById(instanceId, id);
              if (!project) throw new Error("项目不存在");
              return project;
            },
          },
          blob,
          projectFiles,
        });
        const initial = await service.getCanvas(actor, canvas.id);
        expect(initial.revision).toMatch(/^[a-f0-9]{64}$/u);
        const overwritten = await service.saveCanvasContent(
          actor,
          canvas.id,
          { elements: [], appState: { theme: "light" }, files: {} },
          initial.revision,
        );
        expect(overwritten.revision).not.toBe(initial.revision);
        expect(
          (await service.getCanvas(actor, canvas.id)).content.appState,
        ).toMatchObject({ theme: "light" });
        await Promise.all(
          ["first", "second"].map((name) =>
            service.insertImageElement(actor, {
              canvasId: canvas.id,
              objectPath: `${name}.png`,
              width: 100,
              height: 100,
              mimeType: "image/png",
            }),
          ),
        );
        const row = await repository.findById(instanceId, canvas.id);
        expect(row?.content).toMatchObject({ storage: "project-files" });
        const firstRead = await service.getCanvas(actor, canvas.id);
        expect(firstRead.content.elements).toHaveLength(2);
        const migratedFiles = Object.values(firstRead.content.files);
        expect(migratedFiles).toHaveLength(2);
        const projectAssetRows: Array<{
          id: string;
          project_id: string;
          relative_path: string;
          write_fingerprint: string;
          file_state: string;
          task_id: string | null;
          byte_size: number;
          bucket: string;
          object_path: string;
        }> = [];
        for (const file of migratedFiles) {
          expect(file).toMatchObject({
            assetId: expect.any(String),
            relativePath: expect.stringMatching(/^canvas-[a-f0-9-]{36}\.png$/u),
            storageRef: expect.stringMatching(
              /^oss:\/\/project-assets\/[a-f0-9-]{36}\/project-files\/[a-f0-9-]{36}$/u,
            ),
          });
          const assetId = file.assetId as string;
          const indexed = await database.persistence
            .forInstance(instanceId)
            .queryOne<(typeof projectAssetRows)[number]>(
              "select id, project_id, relative_path, write_fingerprint, file_state, task_id, byte_size::int as byte_size, bucket, object_path from public.asset_objects where instance_id=:instance and id=$1",
              [assetId],
            );
          if (!indexed) throw new Error("项目文件索引行缺失");
          projectAssetRows.push(indexed);
          expect(indexed).toMatchObject({
            id: assetId,
            project_id: project.id,
            relative_path: file.relativePath,
            file_state: "ready",
            task_id: null,
            bucket: "project-assets",
            object_path: `${instanceId}/project-files/${assetId}`,
          });
          const bytes = await readFile(
            join(projectRoot, file.relativePath as string),
          );
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            indexed.write_fingerprint,
          );
          expect(indexed.byte_size).toBe(bytes.byteLength);
        }
        expect(
          projectAssetRows.map((row) => row.write_fingerprint).sort(),
        ).toEqual(
          [...sourceBytes.values()]
            .map((bytes) => createHash("sha256").update(bytes).digest("hex"))
            .sort(),
        );
        const fileStats = await Promise.all(
          migratedFiles.map((file) =>
            stat(join(projectRoot, file.relativePath as string), {
              bigint: true,
            }).then(({ ino, size, mtimeNs }) => ({ ino, size, mtimeNs })),
          ),
        );
        const secondRead = await service.getCanvas(actor, canvas.id);
        expect(secondRead.revision).toBe(firstRead.revision);
        expect(
          await Promise.all(
            migratedFiles.map((file) =>
              stat(join(projectRoot, file.relativePath as string), {
                bigint: true,
              }).then(({ ino, size, mtimeNs }) => ({ ino, size, mtimeNs })),
            ),
          ),
        ).toEqual(fileStats);
        for (const [objectPath, bytes] of sourceBytes) {
          expect(Buffer.from(await legacyBucket.download(objectPath))).toEqual(
            bytes,
          );
          expect(
            Buffer.from(
              await blob.bucket("project-assets").download(objectPath),
            ),
          ).toEqual(bytes);
        }
        await expect(
          projectFiles.read(
            { ...actor, instanceId: randomUUID() },
            migratedFiles[0]!.assetId as string,
          ),
        ).rejects.toThrow();
        const foreign = randomUUID();
        expect(await repository.findById(foreign, canvas.id)).toBeNull();
        expect(await repository.recordFileIndex(foreign, canvas.id)).toBe(0);
      } finally {
        await database.close();
      }
    });
  },
);
