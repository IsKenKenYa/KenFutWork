import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CanvasContent, canvasContentSchema } from "@kenfutwork/shared";

export type CanvasFileSnapshot = { content: CanvasContent; revision: string };
export type CanvasFileAppend = {
  elements: readonly Record<string, unknown>[];
  files?: Record<string, Record<string, unknown>> | undefined;
};
export type CanvasFileStore = {
  /** 元数据变更与内容写入共用锁；CAS通过后才提交索引变更。 */
  mutateIndex<T>(
    canvasId: string,
    expectedRevision: string,
    mutation: () => Promise<T>,
  ): Promise<T>;
  appendLatest(
    canvasId: string,
    input: CanvasFileAppend,
  ): Promise<CanvasFileSnapshot>;
  read(canvasId: string): Promise<CanvasFileSnapshot | null>;
  save(
    canvasId: string,
    content: CanvasContent,
    expectedRevision: string | null,
  ): Promise<CanvasFileSnapshot>;
  append(
    canvasId: string,
    input: CanvasFileAppend,
    expectedRevision: string | null,
  ): Promise<CanvasFileSnapshot>;
  update(
    canvasId: string,
    content: CanvasContent,
    expectedRevision: string,
    beforePublish: () => Promise<void>,
  ): Promise<CanvasFileSnapshot>;
};
export class CanvasFileStoreError extends Error {
  constructor(
    readonly code: "invalid_path" | "revision_conflict" | "invalid_content",
    message: string,
    readonly statusCode = code === "revision_conflict" ? 409 : 400,
  ) {
    super(message);
  }
}

const locks = new Map<string, Promise<unknown>>();
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const invalidPath = () =>
  new CanvasFileStoreError(
    "invalid_path",
    "画布文件路径不可用，请重新关联项目目录。",
  );
const conflict = () =>
  new CanvasFileStoreError(
    "revision_conflict",
    "画布文件已改变，请重新加载后保存。",
  );

export function canvasContentPath(
  projectRoot: string,
  canvasId: string,
): string {
  if (!isAbsolute(projectRoot) || !/^[A-Za-z0-9_-]{1,128}$/u.test(canvasId))
    throw invalidPath();
  return join(projectRoot, ".kenfutwork", "canvases", `${canvasId}.json`);
}

async function directory(path: string, create: boolean): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidPath();
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    try {
      await mkdir(path);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
        throw mkdirError;
    }
    return directory(path, false);
  }
}

async function checkedRoot(
  projectRoot: string,
  create: boolean,
): Promise<string | null> {
  if (!(await directory(projectRoot, false))) throw invalidPath();
  const root = await realpath(projectRoot);
  const managed = join(root, ".kenfutwork");
  if (!(await directory(managed, create))) return null;
  const canvases = join(managed, "canvases");
  return (await directory(canvases, create)) ? root : null;
}

async function readPath(path: string): Promise<CanvasFileSnapshot | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await file.stat()).isFile()) throw invalidPath();
    const bytes = await file.readFile();
    try {
      return {
        content: canvasContentSchema.parse(JSON.parse(bytes.toString("utf8"))),
        revision: hash(bytes),
      };
    } catch {
      throw new CanvasFileStoreError(
        "invalid_content",
        "画布文件内容无效，请检查项目中的画布文件。",
      );
    }
  } catch (error) {
    if (missing(error)) return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw invalidPath();
    throw error;
  } finally {
    await file?.close();
  }
}

