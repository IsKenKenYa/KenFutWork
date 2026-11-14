import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { mediaDriverManifestSchema } from "@kenfutwork/shared";
import { z } from "zod";
import { MediaDriverRegistryError } from "./errors.js";
import { privateDirectory, writePrivateFile } from "./private-files.js";

const recordSchema = z
  .object({ driverId: mediaDriverManifestSchema.shape.id, id: z.uuid() })
  .strict();
type Record = z.infer<typeof recordSchema>;
const secretsSchema = z.record(z.string(), z.string());

export function createMediaDriverConnectionFiles(dataDir: string) {
  const directory = (parts: string[], create: boolean) =>
    privateDirectory(dataDir, parts, create);
  const index = (create: boolean) =>
    directory(["media-drivers", "connections"], create);
  const folder = (id: string, create: boolean) =>
    directory(["credentials", "media-drivers", z.uuid().parse(id)], create);
  const fail = (): never => {
    throw new MediaDriverRegistryError(
      "media_driver_storage_error",
      "媒体凭据不可用，请恢复应用数据目录",
      503,
    );
  };
  return {
    async write(
      record: Record,
      secrets: { [key: string]: string },
      signal: AbortSignal,
    ) {
      recordSchema.parse(record);
      signal.throwIfAborted();
      const records = await index(true);
      const staging = await directory(
        ["media-drivers", "connection-staging"],
        true,
      );
      const name = `${record.id}.json`;
      await writePrivateFile(join(staging, name), JSON.stringify(record));
      await rename(join(staging, name), join(records, name));
      signal.throwIfAborted();
      const contents = JSON.stringify(secrets);
      await writePrivateFile(
        join(await folder(record.id, true), "fields.json"),
        contents,
      );
      signal.throwIfAborted();
      return createHash("sha256").update(contents).digest("hex");
    },
    async read(id: string, digest: string): Promise<{ [key: string]: string }> {
      const path = join(await folder(id, false), "fields.json");
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink()) fail();
      const contents = await readFile(path, "utf8");
      if (createHash("sha256").update(contents).digest("hex") !== digest)
        fail();
      try {
        return secretsSchema.parse(JSON.parse(contents));
      } catch {
        return fail();
      }
    },
    async records(): Promise<Record[]> {
      let path: string;
      try {
        path = await index(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const result: Record[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail();
        let contents: string;
        try {
          contents = await readFile(join(path, entry.name), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const record = recordSchema.parse(JSON.parse(contents));
        if (entry.name !== `${record.id}.json`) fail();
        result.push(record);
      }
      return result;
    },
    async discard(record: Record) {
      recordSchema.parse(record);
      try {
        await rm(await folder(record.id, false), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rm(join(await index(false), `${record.id}.json`), {
        force: true,
      });
    },
  };
}
