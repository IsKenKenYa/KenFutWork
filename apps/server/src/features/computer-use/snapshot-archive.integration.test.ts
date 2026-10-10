import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import Fastify from "fastify";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { registerComputerUseSnapshotRoutes } from "../../http/computer-use-snapshots.js";
import { prepareHarnessTask } from "../agent-runs/test-harness.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCuSnapshotArchive } from "./snapshot-archive.js";

it.skipIf(process.env.KENFUTWORK_TEST_DESKTOP !== "1")(
  "真实Task/Blob/HTTP的大PNG不丢V4投影，模型与MCP字节保留，未授权/错Task/删除后读取拒绝",
  async () => {
    const database = await createTaskWorkDatabase();
    const app = Fastify();
    try {
      const task = await prepareHarnessTask(database);
      const archive = createCuSnapshotArchive({
        blob: createLocalFsBlobStore({
          rootDir: join(database.directory, "blob"),
          publicBaseUrl: "http://127.0.0.1/unused",
          signingSecret: "test",
        }),
        persistence: database.persistence,
      });
      const settings = createSettingsService({
        repository: createSettingsRepository(database.persistence),
        localInstance: database.localInstance,
      });
      registerComputerUseSnapshotRoutes(app, {
        archive,
        localAccess: database.localAccess,
        settings,
      });
      const scopes = createExecutionScopes({
        repository: createScopeRepository(database.persistence),
        localInstance: database.localInstance,
      });
      const handle = await scopes.openTask(task.actor, task.scope.taskId);
      const png = new PNG({ width: 512, height: 512 });
      png.data = randomBytes(png.width * png.height * 4);
      const bytes = PNG.sync.write(png);
      const data = bytes.toString("base64");
      const content = [{ type: "image" as const, mimeType: "image/png", data }];
      const original = {
        content,
        canonicalOutput: {
          content,
          structuredContent: {
            image: { width: png.width, height: png.height, data },
          },
        },
        modelContent: [
          {
            type: "image" as const,
            source_type: "base64" as const,
            mime_type: "image/png" as const,
            data,
          },
        ],
        display: {
          kind: "cua",
          schemaVersion: 1,
          toolName: "mcp__computer-use__screenshot",
          status: "success",
          media: [{ mimeType: "image/png", data }],
        },
      };
      expect(
        protocol.toolOutputSchema.parse({ text: "", display: original.display })
          .display !== undefined,
      ).toBe(false);
      const projected = await archive.project(original, {
        actor: database.actor,
        scopeHandle: handle,
        runId: "actual-run",
        toolCallId: "actual-call",
      });
      expect(projected.content).toEqual(content);
      expect(projected.modelContent).toEqual(original.modelContent);
      expect(JSON.stringify(projected.canonicalOutput)).not.toContain(data);
      const display = protocol.toolOutputSchema.parse({
        text: "",
        display: projected.display,
      }).display;
      if (!display || display.kind !== "cua") throw new Error("大图展示丢失");
      const uri = display.media?.[0]?.artifactUri;
      if (!uri) throw new Error("没有受控大图引用");
      expect(uri).not.toContain(database.desktopToken);
      expect((await app.inject({ url: uri })).statusCode).toBe(401);
      const headers = { authorization: `Bearer ${database.desktopToken}` };
      const response = await app.inject({ url: uri, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
      expect(response.rawPayload).toEqual(bytes);
      expect(
        (
          await app.inject({
            url: uri.replace(
              handle.describe().taskId,
              "00000000-0000-4000-8000-000000000000",
            ),
            headers,
          })
        ).statusCode,
      ).toBe(404);
      await database.persistence
        .forInstance(database.instanceId)
        .execute(
          "update public.code_ui_sessions set deleted_at=now() where instance_id=:instance and id=$1",
          [handle.describe().taskId],
        );
      expect((await app.inject({ url: uri, headers })).statusCode).toBe(404);
    } finally {
      await app.close();
      await database.close();
    }
  },
);
