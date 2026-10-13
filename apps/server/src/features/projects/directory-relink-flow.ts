import { randomUUID } from "node:crypto";
import type {
  FlowProjectControlReceipt,
  ProjectDirectoryRelinkRequest,
  ProjectDirectoryRelinkResponse,
  ProjectDirectoryRelinkSnapshot,
} from "@kenfutwork/shared";
import type { FlowProjectControl } from "../flow/project-control.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";

type FlowRelinkDeps = {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
  flowProjectControl?: FlowProjectControl;
  missingRoot(root: string): Promise<void>;
  rootMissing(root: string): Promise<boolean>;
  targetRoot(root: string): Promise<string>;
  taskRows(
    sql: InstanceSqlClient,
    projectId: string,
  ): Promise<readonly unknown[]>;
  error(message: string, statusCode?: number): Error;
};

type FlowRelinkPhase =
  | "staged"
  | "quiesce_unknown"
  | "quiesced"
  | "root_published"
  | "complete_unknown"
  | "complete";
type FlowRelinkOperation = SqlRow & {
  project_id: string;
  operation_id: string;
  previous_root: string;
  next_root: string;
  expected_flow_generation: string | number;
  phase: FlowRelinkPhase;
  gateway_receipt: FlowProjectControlReceipt | null;
};
type FlowProject = SqlRow & {
  kind: "code" | "design" | "flow";
  work_dir: string | null;
  additional_directories: unknown;
};
const flowPending = (error: FlowRelinkDeps["error"]) =>
  error("Flow维护尚未确认，实例目录接入保持关闭；请观察同一操作后继续。");
