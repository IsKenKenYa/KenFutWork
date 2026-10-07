import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  resolvePgBinDir,
  startEmbeddedPostgres,
} from "../../desktop/postgres.js";

/** 显式集成回归使用全新临时集群；不解析 .env，也不连接现存数据库。 */
export async function createTemporaryPostgres() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-task-work-pg-")),
  );
  const source = dirname(resolvePgBinDir({ env: {} }));
  const copied = join(directory, "pg-runtime");
  await cp(source, copied, { recursive: true });
  if (process.platform === "darwin") {
    // pnpm 未执行上游 postinstall；按项目 Mac packager 使用的同一发行清单复刻软链。
    const entries: Array<{ source: string; target: string }> = JSON.parse(
      await readFile(join(source, "pg-symlinks.json"), "utf8"),
    );
    for (const entry of entries) {
      const target = join(copied, entry.target.replace(/^native\//, ""));
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      await symlink(basename(entry.source), target);
    }
  }
  const binDir = join(copied, "bin");
  const handle = await startEmbeddedPostgres({
    binDir,
    dataDir: join(directory, "cluster"),
    logFile: join(directory, "postgres.log"),
    passwordFile: join(directory, "password"),
    database: "task_work_test",
  });
  return {
    directory,
    binDir,
    connectionString: handle.connectionString,
    stop: () => handle.stop(),
    async close() {
      await handle.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
