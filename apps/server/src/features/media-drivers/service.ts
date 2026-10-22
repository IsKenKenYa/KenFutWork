import { createHash, randomUUID } from "node:crypto";
import {
  type MediaDriverInstallRequest,
  type MediaDriverInstallResponse,
  type MediaDriverVersion,
  mediaDriverVersionSchema,
} from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import { createMediaDriverArtifacts } from "./artifacts.js";
import { MediaDriverRegistryError } from "./errors.js";
import { previewMediaDriverSource } from "./preview.js";
import type { MediaDriverRepository } from "./repository.js";

export type MediaDriverFile = Awaited<
  ReturnType<typeof previewMediaDriverSource>
>;

export interface MediaDriverService {
  preview(actor: LocalActor, source: string): Promise<MediaDriverFile>;
  install(
    actor: LocalActor,
    input: MediaDriverInstallRequest,
  ): Promise<MediaDriverInstallResponse>;
  versions(
    actor: LocalActor,
    driverId: string,
  ): Promise<{ versions: MediaDriverVersion[] }>;
  source(
    actor: LocalActor,
    driverId: string,
    versionId: string,
  ): Promise<{ source: string; sourceDigest: string }>;
  recover(): Promise<void>;
}

export function createMediaDriverService(deps: {
  localInstance: LocalInstanceService;
  settings: SettingsService;
  repository: MediaDriverRepository;
}): MediaDriverService {
  const preview = async (actor: LocalActor, source: string) => {
    const { instanceId } = await deps.localInstance.resolve(actor);
    const settings = await deps.settings.getInstanceSettings(actor, instanceId);
    const file = await previewMediaDriverSource(source, {
      maxBytes: settings.mediaDriverMaxSourceBytes,
    });
    return {
      ...file,
      installation: await deps.repository.installation(
        instanceId,
        file.manifest.id,
      ),
    };
  };

  const requireInstalled = async (actor: LocalActor, driverId: string) => {
    const context = await deps.localInstance.resolve(actor);
    const current = await deps.repository.installation(
      context.instanceId,
      driverId,
    );
    if (current.state !== "installed")
      throw new MediaDriverRegistryError(
        current.state === "removed"
          ? "media_driver_removed"
          : "media_driver_not_found",
        "供应商文件未安装，请重新打开模型设置",
        current.state === "removed" ? 410 : 404,
      );
    return context;
  };

  async function install(actor: LocalActor, input: MediaDriverInstallRequest) {
    const release = deps.localInstance.beginAdmission();
    try {
      const context = await deps.localInstance.resolve(actor);
      const file = await preview(actor, input.source);
      const origins = confirmPreview(file, input);
      const version = mediaDriverVersionSchema.parse({
        id: randomUUID(),
        generation: input.expectedGeneration + 1,
        revision: 1,
        sourceDigest: file.sourceDigest,
        compiledDigest: file.compiledDigest,
        sourceBytes: file.sourceBytes,
        manifest: file.manifest,
        methods: file.methods,
        approvedOrigins: origins,
        createdAt: new Date().toISOString(),
      });
      const artifacts = createMediaDriverArtifacts(context.dataDir);
      const artifact = {
        format: 1 as const,
        driverId: file.manifest.id,
        versionId: version.id,
      };
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            sourceDigest: file.sourceDigest,
            compiledDigest: file.compiledDigest,
            origins,
          }),
        )
        .digest("hex");
      let prepared = false;
      // 提交回包丢失时仍可能已保存版本；恢复在同一驱动锁内核对后清理文件。
      const result = await deps.repository.install(
        {
          instanceId: context.instanceId,
          driverId: file.manifest.id,
          expectedGeneration: input.expectedGeneration,
          fingerprint,
          version,
        },
        async (signal) => {
          prepared = true;
          await artifacts.prepare(
            artifact,
            { source: input.source, compiledCode: file.compiledCode },
            signal,
          );
        },
      );
      if (prepared) await artifacts.finish(artifact);
      return result;
    } finally {
      release();
    }
  }

  return {
    preview,
    install,
    async versions(actor, driverId) {
      const context = await requireInstalled(actor, driverId);
      return {
        versions: await deps.repository.versions(context.instanceId, driverId),
      };
    },
    async source(actor, driverId, versionId) {
      const context = await requireInstalled(actor, driverId);
      const version = await deps.repository.version(
        context.instanceId,
        driverId,
        versionId,
      );
      if (!version)
        throw new MediaDriverRegistryError(
          "media_driver_not_found",
          "供应商版本不存在，请刷新列表",
          404,
        );
      return {
        source: await createMediaDriverArtifacts(context.dataDir).readSource(
          driverId,
          version,
        ),
        sourceDigest: version.sourceDigest,
      };
    },
    async recover() {
      const context = await deps.localInstance.getContext();
      const artifacts = createMediaDriverArtifacts(context.dataDir);
      for (const artifact of await artifacts.pending()) {
        await deps.repository.recoverArtifact(
          context.instanceId,
          artifact.driverId,
          artifact.versionId,
          async (referenced) => {
            if (referenced) await artifacts.finish(artifact);
            else await artifacts.discard(artifact);
          },
        );
      }
    },
  };
}
function confirmPreview(
  file: MediaDriverFile,
  input: MediaDriverInstallRequest,
) {
  if (
    file.sourceDigest !== input.sourceDigest ||
    file.compiledDigest !== input.compiledDigest
  )
    throw new MediaDriverRegistryError(
      "media_driver_preview_stale",
      "文件已改变，请重新预览后添加",
      409,
    );
  const origins = [
    ...new Set(input.approvedOrigins.map((origin) => new URL(origin).origin)),
  ].sort();
  const declared = [
    ...new Set(file.manifest.origins.map((origin) => new URL(origin).origin)),
  ].sort();
  if (JSON.stringify(origins) !== JSON.stringify(declared))
    throw new MediaDriverRegistryError(
      "media_driver_permissions",
      "请确认文件声明的全部访问地址",
      400,
    );
  return origins;
}
