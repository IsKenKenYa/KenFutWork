import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";

const run = promisify(execFile);
const MANAGED_TREES = new Set([
  "sandbox",
  "checkpoints",
  "blobs",
  "plugins",
  "execution-output",
  "index",
  "browser",
]);
const PATH_FIELDS = new Set([
  "path",
  "cwd",
  "directory",
  "rootDirectory",
  "root_directory",
  "workspacePath",
  "workDir",
  "work_dir",
  "checkpointRoot",
  "stagingDirectory",
  "objectPath",
  "outputRef",
]);
const QUALIFIED_FIELDS = new Set([
  "workspaceIdentity",
  "workspaceId",
  "workspaceKey",
]);

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** 允许旧根已被移动；现存祖先和软链仍由真实文件系统解析。 */
async function physicalPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(relative(parent, current));
      current = parent;
    }
  }
}

function managedRelative(root: string, path: string): string | null {
  const value = relative(root, path);
  if (
    !value ||
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith(`..${sep}`)
  )
    return null;
  return MANAGED_TREES.has(value.split(sep)[0] ?? "") ? value : null;
}

export async function createManagedRootRebinder(
  previousDataDir: string,
  dataDir: string,
) {
  if (!isAbsolute(previousDataDir) || !isAbsolute(dataDir))
    throw new Error("实例数据根必须是绝对路径。");
  const previous = await physicalPath(previousDataDir);
  const current = await physicalPath(dataDir);
  const cache = new Map<string, Promise<string>>();
  const rewritePath = (value: string): Promise<string> => {
    let pending = cache.get(value);
    if (!pending) {
      pending = (async () => {
        if (!isAbsolute(value)) return value;
        const physical = await physicalPath(value);
        const suffix = managedRelative(previous, physical);
        if (suffix === null) return value;
        const target = await physicalPath(join(current, suffix));
        if (managedRelative(current, target) !== suffix)
          throw new Error("复制后的应用目录存在越界软链，拒绝重绑定。");
        return target;
      })();
      cache.set(value, pending);
    }
    return pending;
  };
  async function qualified(value: string) {
    if (isAbsolute(value)) return rewritePath(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    )
      return value;
    const next = await rewritePath(parsed[1]);
    return next === parsed[1] ? value : JSON.stringify([parsed[0], next]);
  }
  async function rewriteJson(value: unknown, field = ""): Promise<unknown> {
    if (typeof value === "string") {
      if (PATH_FIELDS.has(field)) return rewritePath(value);
      if (QUALIFIED_FIELDS.has(field)) return qualified(value);
      return value;
    }
    if (Array.isArray(value))
      return Promise.all(value.map((entry) => rewriteJson(entry, field)));
    if (value === null || typeof value !== "object") return value;
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entry]) => {
        const nextKey = await qualified(key);
        return [nextKey, await rewriteJson(entry, key)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
  return { previous, current, rewritePath, rewriteJson };
}

type Rebinder = Awaited<ReturnType<typeof createManagedRootRebinder>>;
type Undo = () => Promise<void>;
async function atomicText(path: string, text: string | Buffer, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 实际shadow provider使用绝对excludesFile，仓库目录名使用rootDirectory的SHA-256。 */
async function rebindShadowRepository(input: {
  mapper: Rebinder;
  instanceId: string;
  projectId: string;
  taskId: string;
  previousRoot: string;
  currentRoot: string;
  binary: string;
  undo: Undo[];
}) {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const base = join(
    input.mapper.current,
    "checkpoints",
    input.instanceId,
    input.projectId,
    `${input.taskId}.git`,
  );
  const source = join(base, hash(input.previousRoot));
  const target = join(base, hash(input.currentRoot));
  for (const path of [source, target])
    if ((await physicalPath(path)) !== path)
      throw new Error("检查点影子仓库路径包含越界或别名软链，拒绝重绑定。");
  if (source !== target) {
    try {
      await stat(source);
    } catch (error) {
      if (missing(error))
        throw new Error("复制的数据目录缺少检查点影子仓库，拒绝重绑定。");
      throw error;
    }
    try {
      await stat(target);
      throw new Error("检查点新旧根映射到两个现存仓库，拒绝覆盖。");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rename(source, target);
    input.undo.push(() => rename(target, source));
  }
  const config = join(target, "config");
  if ((await physicalPath(config)) !== config)
    throw new Error("检查点 Git 配置存在软链，拒绝重绑定。");
  const before = await readFile(config);
  const mode = (await stat(config)).mode & 0o777;
  let changed = false;
  for (const key of ["core.worktree", "core.excludesfile"]) {
    let value: string;
    try {
      value = (
        await run(input.binary, ["config", "--file", config, "--get", key])
      ).stdout.trimEnd();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      )
        continue;
      throw error;
    }
    const previousGitDir = join(
      input.mapper.previous,
      "checkpoints",
      input.instanceId,
      input.projectId,
      `${input.taskId}.git`,
      hash(input.previousRoot),
    );
    const insideGit = isAbsolute(value)
      ? relative(previousGitDir, await physicalPath(value))
      : "..";
    const next =
      insideGit &&
      !isAbsolute(insideGit) &&
      insideGit !== ".." &&
      !insideGit.startsWith(`..${sep}`)
        ? join(target, insideGit)
        : await input.mapper.rewritePath(value);
    if (next === value) continue;
    if (!changed) {
      input.undo.push(() => atomicText(config, before, mode));
      changed = true;
    }
    await run(input.binary, [
      "config",
      "--file",
      config,
      "--replace-all",
      key,
      next,
    ]);
  }
}

async function updateJsonRows(scoped: InstanceSqlClient, mapper: Rebinder) {
  const works = await scoped.query<
    SqlRow & { id: string; scope: unknown; output_ref: string | null }
  >(
    "select id, scope, output_ref from public.task_works where instance_id=:instance for update",
  );
  for (const row of works) {
    const scope = await mapper.rewriteJson(row.scope);
    const output =
      row.output_ref === null ? null : await mapper.rewritePath(row.output_ref);
    if (
      JSON.stringify(scope) !== JSON.stringify(row.scope) ||
      output !== row.output_ref
    )
      await scoped.execute(
        "update public.task_works set scope=$2::jsonb, output_ref=$3 where instance_id=:instance and id=$1",
        [row.id, JSON.stringify(scope), output],
      );
  }
  const settings = await scoped.queryOne<
    SqlRow & { code_ui_preferences: unknown }
  >(
    "select code_ui_preferences from public.instance_settings where instance_id=:instance for update",
  );
  if (settings) {
    const value = await mapper.rewriteJson(settings.code_ui_preferences);
    if (JSON.stringify(value) !== JSON.stringify(settings.code_ui_preferences))
      await scoped.execute(
        "update public.instance_settings set code_ui_preferences=$1::jsonb where instance_id=:instance",
        [JSON.stringify(value)],
      );
  }
  const attachments = await scoped.query<
    SqlRow & { upload_key: string; record: unknown }
  >(
    "select upload_key, record from public.code_attachments where instance_id=:instance for update",
  );
  for (const row of attachments) {
    const value = await mapper.rewriteJson(row.record);
    if (JSON.stringify(value) !== JSON.stringify(row.record))
      await scoped.execute(
        "update public.code_attachments set record=$2::jsonb where instance_id=:instance and upload_key=$1",
        [row.upload_key, JSON.stringify(value)],
      );
  }
}

async function rebindProjects(scoped: InstanceSqlClient, mapper: Rebinder) {
  const projects = await scoped.query<
    SqlRow & {
      id: string;
      work_dir: string | null;
      additional_directories: unknown;
    }
  >(
    "select id, work_dir, additional_directories from public.projects where instance_id=:instance for update",
  );
  for (const row of projects) {
    const path =
      row.work_dir === null ? null : await mapper.rewritePath(row.work_dir);
    const additional = await mapper.rewriteJson(row.additional_directories);
    if (
      path !== row.work_dir ||
      JSON.stringify(additional) !== JSON.stringify(row.additional_directories)
    )
      await scoped.execute(
        "update public.projects set work_dir=$2, additional_directories=$3::jsonb where instance_id=:instance and id=$1",
        [row.id, path, JSON.stringify(additional)],
      );
  }
}

async function rebindTasks(scoped: InstanceSqlClient, mapper: Rebinder) {
  const tasks = await scoped.query<
    SqlRow & {
      id: string;
      root_directory: string | null;
      additional_directories: unknown;
      state: unknown;
    }
  >(
    "select id, root_directory, additional_directories, state from public.code_ui_sessions where instance_id=:instance for update",
  );
  for (const row of tasks) {
    const path =
      row.root_directory === null
        ? null
        : await mapper.rewritePath(row.root_directory);
    const additional = await mapper.rewriteJson(row.additional_directories);
    const state = await mapper.rewriteJson(row.state);
    const scopeChanged =
      path !== row.root_directory ||
      JSON.stringify(additional) !== JSON.stringify(row.additional_directories);
    if (scopeChanged || JSON.stringify(state) !== JSON.stringify(row.state))
      await scoped.execute(
        "update public.code_ui_sessions set root_directory=$2, additional_directories=$3::jsonb, state=$4::jsonb, scope_generation=scope_generation+$5, revision=revision+1 where instance_id=:instance and id=$1",
        [
          row.id,
          path,
          JSON.stringify(additional),
          JSON.stringify(state),
          scopeChanged ? 1 : 0,
        ],
      );
  }
}

async function rebindCanvasAndDesignTasks(
  scoped: InstanceSqlClient,
  mapper: Rebinder,
) {
  const canvases = await scoped.query<
    SqlRow & { id: string; root_directory: string | null }
  >(
    "select c.id,c.root_directory from public.canvases c join public.projects p on p.id=c.project_id where p.instance_id=:instance for update of c",
  );
  const roots = new Map<string, string | null>();
  for (const canvas of canvases) {
    const root =
      canvas.root_directory === null
        ? null
        : await mapper.rewritePath(canvas.root_directory);
    roots.set(canvas.id, root);
    if (root !== canvas.root_directory)
      await scoped.execute(
        "update public.canvases c set root_directory=$2 from public.projects p where c.id=$1 and p.id=c.project_id and p.instance_id=:instance",
        [canvas.id, root],
      );
  }
  const tasks = await scoped.query<
    SqlRow & {
      task_id: string;
      canvas_id: string;
      project_id: string;
      canvas_project_id: string | null;
      root_directory: string;
      additional_directories: unknown;
    }
  >(
    "select d.task_id,s.canvas_id,d.project_id,c.project_id as canvas_project_id,d.root_directory,d.additional_directories from public.design_task_executions d join public.chat_sessions s on s.id=d.task_id and s.instance_id=d.instance_id and s.project_id=d.project_id left join public.canvases c on c.id=s.canvas_id where d.instance_id=:instance and s.mode='design' for update of d",
  );
  for (const task of tasks) {
    if (task.canvas_project_id !== task.project_id)
      throw new Error("画布与Design Task项目归属不一致，拒绝迁移。");
    const root = await mapper.rewritePath(task.root_directory);
    if (roots.get(task.canvas_id) !== root)
      throw new Error("画布与Design Task目录不一致，拒绝迁移。");
    const additional = await mapper.rewriteJson(task.additional_directories);
    if (
      root !== task.root_directory ||
      JSON.stringify(additional) !== JSON.stringify(task.additional_directories)
    )
      await scoped.execute(
        "update public.design_task_executions set root_directory=$2,additional_directories=$3::jsonb,scope_generation=scope_generation+1 where instance_id=:instance and task_id=$1",
        [task.task_id, root, JSON.stringify(additional)],
      );
  }
}

function snapshotRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("检查点缺少目录快照，拒绝重绑定。");
  return value.map((snapshot: unknown) => {
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      !("rootDirectory" in snapshot) ||
      typeof snapshot.rootDirectory !== "string" ||
      !isAbsolute(snapshot.rootDirectory) ||
      !("shadowCommit" in snapshot) ||
      typeof snapshot.shadowCommit !== "string" ||
      !snapshot.shadowCommit
    )
      throw new Error("检查点目录快照格式非法，拒绝重绑定。");
    return snapshot.rootDirectory;
  });
}

