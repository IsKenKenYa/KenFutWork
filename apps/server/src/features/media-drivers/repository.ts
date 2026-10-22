import {
  type MediaDriverInstallation,
  type MediaDriverInstallResponse,
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
  generation: string;
  revision: string;
  enabled: boolean;
  current_version: string | null;
  deleted_at: string | null;
};
type VersionRow = SqlRow & {
  id: string;
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
        source_bytes,manifest,methods,approved_origins,created_at)
     values (:instance,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
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
    ],
  );
}

type InstallInput = {
  instanceId: string;
  driverId: string;
  expectedGeneration: number;
  fingerprint: string;
  version: MediaDriverVersion;
};

async function findInstallReceipt(
  scoped: InstanceSqlClient,
  input: InstallInput,
) {
  const row = await findRegistry(scoped, input.driverId);
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
  const prior = await scoped.queryOne<{
    fingerprint: string;
    receipt: unknown;
  }>(
    `select fingerprint,receipt from public.media_driver_operations
     where instance_id=:instance and driver_id=$1 and generation=$2
       and expected_revision=0 and kind='install'`,
    [input.driverId, input.expectedGeneration],
  );
  if (prior) {
    if (prior.fingerprint !== input.fingerprint)
      throw new MediaDriverRegistryError(
        "media_driver_conflict",
        "同一次安装的文件或权限已改变，请重新预览",
        409,
      );
    return {
      ...mediaDriverInstallResponseSchema.parse(prior.receipt),
      replayed: true,
    };
  }
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

async function installVersion(
  scoped: InstanceSqlClient,
  signal: AbortSignal,
  input: InstallInput,
  prepare: (signal: AbortSignal) => Promise<void>,
): Promise<MediaDriverInstallResponse> {
  const prior = await findInstallReceipt(scoped, input);
  if (prior) return prior;
  await prepare(signal);
  signal.throwIfAborted();
  await scoped.execute(
    `insert into public.media_driver_registry
       (instance_id,driver_id,generation,revision,enabled,current_version,deleted_at)
     values (:instance,$1,$2,1,true,$3,null)
     on conflict(instance_id,driver_id) do update set
       generation=excluded.generation,revision=1,enabled=true,
       current_version=excluded.current_version,deleted_at=null`,
    [input.driverId, input.version.generation, input.version.id],
  );
  await insertVersion(scoped, input.driverId, input.version);
  const receipt: MediaDriverInstallResponse = {
    driver: {
      id: input.driverId,
      generation: input.version.generation,
      revision: 1,
      enabled: true,
      currentVersion: input.version,
    },
    replayed: false,
  };
  await scoped.execute(
    `insert into public.media_driver_operations
       (instance_id,driver_id,generation,expected_revision,kind,fingerprint,receipt)
     values (:instance,$1,$2,0,'install',$3,$4::jsonb)`,
    [
      input.driverId,
      input.expectedGeneration,
      input.fingerprint,
      JSON.stringify(receipt),
    ],
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
