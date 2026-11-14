import {
  type MediaDriverConnection,
  type MediaDriverConnectionSave,
  type MediaDriverManifest,
  mediaDriverConnectionSchema,
  mediaDriverManifestSchema,
} from "@kenfutwork/shared";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import { MediaDriverRegistryError } from "./errors.js";
import type { MediaDriverRepository } from "./repository.js";

export type MediaConnectionRow = SqlRow & {
  id: string;
  provider_id: string;
  installation_id: string;
  driver_version_id: string;
  revision: string;
  config_values: unknown;
  secret_keys: unknown;
  credential_origins: unknown;
  credential_digest: string;
  fingerprint: string;
  created_at: string;
};
export function connectionFromRow(
  row: MediaConnectionRow,
): MediaDriverConnection {
  return mediaDriverConnectionSchema.parse({
    id: row.id,
    providerId: row.provider_id,
    installationId: row.installation_id,
    driverVersionId: row.driver_version_id,
    revision: Number(row.revision),
    values: row.config_values,
    secretKeys: row.secret_keys,
    credentialOrigins: row.credential_origins,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

async function requireInstallation(
  sql: InstanceSqlClient,
  driverId: string,
  input: MediaDriverConnectionSave,
) {
  const row = await sql.queryOne<{
    generation: string;
    revision: string;
    current_version: string;
    manifest: unknown;
    approved_origins: string[];
  }>(
    `select d.generation,d.revision,d.current_version,v.manifest,v.approved_origins
     from public.media_driver_registry d join public.media_driver_versions v
     on (v.instance_id=d.instance_id and v.driver_id=d.driver_id and v.id=d.current_version)
     where d.instance_id=:instance and d.driver_id=$1 and d.installation_id=$2 and d.deleted_at is null`,
    [driverId, input.installationId],
  );
  if (!row || Number(row.generation) !== input.expectedGeneration)
    throw new MediaDriverRegistryError(
      "media_driver_removed",
      "安装已改变，请重新打开模型设置",
      410,
    );
  return row;
}

type Prepare = (
  previous: MediaConnectionRow | null,
  manifest: MediaDriverManifest,
  origins: string[],
  versionId: string,
  signal: AbortSignal,
) => Promise<{
  connection: MediaDriverConnection;
  credentialDigest: string;
}>;

export function createMediaDriverConnectionRepository(
  repository: MediaDriverRepository,
) {
  const current = (
    sql: InstanceSqlClient,
    driverId: string,
    providerId: string,
  ) =>
    sql.queryOne<MediaConnectionRow>(
      "select * from public.media_driver_connections where instance_id=:instance and driver_id=$1 and provider_id=$2 order by revision desc limit 1",
      [driverId, providerId],
    );
  return {
    read<T>(
      instanceId: string,
      driverId: string,
      providerId: string,
      read: (row: MediaConnectionRow | null) => Promise<T>,
    ) {
      return repository.withDriver(instanceId, driverId, async (sql) =>
        read(await current(sql, driverId, providerId)),
      );
    },
    save(
      instanceId: string,
      driverId: string,
      providerId: string,
      input: MediaDriverConnectionSave,
      fingerprint: string,
      prepare: Prepare,
    ) {
      const execute = async (sql: InstanceSqlClient, signal: AbortSignal) => {
        const installation = await requireInstallation(sql, driverId, input);
        const prior = await sql.queryOne<MediaConnectionRow>(
          "select * from public.media_driver_connections where instance_id=:instance and installation_id=$1 and provider_id=$2 and revision=$3",
          [
            input.installationId,
            providerId,
            input.expectedConnectionRevision + 1,
          ],
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict();
          return { connection: connectionFromRow(prior), replayed: true };
        }
        const previous = await current(sql, driverId, providerId);
        if (
          Number(previous?.revision ?? 0) !==
            input.expectedConnectionRevision ||
          Number(installation.revision) !== input.expectedRevision
        )
          conflict();
        const provider = await sql.queryOne(
          "select id from public.provider_instances where instance_id=:instance and id=$1 for key share",
          [providerId],
        );
        if (!provider)
          throw new MediaDriverRegistryError(
            "media_driver_not_found",
            "供应商实例不存在，请刷新模型设置",
            404,
          );
        const prepared = await prepare(
          previous,
          mediaDriverManifestSchema.parse(installation.manifest),
          installation.approved_origins,
          installation.current_version,
          signal,
        );
        const connection = prepared.connection;
        signal.throwIfAborted();
        await sql.execute(
          `insert into public.media_driver_connections
           (instance_id,id,driver_id,installation_id,provider_id,driver_version_id,revision,config_values,secret_keys,credential_origins,credential_digest,fingerprint,created_at)
           values (:instance,$1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
          [
            connection.id,
            driverId,
            connection.installationId,
            providerId,
            connection.driverVersionId,
            connection.revision,
            JSON.stringify(connection.values),
            JSON.stringify(connection.secretKeys),
            JSON.stringify(connection.credentialOrigins),
            prepared.credentialDigest,
            fingerprint,
            connection.createdAt,
          ],
        );
        return { connection, replayed: false };
      };
      return repository.withDriver(instanceId, driverId, execute);
    },
    recover(
      instanceId: string,
      driverId: string,
      id: string,
      discard: () => Promise<void>,
    ) {
      return repository.withDriver(instanceId, driverId, async (sql) => {
        const row = await sql.queryOne(
          "select id from public.media_driver_connections where instance_id=:instance and id=$1",
          [id],
        );
        if (!row) await discard();
      });
    },
  };
}
function conflict(): never {
  throw new MediaDriverRegistryError(
    "media_driver_conflict",
    "连接已改变，请刷新后保存",
    409,
  );
}
