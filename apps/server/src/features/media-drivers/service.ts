import { createHash, randomUUID } from "node:crypto";
import {
  type MediaDriverConnection,
  type MediaDriverConnectionSave,
  type MediaDriverEnabledRequest,
  type MediaDriverInstallRequest,
  type MediaDriverInstallResponse,
  type MediaDriverRemoveResponse,
  type MediaDriverRevisionRequest,
  type MediaDriverUpdateRequest,
  type MediaDriverVersion,
  mediaDriverVersionSchema,
} from "@kenfutwork/shared";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import { createMediaDriverArtifacts } from "./artifacts.js";
import { describeMediaDriverChanges } from "./changes.js";
import { createMediaDriverConnections } from "./connections.js";
import { MediaDriverRegistryError } from "./errors.js";
import { previewMediaDriverSource } from "./preview.js";
import type { MediaDriverRepository } from "./repository.js";

export type MediaDriverFile = Awaited<
  ReturnType<typeof previewMediaDriverSource>
>;

export interface MediaDriverService {
  connection(
    actor: LocalActor,
    driverId: string,
    providerId: string,
  ): Promise<{ connection: MediaDriverConnection | null }>;
  saveConnection(
    actor: LocalActor,
    driverId: string,
    providerId: string,
    input: MediaDriverConnectionSave,
  ): Promise<{ connection: MediaDriverConnection; replayed: boolean }>;
  connectionCredentials(
    actor: LocalActor,
    driverId: string,
    providerId: string,
  ): Promise<{ secrets: { [key: string]: string } }>;
  preview(actor: LocalActor, source: string): Promise<MediaDriverFile>;
  install(
    actor: LocalActor,
    input: MediaDriverInstallRequest,
  ): Promise<MediaDriverInstallResponse>;
  update(
    actor: LocalActor,
    driverId: string,
    input: MediaDriverUpdateRequest,
  ): Promise<MediaDriverInstallResponse>;
  setEnabled(
    actor: LocalActor,
    driverId: string,
    input: MediaDriverEnabledRequest,
  ): Promise<MediaDriverInstallResponse>;
  remove(
    actor: LocalActor,
    driverId: string,
    input: MediaDriverRevisionRequest,
  ): Promise<MediaDriverRemoveResponse>;
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
  const connections = createMediaDriverConnections(deps.repository);
  const preview = async (actor: LocalActor, source: string) => {
    const { instanceId } = await deps.localInstance.resolve(actor);
    const settings = await deps.settings.getInstanceSettings(actor, instanceId);
    const file = await previewMediaDriverSource(source, {
      maxBytes: settings.mediaDriverMaxSourceBytes,
    });
    const installation = await deps.repository.installation(
      instanceId,
      file.manifest.id,
    );
    const previous =
      installation.state === "installed"
        ? (await deps.repository.versions(instanceId, file.manifest.id))[0]
        : undefined;
    return {
      ...file,
      installation,
      ...(previous
        ? {
            changes: describeMediaDriverChanges(
              previous.manifest,
              file.manifest,
            ),
          }
        : {}),
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

  async function saveVersion(
    actor: LocalActor,
    input: MediaDriverInstallRequest | MediaDriverUpdateRequest,
    driverId?: string,
  ) {
    const release = deps.localInstance.beginAdmission();
    try {
      const context = await deps.localInstance.resolve(actor);
      const file = await preview(actor, input.source);
      if (driverId !== undefined && file.manifest.id !== driverId)
        throw new MediaDriverRegistryError(
          "media_driver_preview_stale",
          "供应商标识不一致，请选择对应文件",
          409,
        );
      const origins = confirmPreview(file, input);
      const version = mediaDriverVersionSchema.parse({
        id: randomUUID(),
        installationId: input.installationId,
        generation:
          input.expectedRevision === 0
            ? input.expectedGeneration + 1
            : input.expectedGeneration,
        revision: input.expectedRevision + 1,
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
      const persist =
        input.expectedRevision === 0
          ? deps.repository.install
          : deps.repository.update;
      const result = await persist(
        {
          instanceId: context.instanceId,
          installationId: input.installationId,
          driverId: file.manifest.id,
          expectedGeneration: input.expectedGeneration,
          expectedRevision: input.expectedRevision,
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

  async function recover() {
    const context = await deps.localInstance.getContext();
    await connections.recover(context.instanceId, context.dataDir);
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
  }

  return {
    async connection(actor, driverId, providerId) {
      const context = await deps.localInstance.resolve(actor);
      return connections.read(context.instanceId, driverId, providerId);
    },
    async saveConnection(actor, driverId, providerId, input) {
      const release = deps.localInstance.beginAdmission();
      try {
        const context = await deps.localInstance.resolve(actor);
        return await connections.save(
          context.instanceId,
          context.dataDir,
          driverId,
          providerId,
          input,
        );
      } finally {
        release();
      }
    },
    async connectionCredentials(actor, driverId, providerId) {
      const context = await deps.localInstance.resolve(actor);
      return connections.credentials(
        context.instanceId,
        context.dataDir,
        driverId,
        providerId,
      );
    },
    preview,
    install: (actor, input) => saveVersion(actor, input),
    update: (actor, driverId, input) => saveVersion(actor, input, driverId),
    async setEnabled(actor, driverId, input) {
      const release = deps.localInstance.beginAdmission();
      try {
        const context = await deps.localInstance.resolve(actor);
        return await deps.repository.setEnabled({
          ...input,
          instanceId: context.instanceId,
          driverId,
          fingerprint: createHash("sha256")
            .update(JSON.stringify({ enabled: input.enabled }))
            .digest("hex"),
        });
      } finally {
        release();
      }
    },
    async remove(actor, driverId, input) {
      const release = deps.localInstance.beginAdmission();
      try {
        const context = await deps.localInstance.resolve(actor);
        const artifacts = createMediaDriverArtifacts(context.dataDir);
        const result = await deps.repository.remove(
          { ...input, instanceId: context.instanceId, driverId },
          async (versions, signal) => {
            for (const version of versions) {
              await artifacts.plan(
                { format: 1, driverId, versionId: version.id },
                signal,
              );
            }
          },
        );
        await recover();
        return result;
      } finally {
        release();
      }
    },
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
    recover,
  };
}
function confirmPreview(
  file: MediaDriverFile,
  input: MediaDriverInstallRequest | MediaDriverUpdateRequest,
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
