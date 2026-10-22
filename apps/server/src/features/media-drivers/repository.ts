import { randomUUID } from "node:crypto";
import {
  type MediaDriverInstallation,
  type MediaDriverInstallResponse,
  type MediaDriverRemoveResponse,
  type MediaDriverRevisionRequest,
  type MediaDriverVersion,
  mediaDriverInstallResponseSchema,
  mediaDriverVersionSchema,
} from "@kenfutwork/shared";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import { MediaDriverRegistryError } from "./errors.js";

type RegistryRow = SqlRow & {
  driver_id: string;
  installation_id: string;
  generation: string;
  revision: string;
  enabled: boolean;
  current_version: string | null;
  deleted_at: string | null;
};
type VersionRow = SqlRow & {
  id: string;
  installation_id: string;
  generation: string;
  revision: string;
  source_digest: string;
  compiled_digest: string;
  source_bytes: string;
  manifest: unknown;
  methods: unknown;
  approved_origins: unknown;
  created_at: string;
};

function versionFromRow(row: VersionRow): MediaDriverVersion {
  return mediaDriverVersionSchema.parse({
    id: row.id,
    installationId: row.installation_id,
    generation: Number(row.generation),
    revision: Number(row.revision),
    sourceDigest: row.source_digest,
    compiledDigest: row.compiled_digest,
    sourceBytes: Number(row.source_bytes),
    manifest: row.manifest,
    methods: row.methods,
    approvedOrigins: row.approved_origins,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

async function findRegistry(scoped: InstanceSqlClient, driverId: string) {
  return scoped.queryOne<RegistryRow>(
    "select * from public.media_driver_registry where instance_id=:instance and driver_id=$1",
    [driverId],
  );
}

async function insertVersion(
  scoped: InstanceSqlClient,
  driverId: string,
  version: MediaDriverVersion,
) {
  await scoped.execute(
    `insert into public.media_driver_versions
       (instance_id,driver_id,id,generation,revision,source_digest,compiled_digest,
        source_bytes,manifest,methods,approved_origins,created_at,installation_id)
     values (:instance,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)`,
    [
      driverId,
      version.id,
      version.generation,
      version.revision,
      version.sourceDigest,
      version.compiledDigest,
      version.sourceBytes,
      JSON.stringify(version.manifest),
      JSON.stringify(version.methods),
      JSON.stringify(version.approvedOrigins),
      version.createdAt,
      version.installationId,
    ],
  );
}

type OperationInput = {
  instanceId: string;
  driverId: string;
  installationId: string;
  expectedGeneration: number;
  expectedRevision: number;
  fingerprint: string;
};
type InstallInput = OperationInput & {
  version: MediaDriverVersion;
};

function removed(): never {
  throw new MediaDriverRegistryError(
    "media_driver_removed",
    "安装已移除，请重新预览文件",
    410,
  );
}

async function lockInstallation(
  scoped: InstanceSqlClient,
  installationId: string,
) {
  await scoped.query(
    "select pg_advisory_xact_lock(hashtextextended(:instance::text || ':' || $1,0))",
    [`media-installation:${installationId}`],
  );
}

type RemovalRow = SqlRow & {
  installation_id: string;
  generation: string;
  removed_at: string;
};

async function findRemoval(scoped: InstanceSqlClient, installationId: string) {
  return scoped.queryOne<RemovalRow>(
    "select * from public.media_driver_removals where instance_id=:instance and installation_id=$1",
    [installationId],
  );
}

async function requireUnremoved(
  scoped: InstanceSqlClient,
  installationId: string,
) {
  await lockInstallation(scoped, installationId);
  if (await findRemoval(scoped, installationId)) removed();
}

async function findInstallReceipt(
  scoped: InstanceSqlClient,
  input: InstallInput,
) {
  const row = await findRegistry(scoped, input.driverId);
  if (row && row.installation_id !== input.installationId)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "供应商已安装，请重新预览文件",
      409,
    );
  if (
    row &&
    (row.deleted_at || Number(row.generation) !== input.expectedGeneration + 1)
  ) {
    if (Number(row.generation) !== input.expectedGeneration || !row.deleted_at)
      throw new MediaDriverRegistryError(
        "media_driver_removed",
        "安装代际已改变，请重新预览文件",
        410,
      );
  }
  const prior = await findOperation(scoped, input, "install");
  if (prior) return prior;
  if (row && !row.deleted_at)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "供应商文件已安装，请使用更新操作",
      409,
    );
  if (!row && input.expectedGeneration !== 0)
    throw new MediaDriverRegistryError(
      "media_driver_removed",
      "安装代际已改变，请重新预览文件",
      410,
    );
  return null;
}

async function findOperation(
  scoped: InstanceSqlClient,
  input: OperationInput,
  kind: "install" | "update" | "enabled",
) {
  const prior = await scoped.queryOne<{
    fingerprint: string;
    receipt: unknown;
  }>(
    `select fingerprint,receipt from public.media_driver_operations
     where instance_id=:instance and driver_id=$1 and generation=$2
       and expected_revision=$3 and kind=$4`,
    [input.driverId, input.expectedGeneration, input.expectedRevision, kind],
  );
  if (prior) {
    if (prior.fingerprint !== input.fingerprint)
      throw new MediaDriverRegistryError(
        "media_driver_conflict",
        "本次操作的文件或权限已改变，请重新预览",
        409,
      );
    return {
      ...mediaDriverInstallResponseSchema.parse(prior.receipt),
      replayed: true,
    };
  }
  return null;
}

async function installVersion(
  scoped: InstanceSqlClient,
  signal: AbortSignal,
  input: InstallInput,
  prepare: (signal: AbortSignal) => Promise<void>,
): Promise<MediaDriverInstallResponse> {
  await requireUnremoved(scoped, input.installationId);
  const bound = await scoped.queryOne<{ driver_id: string }>(
    "select driver_id from public.media_driver_registry where instance_id=:instance and installation_id=$1",
    [input.installationId],
  );
  if (bound && bound.driver_id !== input.driverId)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "安装标识已使用，请重新预览文件",
      409,
    );
  const prior = await findInstallReceipt(scoped, input);
  if (prior) return prior;
  await prepare(signal);
  signal.throwIfAborted();
  await scoped.execute(
    `insert into public.media_driver_registry
       (instance_id,driver_id,generation,revision,enabled,current_version,deleted_at,installation_id)
     values (:instance,$1,$2,1,true,$3,null,$4)
     on conflict(instance_id,driver_id) do update set
       generation=excluded.generation,revision=1,enabled=true,
       current_version=excluded.current_version,deleted_at=null,installation_id=excluded.installation_id`,
    [
      input.driverId,
      input.version.generation,
      input.version.id,
      input.installationId,
    ],
  );
  await insertVersion(scoped, input.driverId, input.version);
  return saveOperation(scoped, input, "install", true);
}

