import { randomUUID } from "node:crypto";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
  SqlTransaction,
} from "../persistence/types.js";
import type { CreatedProjectResult, CreateProjectInput } from "./repository.js";

export type ProjectCreationAdmission = {
  creationId: string;
  parameterFingerprint: string;
  signal: AbortSignal;
};

export type ProjectCreationOperation = ProjectCreationAdmission & {
  instanceId: string;
  prepare(projectId: string): Promise<CreateProjectInput>;
};

export type ProjectCreationResult = {
  canvas: CreatedProjectResult["canvas"];
  project: CreatedProjectResult["project"] & { editor_revision: number };
};

export class ProjectCreationConflictError extends Error {}
export class ProjectCreationUnavailableError extends Error {
  constructor() {
    super("项目已归档或删除，请重新创建项目。");
  }
}

type Receipt = SqlRow & {
  project_id: string | null;
  parameter_fingerprint: string | null;
  result: ProjectCreationResult | null;
};

async function replay(
  sql: InstanceSqlClient,
  input: ProjectCreationOperation,
  signal: AbortSignal,
) {
  const receipt = await sql.queryOne<Receipt>(
    `select project_id,parameter_fingerprint,result
       from public.project_creation_receipts
      where instance_id=:instance and creation_id=$1`,
    [input.creationId],
  );
  signal.throwIfAborted();
  if (!receipt) return null;
  if (!receipt.project_id || !receipt.result || !receipt.parameter_fingerprint)
    throw new ProjectCreationUnavailableError();
  // 归档与删除先锁项目再清回执；重放采用同一顺序，不先锁定回执记录。
  const project = await sql.queryOne<
    SqlRow & { archived_at: string | null; archive_state: string }
  >(
    `select archived_at,archive_state from public.projects
      where instance_id=:instance and id=$1 for share`,
    [receipt.project_id],
  );
  signal.throwIfAborted();
  if (!project || project.archived_at)
    throw new ProjectCreationUnavailableError();
  if (project.archive_state !== "open")
    throw new ProjectCreationConflictError("项目正在关闭，请等待关闭完成。");
  if (receipt.parameter_fingerprint !== input.parameterFingerprint)
    throw new ProjectCreationConflictError(
      "同一次创建已提交其他内容，请重新打开创建表单。",
    );
  return receipt.result;
}

async function availableProjectName(
  tx: SqlTransaction,
  instanceId: string,
  baseName: string,
  signal: AbortSignal,
) {
  // 同一实例共用名称锁，包含原名称与已有后缀相互重叠的创建请求。
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["project.create.names", instanceId]),
  ]);
  signal.throwIfAborted();
  const projects = await tx.forInstance(instanceId).query<{ name: string }>(
    `select name from public.projects
      where instance_id=:instance and archived_at is null`,
  );
  signal.throwIfAborted();
  const names = new Set(projects.map((project) => project.name));
  let name = baseName;
  for (let suffix = 2; names.has(name); suffix += 1)
    name = `${baseName} (${suffix})`;
  return name;
}

/** 原项目插入与创建回执共用事务；首次准备目录必须排在回执核对之后。 */
export function createProjectCreationRepository(
  persistence: PersistenceService,
  insertProject: (
    tx: SqlTransaction,
    input: CreateProjectInput,
    signal: AbortSignal,
  ) => Promise<CreatedProjectResult>,
) {
  return async (
    input: ProjectCreationOperation,
  ): Promise<ProjectCreationResult> =>
    persistence.withSessionTransaction(async (tx, sessionSignal) => {
      const signal = AbortSignal.any([input.signal, sessionSignal]);
      signal.throwIfAborted();
      const sql = tx.forInstance(input.instanceId);
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["project.create", input.instanceId, input.creationId]),
      ]);
      signal.throwIfAborted();
      const previous = await replay(sql, input, signal);
      if (previous) return previous;
      const projectId = randomUUID();
      const prepared = await input.prepare(projectId);
      signal.throwIfAborted();
      const name = await availableProjectName(
        tx,
        input.instanceId,
        prepared.name,
        signal,
      );
      const created = await insertProject(
        tx,
        {
          ...prepared,
          name,
          id: projectId,
          instanceId: input.instanceId,
        },
        signal,
      );
      signal.throwIfAborted();
      const revision = await sql.queryOne<{ editor_revision: number }>(
        `select editor_revision from public.projects
          where instance_id=:instance and id=$1`,
        [created.project.id],
      );
      if (!revision) throw new Error("项目创建后未读取到实际修订。");
      const result: ProjectCreationResult = {
        canvas: created.canvas,
        project: {
          ...created.project,
          editor_revision: revision.editor_revision,
        },
      };
      signal.throwIfAborted();
      await sql.execute(
        `insert into public.project_creation_receipts
            (instance_id,creation_id,project_id,parameter_fingerprint,result)
          values(:instance,$1,$2,$3,$4::jsonb)`,
        [
          input.creationId,
          result.project.id,
          input.parameterFingerprint,
          JSON.stringify(result),
        ],
      );
      signal.throwIfAborted();
      return result;
    });
}
