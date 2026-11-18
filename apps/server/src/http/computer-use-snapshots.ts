import { computerUseSnapshotQuerySchema } from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import type { CuSnapshotArchive } from "../features/computer-use/snapshot-archive.js";
import type { LocalAccessService } from "../features/local-access/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";

export function registerComputerUseSnapshotRoutes(
  app: FastifyInstance,
  deps: {
    archive: CuSnapshotArchive;
    localAccess: Pick<LocalAccessService, "authenticate">;
    settings: Pick<SettingsService, "getInstanceSettings">;
  },
) {
  app.get("/api/computer-use/snapshots", async (request, reply) => {
    const actor = await deps.localAccess.authenticate(request);
    if (!actor)
      return reply.code(401).send({
        error: { code: "unauthenticated", message: "请重新建立本机连接。" },
      });
    const parsed = computerUseSnapshotQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({
        error: { code: "invalid_request", message: "截图引用无效。" },
      });
    const settings = await deps.settings.getInstanceSettings(
      actor,
      actor.instanceId,
    );
    const bytes = await deps.archive.read(
      actor,
      parsed.data.taskId,
      parsed.data.digest,
      settings.processMaxOutputBytes,
    );
    if (!bytes)
      return reply.code(404).send({
        error: {
          code: "not_found",
          message: "截图已不可用或不属于当前实例。",
        },
      });
    return reply
      .header("Cache-Control", "no-store")
      .type("image/png")
      .send(Buffer.from(bytes));
  });
}
