import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface LocalCredentialStore {
  get(providerId: string): Promise<string | null>;
  set(providerId: string, key: string | null): Promise<void>;
  /** commit 只执行数据库提交，不得重新进入同一凭据存取门。 */
  change<T>(
    providerId: string,
    key: string | null,
    commit: (changed: boolean) => Promise<T>,
  ): Promise<T>;
}

interface CredentialSnapshot {
  contents: string | null;
  keys: Record<string, string>;
}

// 同一进程内的存取对象共享文件门，避免提交回滚覆盖排队中的成功写入。
const fileQueues = new Map<string, Promise<void>>();

function serialized<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(filePath, settled);
  void settled.then(() => {
    if (fileQueues.get(filePath) === settled) fileQueues.delete(filePath);
  });
  return result;
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseKeys(contents: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    // JSON.parse 的原始错误可能带明文片段，不把它交给日志或上层。
    throw new Error("[local-credential-store] 本地凭据文件不是有效 JSON。");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[local-credential-store] 本地凭据文件必须是键值对象。");
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [providerId, key] of Object.entries(value)) {
    if (typeof key !== "string") {
      throw new Error("[local-credential-store] 本地凭据值必须是字符串。");
    }
    keys[providerId] = key;
  }
  return keys;
}

async function restrictPermissions(path: string, mode: number): Promise<void> {
  // Windows 的文件访问控制不由 POSIX chmod 表达，不能因此拒绝本地启动。
  if (process.platform !== "win32") await chmod(path, mode);
}

async function readSnapshot(filePath: string): Promise<CredentialSnapshot> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { contents: null, keys: Object.create(null) };
    }
    throw error;
  }
  await restrictPermissions(dirname(filePath), 0o700);
  await restrictPermissions(filePath, 0o600);
  return { contents, keys: parseKeys(contents) };
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPermissions(directory, 0o700);
  const temporaryPath = join(directory, `.byok.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    created = false;
  } finally {
    if (created) await rm(temporaryPath, { force: true });
  }
}

function ownKey(
  keys: Record<string, string>,
  providerId: string,
): string | null {
  return Object.hasOwn(keys, providerId) ? (keys[providerId] ?? null) : null;
}

/** DEC-7：实例数据目录中的明文 BYOK 凭据，只保存 Key，不保存供应商元数据。 */
export function createLocalCredentialStore(
  dataDir: string,
): LocalCredentialStore {
  const filePath = resolve(dataDir, "credentials", "byok.json");

  const change = <T>(
    providerId: string,
    key: string | null,
    commit: (changed: boolean) => Promise<T>,
  ): Promise<T> =>
    serialized(filePath, async () => {
      if (key !== null && typeof key !== "string") {
        throw new Error(
          "[local-credential-store] 本地凭据必须是字符串或 null。",
        );
      }
      const previous = await readSnapshot(filePath);
      const changed = ownKey(previous.keys, providerId) !== key;
      if (changed) {
        if (key === null) delete previous.keys[providerId];
        else previous.keys[providerId] = key;
        await writeAtomic(
          filePath,
          `${JSON.stringify(previous.keys, null, 2)}\n`,
        );
      }
      try {
        return await commit(changed);
      } catch (commitError) {
        if (changed) {
          try {
            if (previous.contents === null) await rm(filePath, { force: true });
            else await writeAtomic(filePath, previous.contents);
          } catch (rollbackError) {
            throw new AggregateError(
              [commitError, rollbackError],
              "[local-credential-store] 数据库提交失败，恢复本地凭据文件也失败。",
            );
          }
        }
        throw commitError;
      }
    });

  return {
    get: (providerId) =>
      serialized(filePath, async () =>
        ownKey((await readSnapshot(filePath)).keys, providerId),
      ),
    set: (providerId, key) => change(providerId, key, async () => undefined),
    change,
  };
}
