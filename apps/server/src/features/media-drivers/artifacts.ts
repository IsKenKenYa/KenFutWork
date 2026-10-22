import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type MediaDriverVersion,
  mediaDriverManifestSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import { MediaDriverRegistryError } from "./errors.js";

const journalSchema = z
  .object({
    format: z.literal(1),
    driverId: mediaDriverManifestSchema.shape.id,
    versionId: z.uuid(),
  })
  .strict();
export type MediaDriverArtifact = z.infer<typeof journalSchema>;

function missing(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

function storageError(): never {
  throw new MediaDriverRegistryError(
    "media_driver_storage_error",
    "供应商文件校验失败，请检查应用数据目录",
    503,
  );
}

async function writeNewFile(path: string, contents: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export function createMediaDriverArtifacts(dataDir: string) {
  async function directory(parts: string[], create: boolean) {
    let current = await realpath(dataDir);
    for (const part of ["media-drivers", ...parts]) {
      current = join(current, part);
      if (create) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as { code?: string })?.code !== "EEXIST") throw error;
        }
      }
      const state = await lstat(current);
      if (!state.isDirectory() || state.isSymbolicLink()) storageError();
    }
    return current;
  }

  async function finish(artifact: MediaDriverArtifact) {
    let pending: string;
    try {
      pending = await directory(["pending"], false);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    await rm(join(pending, `${artifact.versionId}.json`), { force: true });
  }

  async function discard(artifact: MediaDriverArtifact) {
    let parent: string;
    try {
      parent = await directory(["versions", artifact.driverId], false);
    } catch (error) {
      if (missing(error)) {
        await finish(artifact);
        return;
      }
      throw error;
    }
    await rm(join(parent, artifact.versionId), {
      recursive: true,
      force: true,
    });
    await finish(artifact);
  }

  async function readChecked(
    driverId: string,
    version: MediaDriverVersion,
    kind: "source" | "compiled",
  ) {
    try {
      const folder = await directory(["versions", driverId, version.id], false);
      const path = join(
        folder,
        kind === "source" ? "source.ts" : "compiled.mjs",
      );
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink()) storageError();
      if (kind === "source" && state.size !== version.sourceBytes)
        storageError();
      const contents = await readFile(path, "utf8");
      const digest = createHash("sha256").update(contents).digest("hex");
      if (
        digest !==
        (kind === "source" ? version.sourceDigest : version.compiledDigest)
      )
        storageError();
      return contents;
    } catch (error) {
      if (
        ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        storageError();
      throw error;
    }
  }

  return {
    finish,
    discard,
    readSource: (driverId: string, version: MediaDriverVersion) =>
      readChecked(driverId, version, "source"),
    readCompiled: (driverId: string, version: MediaDriverVersion) =>
      readChecked(driverId, version, "compiled"),
    async prepare(
      artifact: MediaDriverArtifact,
      contents: { source: string; compiledCode: string },
      signal: AbortSignal,
    ) {
      journalSchema.parse(artifact);
      signal.throwIfAborted();
      const pending = await directory(["pending"], true);
      const staging = await directory(["staging"], true);
      const journal = `${artifact.versionId}.json`;
      await writeNewFile(join(staging, journal), JSON.stringify(artifact));
      await rename(join(staging, journal), join(pending, journal));
      signal.throwIfAborted();
      const folder = await directory(
        ["versions", artifact.driverId, artifact.versionId],
        true,
      );
      signal.throwIfAborted();
      await writeNewFile(join(folder, "source.ts"), contents.source);
      signal.throwIfAborted();
      await writeNewFile(join(folder, "compiled.mjs"), contents.compiledCode);
      signal.throwIfAborted();
    },
    async pending(): Promise<MediaDriverArtifact[]> {
      let folder: string;
      try {
        folder = await directory(["pending"], false);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const entries = await readdir(folder, { withFileTypes: true });
      const result: MediaDriverArtifact[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) storageError();
        let contents: string;
        try {
          contents = await readFile(join(folder, entry.name), "utf8");
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const artifact = journalSchema.parse(JSON.parse(contents));
        if (entry.name !== `${artifact.versionId}.json`) storageError();
        result.push(artifact);
      }
      return result;
    },
  };
}