async function saveOperation(
  scoped: InstanceSqlClient,
  input: InstallInput,
  kind: "install" | "update" | "enabled",
  enabled: boolean,
) {
  const receipt: MediaDriverInstallResponse = {
    driver: {
      id: input.driverId,
      installationId: input.installationId,
      generation: input.version.generation,
      revision: input.expectedRevision + 1,
      enabled,
      currentVersion: input.version,
    },
    replayed: false,
  };
  await scoped.execute(
    `insert into public.media_driver_operations
       (instance_id,driver_id,generation,expected_revision,kind,fingerprint,receipt)
     values (:instance,$1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.driverId,
      input.expectedGeneration,
      input.expectedRevision,
      kind,
      input.fingerprint,
      JSON.stringify(receipt),
    ],
  );
  return receipt;
}

async function updateVersion(
  scoped: InstanceSqlClient,
  signal: AbortSignal,
  input: InstallInput,
  prepare: (signal: AbortSignal) => Promise<void>,
): Promise<MediaDriverInstallResponse> {
  await requireUnremoved(scoped, input.installationId);
  const row = await findRegistry(scoped, input.driverId);
  if (
    !row ||
    row.installation_id !== input.installationId ||
    row.deleted_at ||
    Number(row.generation) !== input.expectedGeneration
  )
    throw new MediaDriverRegistryError(
      "media_driver_removed",
      "安装代际已改变，请重新预览文件",
      410,
    );
  const prior = await findOperation(scoped, input, "update");
  if (prior) return prior;
  if (Number(row.revision) !== input.expectedRevision)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "版本已改变，请重新预览文件",
      409,
    );
  await prepare(signal);
  signal.throwIfAborted();
  await insertVersion(scoped, input.driverId, input.version);
  const count = await scoped.execute(
    `update public.media_driver_registry set current_version=$2,revision=$3
     where instance_id=:instance and driver_id=$1 and generation=$4 and revision=$5 and deleted_at is null`,
    [
      input.driverId,
      input.version.id,
      input.version.revision,
      input.expectedGeneration,
      input.expectedRevision,
    ],
  );
  if (count !== 1)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "版本已改变，请重新预览文件",
      409,
    );
  return saveOperation(scoped, input, "update", row.enabled);
}

type RevisionInput = MediaDriverRevisionRequest & {
  instanceId: string;
  driverId: string;
};

async function requireCurrent(scoped: InstanceSqlClient, input: RevisionInput) {
  const row = await findRegistry(scoped, input.driverId);
  if (
    !row ||
    row.deleted_at ||
    row.installation_id !== input.installationId ||
    Number(row.generation) !== input.expectedGeneration
  )
    removed();
  return row;
}

function requireRevision(row: RegistryRow, expectedRevision: number) {
  if (Number(row.revision) !== expectedRevision)
    throw new MediaDriverRegistryError(
      "media_driver_conflict",
      "版本已改变，请刷新供应商设置",
      409,
    );
}

async function changeEnabled(
  scoped: InstanceSqlClient,
  input: OperationInput & { enabled: boolean },
) {
  await requireUnremoved(scoped, input.installationId);
  const row = await requireCurrent(scoped, input);
  const prior = await findOperation(scoped, input, "enabled");
  if (prior) return prior;
  requireRevision(row, input.expectedRevision);
  const stored = await scoped.queryOne<VersionRow>(
    "select * from public.media_driver_versions where instance_id=:instance and driver_id=$1 and id=$2",
    [input.driverId, row.current_version],
  );
  if (!stored)
    throw new MediaDriverRegistryError(
      "media_driver_storage_error",
      "供应商版本缺失，请恢复应用数据目录",
      503,
    );
  await scoped.execute(
    "update public.media_driver_registry set enabled=$2,revision=revision+1 where instance_id=:instance and driver_id=$1 and installation_id=$3 and revision=$4",
    [
      input.driverId,
      input.enabled,
      input.installationId,
      input.expectedRevision,
    ],
  );
  return saveOperation(
    scoped,
    { ...input, version: versionFromRow(stored) },
    "enabled",
    input.enabled,
  );
}

async function assertUnused(scoped: InstanceSqlClient, installationId: string) {
  const active = await scoped.queryOne(
    `select id from public.background_jobs
     where instance_id=:instance and payload->'_media_driver'->>'installationId'=$1
       and (status in ('queued','running')
         or (status='failed' and (provider_job_id is not null or error_code='submission_unknown'
           or payload->'_generation_execution'->>'phase' in ('ready','saving','publishing')))
         or (status='canceled' and (payload->'_generation_cancel'->>'state'='pending'
           or (payload->'_generation_cancel'->>'state'='unknown'
             and payload->'_generation_execution'->>'phase'='submitting'))))
     limit 1`,
    [installationId],
  );
  if (active)
    throw new MediaDriverRegistryError(
      "media_driver_in_use",
      "仍有生成任务，请先停用并等待结束",
      409,
    );
}

async function removeDriver(
  scoped: InstanceSqlClient,
  signal: AbortSignal,
  input: RevisionInput,
  prepare: (
    versions: MediaDriverVersion[],
    signal: AbortSignal,
  ) => Promise<void>,
): Promise<MediaDriverRemoveResponse> {
  await lockInstallation(scoped, input.installationId);
  const prior = await findRemoval(scoped, input.installationId);
  if (prior)
    return {
      installationId: prior.installation_id,
      generation: Number(prior.generation),
      removedAt: new Date(prior.removed_at).toISOString(),
      replayed: true,
    };
  const row = await requireCurrent(scoped, input);
  requireRevision(row, input.expectedRevision);
  await assertUnused(scoped, input.installationId);
  const versions = await scoped.query<VersionRow>(
    "select * from public.media_driver_versions where instance_id=:instance and installation_id=$1",
    [input.installationId],
  );
  await prepare(versions.map(versionFromRow), signal);
  signal.throwIfAborted();
  const receipt: MediaDriverRemoveResponse = {
    installationId: input.installationId,
    generation: Number(row.generation) + 1,
    removedAt: new Date().toISOString(),
    replayed: false,
  };
  await scoped.execute(
    "insert into public.media_driver_removals (instance_id,installation_id,generation,removed_at) values (:instance,$1,$2,$3)",
    [input.installationId, receipt.generation, receipt.removedAt],
  );
  await scoped.execute(
    "delete from public.media_driver_registry where instance_id=:instance and driver_id=$1 and installation_id=$2 and revision=$3",
    [input.driverId, input.installationId, input.expectedRevision],
  );
  return receipt;
}

export function createMediaDriverRepository(persistence: PersistenceService) {
  const withDriver = <T>(
    instanceId: string,
    driverId: string,
    operation: (scoped: InstanceSqlClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    persistence.withSessionTransaction(async (tx, signal) => {
      const scoped = tx.forInstance(instanceId);
      await scoped.query(
        "select pg_advisory_xact_lock(hashtextextended(:instance::text || ':' || $1,0))",
        [`media-driver:${driverId}`],
      );
      await scoped.query(
        "select driver_id from public.media_driver_registry where instance_id=:instance and driver_id=$1 for update",
        [driverId],
      );
      return operation(scoped, signal);
    });

  return {
    async installation(
      instanceId: string,
      driverId: string,
    ): Promise<MediaDriverInstallation> {
      const row = await findRegistry(
        persistence.forInstance(instanceId),
        driverId,
      );
      return {
        id: driverId,
        installationId: row?.installation_id ?? randomUUID(),
        generation: row ? Number(row.generation) : 0,
        revision: row ? Number(row.revision) : 0,
        state: row ? (row.deleted_at ? "removed" : "installed") : "new",
        enabled: row?.enabled ?? false,
      };
    },
    async install(
      input: InstallInput,
      prepare: (signal: AbortSignal) => Promise<void>,
    ): Promise<MediaDriverInstallResponse> {
      return withDriver(input.instanceId, input.driverId, (scoped, signal) =>
        installVersion(scoped, signal, input, prepare),
      );
    },
    async update(
      input: InstallInput,
      prepare: (signal: AbortSignal) => Promise<void>,
    ): Promise<MediaDriverInstallResponse> {
      return withDriver(input.instanceId, input.driverId, (scoped, signal) =>
        updateVersion(scoped, signal, input, prepare),
      );
    },
    async setEnabled(input: OperationInput & { enabled: boolean }) {
      return withDriver(input.instanceId, input.driverId, (scoped) =>
        changeEnabled(scoped, input),
      );
    },
    async remove(
      input: RevisionInput,
      prepare: (
        versions: MediaDriverVersion[],
        signal: AbortSignal,
      ) => Promise<void>,
    ) {
      return withDriver(input.instanceId, input.driverId, (scoped, signal) =>
        removeDriver(scoped, signal, input, prepare),
      );
    },
    async versions(instanceId: string, driverId: string) {
      const rows = await persistence.forInstance(instanceId).query<VersionRow>(
        `select v.* from public.media_driver_versions v
         join public.media_driver_registry d using(instance_id,driver_id)
         where v.instance_id=:instance and v.driver_id=$1 and d.deleted_at is null
         order by v.generation desc,v.revision desc`,
        [driverId],
      );
      return rows.map(versionFromRow);
    },
    async version(instanceId: string, driverId: string, versionId: string) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<VersionRow>(
          `select v.* from public.media_driver_versions v
         join public.media_driver_registry d using(instance_id,driver_id)
         where v.instance_id=:instance and v.driver_id=$1 and v.id=$2 and d.deleted_at is null`,
          [driverId, versionId],
        );
      return row ? versionFromRow(row) : null;
    },
    async recoverArtifact(
      instanceId: string,
      driverId: string,
      versionId: string,
      recover: (referenced: boolean) => Promise<void>,
    ) {
      await withDriver(instanceId, driverId, async (scoped) => {
        const row = await scoped.queryOne(
          "select id from public.media_driver_versions where instance_id=:instance and driver_id=$1 and id=$2",
          [driverId, versionId],
        );
        await recover(row !== null);
      });
    },
  };
}

export type MediaDriverRepository = ReturnType<
  typeof createMediaDriverRepository
>;
