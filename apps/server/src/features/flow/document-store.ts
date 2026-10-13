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

export const FLOW_LAYOUT_MAX_BYTES = 4 * 1024 * 1024;

export class FlowDocumentStoreError extends Error {
  constructor(
    readonly code: "invalid_content" | "invalid_path" | "revision_conflict",
    message: string,
    readonly statusCode = code === "revision_conflict" ? 409 : 400,
  ) {
    super(message);
  }
}

export type FlowLayoutSnapshot = {
  content: Record<string, unknown>;
  version: string;
};

export interface FlowDocumentStore {
  read(workflowId: string): Promise<FlowLayoutSnapshot | null>;
  save(
    workflowId: string,
    content: Record<string, unknown>,
    expectedVersion: string | null,
    beforePublish: () => Promise<void>,
  ): Promise<FlowLayoutSnapshot>;
}

const isUuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
    value,
  );
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const invalidPath = () =>
  new FlowDocumentStoreError("invalid_path", "工作流文件目录不可用。");
const revisionConflict = () =>
  new FlowDocumentStoreError(
    "revision_conflict",
    "工作流文件已改变，请重新加载后保存。",
  );
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, operation: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function ensureDirectory(path: string, create: boolean) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidPath();
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
        throw mkdirError;
    }
    return ensureDirectory(path, false);
  }
}

async function checkedDirectories(projectRoot: string, create: boolean) {
  const rootStat = await lstat(projectRoot).catch((error: unknown) => {
    if (missing(error)) throw invalidPath();
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw invalidPath();
  const root = await realpath(projectRoot);
  if (root !== projectRoot) throw invalidPath();
  const managed = join(root, ".kenfutwork");
  if (!(await ensureDirectory(managed, create))) return null;
  const workflows = join(managed, "workflows");
  if (!(await ensureDirectory(workflows, create))) return null;
  if ((await realpath(projectRoot)) !== root) throw invalidPath();
  return { root, workflows };
}

function filePath(workflows: string, workflowId: string) {
  if (!isUuid(workflowId)) throw invalidPath();
  return join(workflows, `${workflowId}.json`);
}

async function readPath(path: string): Promise<FlowLayoutSnapshot | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw invalidPath();
    if (stat.size > FLOW_LAYOUT_MAX_BYTES)
      throw new FlowDocumentStoreError(
        "invalid_content",
        "工作流文件不能超过4MiB。",
        413,
      );
    const bytes = await file.readFile();
    if (bytes.byteLength > FLOW_LAYOUT_MAX_BYTES)
      throw new FlowDocumentStoreError(
        "invalid_content",
        "工作流文件不能超过4MiB。",
        413,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new FlowDocumentStoreError(
        "invalid_content",
        "工作流文件不是有效的JSON。",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new FlowDocumentStoreError(
        "invalid_content",
        "工作流内容必须是JSON对象。",
      );
    return {
      content: parsed as Record<string, unknown>,
      version: digest(bytes),
    };
  } catch (error) {
    if (missing(error)) return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw invalidPath();
    throw error;
  } finally {
    await file?.close();
  }
}

export function createFlowDocumentStore(
  projectRoot: string,
): FlowDocumentStore {
  if (!isAbsolute(projectRoot)) throw invalidPath();
  return {
    async read(workflowId) {
      const directories = await checkedDirectories(projectRoot, false);
      if (!directories) return null;
      const result = await readPath(
        filePath(directories.workflows, workflowId),
      );
      if ((await realpath(projectRoot)) !== directories.root)
        throw invalidPath();
      return result;
    },
    save(workflowId, content, expectedVersion, beforePublish) {
      return withLock(join(projectRoot, workflowId), async () => {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(content);
        } catch {
          throw new FlowDocumentStoreError(
            "invalid_content",
            "工作流内容不能序列化为JSON。",
            400,
          );
        }
        if (serialized === undefined)
          throw new FlowDocumentStoreError(
            "invalid_content",
            "工作流内容不能序列化为JSON。",
            400,
          );
        const payload = Buffer.from(serialized);
        if (payload.byteLength > FLOW_LAYOUT_MAX_BYTES)
          throw new FlowDocumentStoreError(
            "invalid_content",
            "工作流文件不能超过4MiB。",
            413,
          );
        const version = digest(payload);
        if (
          expectedVersion !== null &&
          !/^[a-f0-9]{64}$/u.test(expectedVersion)
        )
          throw revisionConflict();

        const initialDirectories = await checkedDirectories(projectRoot, true);
        if (!initialDirectories) throw invalidPath();
        const path = filePath(initialDirectories.workflows, workflowId);
        const current = await readPath(path);
        if ((current?.version ?? null) !== expectedVersion)
          throw revisionConflict();
        if (current?.version === version) return current;

        const temporary = join(
          initialDirectories.workflows,
          `.${workflowId}.${randomUUID()}.tmp`,
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
            await file.writeFile(payload);
            await file.sync();
          } finally {
            await file.close();
          }
          await beforePublish();
          const latestDirectories = await checkedDirectories(
            projectRoot,
            false,
          );
          if (
            !latestDirectories ||
            latestDirectories.root !== initialDirectories.root ||
            latestDirectories.workflows !== initialDirectories.workflows
          )
            throw invalidPath();
          const latest = await readPath(path);
          if ((latest?.version ?? null) !== expectedVersion)
            throw revisionConflict();
          await beforePublish();
          if (expectedVersion === null) {
            try {
              await link(temporary, path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw revisionConflict();
              throw error;
            }
          } else {
            await rename(temporary, path);
          }
          return { content, version };
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if (!missing(error)) throw error;
          });
        }
      });
    },
  };
}