async function rebindCheckpoints(options: {
  scoped: InstanceSqlClient;
  mapper: Rebinder;
  binary: string;
  undo: Undo[];
  projectId?: string;
}) {
  const { scoped, mapper, binary, undo } = options;
  const checkpoints = await scoped.query<
    SqlRow & {
      id: string;
      project_id: string;
      task_id: string;
      root_directory: string;
      directory_snapshots: unknown;
    }
  >(
    `select id, project_id, task_id, root_directory, directory_snapshots from public.project_checkpoints where instance_id=:instance ${options.projectId ? "and project_id=$1" : ""} for update`,
    options.projectId ? [options.projectId] : [],
  );
  const reboundRepos = new Set<string>();
  for (const row of checkpoints) {
    const roots = snapshotRoots(row.directory_snapshots);
    const path = await mapper.rewritePath(row.root_directory);
    const snapshots = await mapper.rewriteJson(row.directory_snapshots);
    for (const root of roots) {
      const next = await mapper.rewritePath(root);
      const key = JSON.stringify([row.project_id, row.task_id, root]);
      // 外部工作目录的 hash 不变，私有 Git 的绝对 excludesFile 仍需换根。
      if (!reboundRepos.has(key)) {
        await rebindShadowRepository({
          mapper,
          instanceId: scoped.instanceId,
          projectId: row.project_id,
          taskId: row.task_id,
          previousRoot: root,
          currentRoot: next,
          binary,
          undo,
        });
        reboundRepos.add(key);
      }
    }
    if (
      path !== row.root_directory ||
      JSON.stringify(snapshots) !== JSON.stringify(row.directory_snapshots)
    )
      await scoped.execute(
        "update public.project_checkpoints set root_directory=$2, directory_snapshots=$3::jsonb where instance_id=:instance and id=$1",
        [row.id, path, JSON.stringify(snapshots)],
      );
  }
}
/** Explicit missing-Project recovery only: exact root mapping, no filesystem discovery or user-file move. */
export async function rebindMissingProjectCheckpoints(options: {
  scoped: InstanceSqlClient;
  projectId: string;
  dataDir: string;
  previousRoot: string;
  nextRoot: string;
}) {
  const base = await createManagedRootRebinder(
    options.dataDir,
    options.dataDir,
  );
  const rewritePath = async (value: string) => {
    if (!isAbsolute(value)) return value;
    const suffix = relative(options.previousRoot, value);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`))
      return value;
    const target = await physicalPath(join(options.nextRoot, suffix));
    const inside = relative(options.nextRoot, target);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("重新关联目录存在越界软链，拒绝恢复检查点。");
    return target;
  };
  const rewriteJson = async (value: unknown, field = ""): Promise<unknown> => {
    if (typeof value === "string")
      return PATH_FIELDS.has(field) ? rewritePath(value) : value;
    if (Array.isArray(value))
      return Promise.all(value.map((entry) => rewriteJson(entry, field)));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await rewriteJson(entry, key),
        ]),
      ),
    );
  };
  const undo: Undo[] = [];
  const rollback = async () => {
    for (const restore of [...undo].reverse()) await restore();
  };
  try {
    await rebindCheckpoints({
      scoped: options.scoped,
      projectId: options.projectId,
      mapper: { ...base, rewritePath, rewriteJson },
      binary: "git",
      undo,
    });
  } catch (error) {
    await rollback();
    throw error;
  }
  return rollback;
}

/** 启动内部调用：旧根仅来自实例账本，当前根仅来自可信native配置，不接受HTTP路径。 */
export async function bindLocalInstanceDataRoot(options: {
  persistence: PersistenceService;
  instanceId: string;
  dataDir: string;
  gitBinary?: string;
}): Promise<string> {
  if (!isAbsolute(options.dataDir))
    throw new Error("当前实例数据根必须来自可信绝对路径配置。");
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const current = await realpath(options.dataDir);
  const undo: Undo[] = [];
  try {
    await options.persistence.transaction(async (tx) => {
      const binding = await tx.queryOne<
        SqlRow & { last_data_dir: string | null }
      >(
        "select last_data_dir from public.local_instances where id=$1 for update",
        [options.instanceId],
      );
      if (!binding) throw new Error("实例不存在，拒绝重绑定数据根。");
      if (binding.last_data_dir === current) return;
      const scoped = tx.forInstance(options.instanceId);
      if (binding.last_data_dir !== null) {
        const mapper = await createManagedRootRebinder(
          binding.last_data_dir,
          current,
        );
        await rebindProjects(scoped, mapper);
        await rebindTasks(scoped, mapper);
        await rebindCanvasAndDesignTasks(scoped, mapper);
        await rebindCheckpoints({
          scoped,
          mapper,
          binary: options.gitBinary ?? "git",
          undo,
        });
        await updateJsonRows(scoped, mapper);
      }
      await tx.execute(
        "update public.local_instances set last_data_dir=$2 where id=$1",
        [options.instanceId, current],
      );
    });
  } catch (error) {
    const failures: unknown[] = [];
    for (const restore of undo.reverse())
      try {
        await restore();
      } catch (failure) {
        failures.push(failure);
      }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "数据根重绑定失败，部分影子仓库元数据未能恢复。",
      );
    throw error;
  }
  return current;
}
