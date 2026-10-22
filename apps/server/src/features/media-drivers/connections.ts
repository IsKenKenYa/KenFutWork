import { createHash, randomUUID } from "node:crypto";
import type {
  MediaDriverConnectionSave,
  MediaDriverManifest,
} from "@kenfutwork/shared";
import { createMediaDriverConnectionFiles } from "./connection-files.js";
import {
  connectionFromRow,
  createMediaDriverConnectionRepository,
} from "./connection-repository.js";
import { MediaDriverRegistryError } from "./errors.js";
import type { MediaDriverRepository } from "./repository.js";

function invalid(): never {
  throw new MediaDriverRegistryError(
    "media_driver_permissions",
    "请检查连接字段和凭据授权地址",
    400,
  );
}
function own<T>(values: { [key: string]: T }, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}
function fields(
  manifest: MediaDriverManifest,
  input: MediaDriverConnectionSave,
  previous: {
    values: { [key: string]: string };
    secrets: { [key: string]: string };
  },
) {
  const declared = new Map(
    manifest.connectionFields.map((field) => [field.key, field]),
  );
  for (const key of Object.keys(input.values)) {
    if (!declared.has(key) || declared.get(key)?.secret) invalid();
  }
  for (const key of Object.keys(input.secrets)) {
    if (!declared.get(key)?.secret) invalid();
  }
  const values: { [key: string]: string } = {};
  const secrets: { [key: string]: string } = {};
  for (const field of manifest.connectionFields) {
    const submitted = own(input.secrets, field.key);
    const value = field.secret
      ? submitted === undefined
        ? own(previous.secrets, field.key)
        : submitted
      : (own(input.values, field.key) ??
        own(previous.values, field.key) ??
        field.default);
    if (field.required && !value?.trim()) invalid();
    if (value !== undefined && value !== null)
      (field.secret ? secrets : values)[field.key] = value;
  }
  return { values, secrets };
}
const ordered = (value: { [key: string]: unknown }) =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );

export function createMediaDriverConnections(
  repository: MediaDriverRepository,
) {
  const stored = createMediaDriverConnectionRepository(repository);
  return {
    save(
      instanceId: string,
      dataDir: string,
      driverId: string,
      providerId: string,
      input: MediaDriverConnectionSave,
    ) {
      const files = createMediaDriverConnectionFiles(dataDir);
      const origins = [
        ...new Set(
          input.credentialOrigins.map((value) => new URL(value).origin),
        ),
      ].sort();
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            expectedGeneration: input.expectedGeneration,
            expectedRevision: input.expectedRevision,
            values: ordered(input.values),
            secrets: ordered(input.secrets),
            credentialOrigins: origins,
          }),
        )
        .digest("hex");
      return stored.save(
        instanceId,
        driverId,
        providerId,
        input,
        fingerprint,
        async (previous, manifest, approvedOrigins, versionId, signal) => {
          if (origins.some((origin) => !approvedOrigins.includes(origin)))
            invalid();
          const prepared = fields(manifest, input, {
            values: previous ? connectionFromRow(previous).values : {},
            secrets: previous
              ? await files.read(previous.id, previous.credential_digest)
              : {},
          });
          const id = randomUUID();
          const credentialDigest = await files.write(
            { driverId, id },
            prepared.secrets,
            signal,
          );
          return {
            connection: {
              id,
              providerId,
              installationId: input.installationId,
              driverVersionId: versionId,
              revision: input.expectedConnectionRevision + 1,
              values: prepared.values,
              secretKeys: Object.keys(prepared.secrets).sort(),
              credentialOrigins: origins,
              createdAt: new Date().toISOString(),
            },
            credentialDigest,
          };
        },
      );
    },
    read(instanceId: string, driverId: string, providerId: string) {
      return stored.read(instanceId, driverId, providerId, async (row) => ({
        connection: row ? connectionFromRow(row) : null,
      }));
    },
    credentials(
      instanceId: string,
      dataDir: string,
      driverId: string,
      providerId: string,
    ) {
      return stored.read(instanceId, driverId, providerId, async (row) => ({
        secrets: row
          ? await createMediaDriverConnectionFiles(dataDir).read(
              row.id,
              row.credential_digest,
            )
          : {},
      }));
    },
    async recover(instanceId: string, dataDir: string) {
      const files = createMediaDriverConnectionFiles(dataDir);
      for (const record of await files.records())
        await stored.recover(instanceId, record.driverId, record.id, () =>
          files.discard(record),
        );
    },
  };
}