async function flowProject(
  sql: InstanceSqlClient,
  projectId: string,
  lock = false,
) {
  return sql.queryOne<FlowProject>(
    `select kind,work_dir,additional_directories from public.projects where instance_id=:instance and id=$1 and archived_at is null ${lock ? "for update" : ""}`,
    [projectId],
  );
}
async function flowOperation(
  sql: InstanceSqlClient,
  projectId: string,
  operationId?: string,
) {
  return sql.queryOne<FlowRelinkOperation>(
    `select project_id,operation_id,previous_root,next_root,expected_flow_generation,phase,gateway_receipt from public.project_directory_relink_operations where instance_id=:instance and project_id=$1 ${operationId ? "and operation_id=$2" : "and phase<>'complete'"}`,
    operationId ? [projectId, operationId] : [projectId],
  );
}
function assertFlowRoot(
  project: FlowProject | null,
  error: FlowRelinkDeps["error"],
) {
  if (
    !project ||
    project.kind !== "flow" ||
    !project.work_dir ||
    !Array.isArray(project.additional_directories) ||
    project.additional_directories.length
  )
    throw error("Flow项目必须绑定单一主目录。");
  return project.work_dir;
}
function matchesQuiesce(
  operation: FlowRelinkOperation,
  receipt: FlowProjectControlReceipt | null,
) {
  return Boolean(
    receipt &&
      receipt.projectId === operation.project_id &&
      receipt.operationId === operation.operation_id &&
      receipt.generation === Number(operation.expected_flow_generation) + 1 &&
      receipt.draining &&
      receipt.localSettled &&
      receipt.quiesceSettled &&
      receipt.activeRunIds.length === 0,
  );
}
function matchesComplete(
  operation: FlowRelinkOperation,
  receipt: FlowProjectControlReceipt | null,
) {
  return Boolean(
    receipt &&
      receipt.projectId === operation.project_id &&
      receipt.operationId === operation.operation_id &&
      receipt.generation === Number(operation.expected_flow_generation) + 1 &&
      !receipt.draining &&
      receipt.remoteOutstanding === 0 &&
      receipt.localSettled &&
      receipt.quiesceSettled &&
      receipt.activeRunIds.length === 0,
  );
}
function flowState(
  operation: FlowRelinkOperation | null,
  previousRoot: string,
  receipt: FlowProjectControlReceipt | null,
  directoryAvailable = false,
) {
  return {
    generation:
      receipt?.generation ??
      operation?.gateway_receipt?.generation ??
      Number(operation?.expected_flow_generation ?? 0),
    operationId: operation?.operation_id ?? randomUUID(),
    phase:
      operation?.phase ??
      (directoryAvailable ? ("available" as const) : ("idle" as const)),
    previousWorkDir: operation?.previous_root ?? previousRoot,
    nextWorkDir: operation?.next_root ?? null,
    receipt,
  };
}
async function recordFlowPhase(
  sql: InstanceSqlClient,
  projectId: string,
  operation: FlowRelinkOperation,
  phase: FlowRelinkPhase,
  receipt: FlowProjectControlReceipt | null,
) {
  await sql.execute(
    "update public.project_directory_relink_operations set phase=$3,gateway_receipt=$4::jsonb where instance_id=:instance and project_id=$1 and operation_id=$2",
    [
      projectId,
      operation.operation_id,
      phase,
      receipt ? JSON.stringify(receipt) : null,
    ],
  );
  operation.phase = phase;
  operation.gateway_receipt = receipt;
}
async function publishFlowRoot(
  deps: FlowRelinkDeps,
  sql: InstanceSqlClient,
  projectId: string,
  operation: FlowRelinkOperation,
) {
  const project = await flowProject(sql, projectId, true);
  if (
    assertFlowRoot(project, deps.error) !== operation.previous_root ||
    !matchesQuiesce(operation, operation.gateway_receipt)
  )
    throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
  await deps.missingRoot(operation.previous_root);
  if ((await deps.targetRoot(operation.next_root)) !== operation.next_root)
    throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
  if ((await deps.taskRows(sql, projectId)).length)
    throw deps.error("Flow项目存在其它模式Task，不能重新关联。");
  const canvases = await sql.query<{
    id: string;
    root_directory: string | null;
  }>(
    "select c.id,c.root_directory from public.canvases c join public.projects p on p.id=c.project_id where p.instance_id=:instance and p.id=$1 for update of c",
    [projectId],
  );
  if (
    canvases.some(
      (row) =>
        row.root_directory && row.root_directory !== operation.previous_root,
    )
  )
    throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
  const changed = await sql.query<{ id: string }>(
    "update public.projects set work_dir=$2 where instance_id=:instance and id=$1 and kind='flow' and work_dir=$3 and archived_at is null returning id",
    [projectId, operation.next_root, operation.previous_root],
  );
  if (changed.length !== 1)
    throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
  await sql.execute(
    "update public.canvases c set root_directory=$2 from public.projects p where c.project_id=p.id and p.instance_id=:instance and p.id=$1",
    [projectId, operation.next_root],
  );
  await recordFlowPhase(
    sql,
    projectId,
    operation,
    "root_published",
    operation.gateway_receipt,
  );
}
export function createFlowDirectoryRelink(deps: FlowRelinkDeps) {
  let maintenanceOwned = false;
  let initialization: Promise<void> | undefined;
  const control = () => {
    if (!deps.flowProjectControl)
      throw deps.error("Flow控制未接通，不能重新关联目录。", 503);
    return deps.flowProjectControl;
  };
  const maintenance = async () => {
    if (deps.localInstance.isDraining() && !maintenanceOwned)
      throw deps.error("实例正在其它维护，请稍后重试。");
    if (maintenanceOwned && deps.localInstance.isDraining()) return;
    maintenanceOwned = true;
    try {
      await deps.localInstance.beginMaintenance(async () => {
        if (deps.localInstance.activeAdmissionCount())
          throw deps.error("文件调用仍在途，目录尚未排空；请稍后重试。");
      });
    } catch (error) {
      maintenanceOwned = false;
      throw error;
    }
  };
  const initialize = () => {
    initialization ??= (async () => {
      const context = await deps.localInstance.getContext();
      const pending = await deps.persistence
        .forInstance(context.instanceId)
        .queryOne<{ count: string | number }>(
          "select count(*) as count from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete'",
        );
      if (Number(pending?.count ?? 0)) {
        control();
        await maintenance();
      }
    })();
    return initialization;
  };
  const observe = async (actor: LocalActor, projectId: string) => {
    try {
      return await control().snapshot(actor, projectId);
    } catch {
      return null;
    }
  };
  const projectKind = async (actor: LocalActor, projectId: string) => {
    await deps.localInstance.resolve(actor);
    if (!actor.accessClientId)
      throw deps.error("重新关联需要已授权的接入客户端。", 403);
    const project = await flowProject(
      deps.persistence.forInstance(actor.instanceId),
      projectId,
    );
    if (!project) throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    return project.kind;
  };
  const snapshot = async (
    actor: LocalActor,
    projectId: string,
  ): Promise<ProjectDirectoryRelinkSnapshot> => {
    await initialize();
    const sql = deps.persistence.forInstance(actor.instanceId);
    const project = await flowProject(sql, projectId);
    const root = assertFlowRoot(project, deps.error),
      operation = await flowOperation(sql, projectId);
    const directoryAvailable = !operation && !(await deps.rootMissing(root));
    if (directoryAvailable && (await deps.targetRoot(root)) !== root)
      throw deps.error("Flow 项目目录关联已改变，请修复原路径。");
    if (
      operation &&
      root !==
        (["root_published", "complete_unknown"].includes(operation.phase)
          ? operation.next_root
          : operation.previous_root)
    )
      throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    const receipt = await observe(actor, projectId);
    if (!receipt && !operation)
      throw deps.error("Flow状态不可读取，请恢复网关连接。", 503);
    if (receipt && receipt.projectId !== projectId)
      throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    return {
      projectId,
      workDir: root,
      tasks: [],
      flow: flowState(operation, root, receipt, directoryAvailable),
    };
  };
  const stage = async (
    actor: LocalActor,
    projectId: string,
    input: ProjectDirectoryRelinkRequest,
  ) => {
    const expectedFlow = input.expectedFlow;
    if (!expectedFlow || input.expectedTasks.length)
      throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    const sql = deps.persistence.forInstance(actor.instanceId);
    const pending = await sql.query<{
      project_id: string;
      operation_id: string;
    }>(
      "select project_id,operation_id from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete'",
    );
    if (
      pending.some(
        (row) =>
          row.project_id !== projectId ||
          row.operation_id !== expectedFlow.operationId,
      )
    )
      throw flowPending(deps.error);
    const existing = await flowOperation(
      sql,
      projectId,
      expectedFlow.operationId,
    );
    if (existing) {
      if (
        existing.previous_root !== input.expectedWorkDir ||
        existing.next_root !== input.nextWorkDir ||
        ![
          Number(existing.expected_flow_generation),
          Number(existing.expected_flow_generation) + 1,
        ].includes(expectedFlow.generation)
      )
        throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
      return existing;
    }
    if (await flowOperation(sql, projectId))
      throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    const receipt = await control().snapshot(actor, projectId);
    if (
      receipt.projectId !== projectId ||
      receipt.generation !== expectedFlow.generation ||
      receipt.draining
    )
      throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    const nextRoot = await deps.targetRoot(input.nextWorkDir);
    if (nextRoot !== input.nextWorkDir)
      throw deps.error("新目录需使用当前真实路径，请重新加载后确认。");
    return deps.persistence.transaction(async (tx) => {
      const bound = tx.forInstance(actor.instanceId);
      await bound.queryOne(
        "select id from public.local_instances where id=:instance for update",
      );
      const pending = await bound.query<{
        project_id: string;
        operation_id: string;
      }>(
        "select project_id,operation_id from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete' for update",
      );
      if (
        pending.some(
          (row) =>
            row.project_id !== projectId ||
            row.operation_id !== expectedFlow.operationId,
        )
      )
        throw flowPending(deps.error);
      const project = await flowProject(bound, projectId, true);
      if (assertFlowRoot(project, deps.error) !== input.expectedWorkDir)
        throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
      await deps.missingRoot(input.expectedWorkDir);
      if ((await deps.taskRows(bound, projectId)).length)
        throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
      await bound.execute(
        "insert into public.project_directory_relink_operations(instance_id,project_id,operation_id,previous_root,next_root,expected_flow_generation,phase,gateway_receipt) values(:instance,$1,$2,$3,$4,$5,'staged',$6::jsonb)",
        [
          projectId,
          expectedFlow.operationId,
          input.expectedWorkDir,
          nextRoot,
          expectedFlow.generation,
          JSON.stringify(receipt),
        ],
      );
      return {
        project_id: projectId,
        operation_id: expectedFlow.operationId,
        previous_root: input.expectedWorkDir,
        next_root: nextRoot,
        expected_flow_generation: expectedFlow.generation,
        phase: "staged" as const,
        gateway_receipt: receipt,
      };
    });
  };
  const quiesce = async (
    actor: LocalActor,
    projectId: string,
    operation: FlowRelinkOperation,
  ) => {
    const sql = deps.persistence.forInstance(actor.instanceId);
    if (operation.phase === "staged") {
      await recordFlowPhase(
        sql,
        projectId,
        operation,
        "quiesce_unknown",
        operation.gateway_receipt,
      );
      const result = await control().quiesce(actor, projectId, {
        operationId: operation.operation_id,
        expectedGeneration: Number(operation.expected_flow_generation),
      });
      const receipt =
        result.status === "confirmed" ? result.receipt : result.observation;
      await recordFlowPhase(
        sql,
        projectId,
        operation,
        matchesQuiesce(operation, receipt) ? "quiesced" : "quiesce_unknown",
        receipt,
      );
    } else if (operation.phase === "quiesce_unknown") {
      const receipt = await observe(actor, projectId);
      await recordFlowPhase(
        sql,
        projectId,
        operation,
        matchesQuiesce(operation, receipt) ? "quiesced" : "quiesce_unknown",
        receipt,
      );
    }
    if (operation.phase === "quiesce_unknown") throw flowPending(deps.error);
  };
  const complete = async (
    actor: LocalActor,
    projectId: string,
    operation: FlowRelinkOperation,
  ) => {
    const sql = deps.persistence.forInstance(actor.instanceId);
    if ((await deps.targetRoot(operation.next_root)) !== operation.next_root)
      throw deps.error("已绑定的新目录发生变化，请恢复该目录后继续同一操作。");
    let receipt: FlowProjectControlReceipt | null;
    if (operation.phase === "root_published") {
      const project = await flowProject(sql, projectId);
      const currentReceipt = await observe(actor, projectId);
      if (
        assertFlowRoot(project, deps.error) !== operation.next_root ||
        !matchesQuiesce(operation, currentReceipt)
      )
        throw flowPending(deps.error);
      await recordFlowPhase(
        sql,
        projectId,
        operation,
        "complete_unknown",
        operation.gateway_receipt,
      );
      const result = await control().completeRelink(actor, projectId, {
        operationId: operation.operation_id,
        expectedGeneration: Number(operation.expected_flow_generation) + 1,
      });
      receipt =
        result.status === "confirmed" ? result.receipt : result.observation;
    } else if (operation.phase === "complete_unknown")
      receipt = await observe(actor, projectId);
    else return operation;
    await recordFlowPhase(
      sql,
      projectId,
      operation,
      matchesComplete(operation, receipt) ? "complete" : "complete_unknown",
      receipt,
    );
    const authoritative = await flowOperation(
      sql,
      projectId,
      operation.operation_id,
    );
    if (!authoritative || authoritative.phase !== "complete")
      throw flowPending(deps.error);
    return authoritative;
  };
  const relink = async (
    actor: LocalActor,
    projectId: string,
    input: ProjectDirectoryRelinkRequest,
  ): Promise<ProjectDirectoryRelinkResponse> => {
    await initialize();
    const lock = await deps.persistence.acquireSessionLock(
      `project-directory-relink-flow:${actor.instanceId}`,
    );
    if (!lock) throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
    try {
      await maintenance();
      const operation = await stage(actor, projectId, input);
      if (lock.signal.aborted)
        throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
      await quiesce(actor, projectId, operation);
      if (operation.phase === "quiesced") {
        const currentReceipt = await observe(actor, projectId);
        if (!matchesQuiesce(operation, currentReceipt)) {
          await recordFlowPhase(
            deps.persistence.forInstance(actor.instanceId),
            projectId,
            operation,
            "quiesce_unknown",
            currentReceipt,
          );
          throw flowPending(deps.error);
        }
        operation.gateway_receipt = currentReceipt;
        if (lock.signal.aborted || deps.localInstance.activeAdmissionCount())
          throw deps.error("项目或Flow操作已改变，请重新加载后关联。");
        await deps.persistence.transaction((tx) =>
          publishFlowRoot(
            deps,
            tx.forInstance(actor.instanceId),
            projectId,
            operation,
          ),
        );
      }
      const authoritative = await complete(actor, projectId, operation);
      const project = await flowProject(
        deps.persistence.forInstance(actor.instanceId),
        projectId,
      );
      if (
        authoritative.phase !== "complete" ||
        assertFlowRoot(project, deps.error) !== authoritative.next_root ||
        !matchesComplete(authoritative, authoritative.gateway_receipt)
      )
        throw flowPending(deps.error);
      return {
        projectId,
        workDir: authoritative.next_root,
        tasks: [],
        affectedTaskIds: [],
        flow: flowState(
          authoritative,
          authoritative.previous_root,
          authoritative.gateway_receipt,
        ),
      };
    } finally {
      await lock.release();
      const pending = await deps.persistence
        .forInstance(actor.instanceId)
        .queryOne<{ count: string | number }>(
          "select count(*) as count from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete'",
        );
      if (maintenanceOwned && !Number(pending?.count ?? 0)) {
        deps.localInstance.cancelMaintenance();
        maintenanceOwned = false;
      }
    }
  };
  return { initialize, projectKind, snapshot, relink };
}