/** 文件内容为权威；调用方在beforePublish检查画布仍存在且当前调用仍获授权。 */
export function createCanvasFileStore(options: {
  projectRoot: string;
  beforePublish?: () => Promise<void>;
}): CanvasFileStore {
  const read = async (canvasId: string) => {
    canvasContentPath(options.projectRoot, canvasId);
    const root = await checkedRoot(options.projectRoot, false);
    return root ? readPath(canvasContentPath(root, canvasId)) : null;
  };
  const publish = async (
    canvasId: string,
    expectedRevision: string | null | "latest",
    change: (previous: CanvasFileSnapshot | null) => CanvasContent,
    beforePublish?: () => Promise<void>,
  ) => {
    canvasContentPath(options.projectRoot, canvasId);
    const root = await realpath(options.projectRoot);
    const path = canvasContentPath(root, canvasId);
    const previousLock = locks.get(path) ?? Promise.resolve();
    const operation = previousLock
      .catch(() => {})
      .then(async () => {
        await options.beforePublish?.();
        if ((await checkedRoot(options.projectRoot, true)) !== root)
          throw invalidPath();
        const previous = await readPath(path);
        const revision =
          expectedRevision === "latest"
            ? (previous?.revision ?? null)
            : expectedRevision;
        if (expectedRevision === "latest" && !previous) throw conflict();
        if ((previous?.revision ?? null) !== revision) throw conflict();
        const content = canvasContentSchema.parse(change(previous));
        const bytes = Buffer.from(JSON.stringify(content));
        const result = { content, revision: hash(bytes) };
        if (previous?.revision === result.revision) return result;
        const temporary = join(
          root,
          ".kenfutwork",
          "canvases",
          `.${canvasId}.${randomUUID()}.tmp`,
        );
        try {
          const file = await open(
            temporary,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          await options.beforePublish?.();
          if ((await checkedRoot(options.projectRoot, false)) !== root)
            throw invalidPath();
          if (((await readPath(path))?.revision ?? null) !== revision)
            throw conflict();
          await beforePublish?.();
          if ((await checkedRoot(options.projectRoot, false)) !== root)
            throw invalidPath();
          if (((await readPath(path))?.revision ?? null) !== revision)
            throw conflict();
          if (revision === null) {
            // link发布不覆盖已存在文件，关掉create的外部并发窗口。
            try {
              await link(temporary, path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw conflict();
              throw error;
            }
          } else await rename(temporary, path);
          return result;
        } finally {
          // link/rename决定发布结果；临时清理失败保留副本，不改写成功回执或原始拒绝。
          await unlink(temporary).catch(() => {});
        }
      });
    locks.set(path, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(path) === operation) locks.delete(path);
    }
  };
  return {
    async mutateIndex(canvasId, expectedRevision, mutation) {
      canvasContentPath(options.projectRoot, canvasId);
      const root = await realpath(options.projectRoot);
      const path = canvasContentPath(root, canvasId);
      const previousLock = locks.get(path) ?? Promise.resolve();
      const operation = previousLock
        .catch(() => {})
        .then(async () => {
          await options.beforePublish?.();
          if ((await checkedRoot(options.projectRoot, false)) !== root)
            throw invalidPath();
          if ((await readPath(path))?.revision !== expectedRevision)
            throw conflict();
          return mutation();
        });
      locks.set(path, operation);
      try {
        return await operation;
      } finally {
        if (locks.get(path) === operation) locks.delete(path);
      }
    },
    read,
    save: (canvasId, content, expectedRevision) =>
      publish(canvasId, expectedRevision, () => content),
    appendLatest: (canvasId, input) =>
      publish(canvasId, "latest", (previous) => {
        if (!previous) throw conflict();
        return mergeAppend(previous.content, input);
      }),
    append: (canvasId, input, expectedRevision) =>
      publish(canvasId, expectedRevision, (previous) =>
        mergeAppend(
          previous?.content ?? { elements: [], appState: {}, files: {} },
          input,
        ),
      ),
    update: (canvasId, content, expectedRevision, beforePublish) =>
      publish(canvasId, expectedRevision, () => content, beforePublish),
  };
}

function mergeAppend(
  content: CanvasContent,
  input: CanvasFileAppend,
): CanvasContent {
  const elements = [...content.elements];
  for (const element of input.elements) {
    const previous =
      typeof element.id === "string"
        ? elements.find((entry) => entry.id === element.id)
        : undefined;
    if (previous) {
      const published = (
        previous.customData as Record<string, unknown> | undefined
      )?.generationFingerprint;
      const incoming = (
        element.customData as Record<string, unknown> | undefined
      )?.generationFingerprint;
      if (
        !(typeof published === "string" && published === incoming) &&
        !isDeepStrictEqual(previous, element)
      )
        throw conflict();
    } else elements.push(element);
  }
  const files = { ...content.files };
  for (const [id, file] of Object.entries(input.files ?? {})) {
    if (files[id] && !isDeepStrictEqual(files[id], file)) throw conflict();
    files[id] = file;
  }
  return { ...content, elements, files };
}
