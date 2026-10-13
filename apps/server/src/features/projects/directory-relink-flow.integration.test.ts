import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  FlowProjectControlReceipt,
  ProjectDirectoryRelinkRequest,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import type { FlowProjectControl } from "../flow/project-control.js";
import { createGoalService } from "../goals/service.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createProjectDirectoryRelinkService } from "./directory-relink.js";
import { createProjectRepository } from "./repository.js";

async function flowFixture() {
  const db = await createTaskWorkDatabase();
  const projects = createProjectRepository(db.persistence);
  const receipts = new Map<string, FlowProjectControlReceipt>();
  const targets = new Map<string, string>();
  const quiesced: string[] = [],
    completed: string[] = [];
  let quiesceUnknown = false,
    completeUnknown = false,
    inconsistentCompleteObservation = false,
    remoteOutstanding = 0;
  let held: { promise: Promise<void>; entered: () => void } | undefined;
  const createProject = async (name: string) => {
    const oldRoot = join(db.directory, `${name}-old`),
      nextRoot = join(db.directory, `${name}-next`);
    await mkdir(oldRoot);
    await mkdir(nextRoot);
    const { project } = await projects.createProject({
      instanceId: db.instanceId,
      createdByClientId: db.actor.accessClientId,
      kind: "flow",
      name,
      slug: randomUUID(),
      description: null,
      canvasName: "Flow",
      workDir: oldRoot,
      additionalDirectories: [],
    });
    targets.set(project.id, nextRoot);
    receipts.set(project.id, {
      projectId: project.id,
      generation: 1,
      draining: false,
      localSettled: false,
      activeRunIds: [`local-${project.id}`],
      remoteStopped: 0,
      remoteOutstanding,
      operationId: null,
      quiesceSettled: false,
    });
    await rename(oldRoot, `${oldRoot}-missing`);
    return { projectId: project.id, oldRoot, nextRoot };
  };
  const readReceipt = (projectId: string) => {
    const receipt = receipts.get(projectId);
    if (!receipt) throw new Error("Flow fixture project missing");
    return receipt;
  };
  const control: FlowProjectControl = {
    async snapshot(_actor, projectId) {
      return structuredClone(readReceipt(projectId));
    },
    async quiesce(_actor, projectId, input) {
      expect(db.localInstance.isDraining()).toBe(true);
      expect(db.localInstance.activeAdmissionCount()).toBe(0);
      const receipt = readReceipt(projectId);
      expect(input.expectedGeneration).toBe(receipt.generation);
      expect(receipt.draining).toBe(false);
      quiesced.push(projectId);
      Object.assign(receipt, {
        generation: receipt.generation + 1,
        operationId: input.operationId,
        draining: true,
        localSettled: !quiesceUnknown,
        quiesceSettled: !quiesceUnknown,
        activeRunIds: quiesceUnknown ? receipt.activeRunIds : [],
        remoteStopped: remoteOutstanding > 0 ? 1 : 0,
        remoteOutstanding,
      });
      held?.entered();
      await held?.promise;
      return quiesceUnknown
        ? { status: "unknown", observation: structuredClone(receipt) }
        : { status: "confirmed", receipt: structuredClone(receipt) };
    },
    async completeRelink(_actor, projectId, input) {
      expect(db.localInstance.isDraining()).toBe(true);
      const receipt = readReceipt(projectId);
      expect(input).toEqual({
        operationId: receipt.operationId,
        expectedGeneration: receipt.generation,
      });
      const row = await projects.findActiveById(db.instanceId, projectId);
      expect(row?.work_dir).toBe(targets.get(projectId));
      if (inconsistentCompleteObservation) {
        // Deliberately adversarial snapshot: the schema is valid, but outstanding work means it cannot prove completion.
        return {
          status: "unknown",
          observation: { ...structuredClone(receipt), draining: false },
        };
      }
      if (completeUnknown) {
        // The gateway completed the mutation, but its response was lost; a later snapshot can confirm it.
        receipt.draining = false;
        completed.push(projectId);
        return { status: "unknown", observation: null };
      }
      if (remoteOutstanding > 0)
        return { status: "unknown", observation: structuredClone(receipt) };
      receipt.draining = false;
      completed.push(projectId);
      return { status: "confirmed", receipt: structuredClone(receipt) };
    },
  };
  const makeService = (instance = db.localInstance) =>
    createProjectDirectoryRelinkService({
      persistence: db.persistence,
      localInstance: instance,
      goals: createGoalService(),
      flowProjectControl: control,
      closeResources: async () => {
        throw new Error("Flow不能借Code/Design取消回执证明停稳");
      },
    });
  const service = makeService();
  const primary = await createProject("Flow relink");
  const input = async (
    project = primary,
  ): Promise<ProjectDirectoryRelinkRequest> => {
    const snapshot = await service.snapshot(db.actor, project.projectId);
    if (!snapshot.flow) throw new Error("Flow fence missing");
    return {
      expectedWorkDir: snapshot.flow.previousWorkDir,
      nextWorkDir: project.nextRoot,
      expectedTasks: [],
      expectedFlow: {
        generation: snapshot.flow.generation,
        operationId: snapshot.flow.operationId,
      },
    };
  };
  return {
    db,
    primary,
    service,
    input,
    createProject,
    makeService,
    readReceipt,
    quiesced,
    completed,
    unknownQuiesce: () => {
      quiesceUnknown = true;
    },
    unknownComplete: () => {
      completeUnknown = true;
    },
    setRemoteOutstanding(value: number) {
      remoteOutstanding = value;
      for (const receipt of receipts.values())
        receipt.remoteOutstanding = value;
    },
    useInconsistentCompleteObservation() {
      inconsistentCompleteObservation = true;
    },
    settle: (projectId = primary.projectId) => {
      Object.assign(readReceipt(projectId), {
        localSettled: true,
        quiesceSettled: true,
        activeRunIds: [],
      });
    },
    holdQuiesce: () => {
      let release: () => void = () => {},
        entered: () => void = () => {};
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { promise, entered };
      return { entered: enteredPromise, release };
    },
    coldInstance: () =>
      createLocalInstanceService({
        repository: { ensure: async () => db.instanceId },
        dataDir: db.directory,
      }),
    close: async () => {
      db.localInstance.cancelMaintenance();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_LOCAL_ROOT_PG_TEST !== "1")(
  "Flow缺失目录真实PG屏障",
  () => {
    it("存在旧根、额外根或伪造Task fence均不能停止Flow", async () => {
      const f = await flowFixture();
      try {
        const input = await f.input();
        await rename(`${f.primary.oldRoot}-missing`, f.primary.oldRoot);
        const available = await f.service.snapshot(
          f.db.actor,
          f.primary.projectId,
        );
        expect(available.flow?.phase).toBe("available");
        expect(available.workDir).toBe(f.primary.oldRoot);
        expect(f.db.localInstance.isDraining()).toBe(false);
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, input),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(f.quiesced).toEqual([]);
        await rename(f.primary.oldRoot, `${f.primary.oldRoot}-missing`);
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, {
            ...input,
            expectedTasks: [
              { taskId: randomUUID(), scopeGeneration: 1, branchGeneration: 1 },
            ],
          }),
        ).rejects.toThrow();
        await f.db.persistence
          .forInstance(f.db.instanceId)
          .execute(
            "update public.projects set additional_directories=$2::jsonb where instance_id=:instance and id=$1",
            [
              f.primary.projectId,
              JSON.stringify([
                { path: f.primary.nextRoot, access: "read-only" },
              ]),
            ],
          );
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, input),
        ).rejects.toThrow("Flow项目必须绑定单一主目录");
        expect(f.quiesced).toEqual([]);
        expect(f.db.localInstance.isDraining()).toBe(false);
        expect(f.readReceipt(f.primary.projectId).generation).toBe(1);
      } finally {
        await f.close();
      }
    }, 60000);
    it("只允许缺失单根；先排空全跨度admission，再真实gate停稳；远端outstanding不伪称已停", async () => {
      const f = await flowFixture();
      try {
        const request = await f.input();
        const endAdmission = f.db.localInstance.beginAdmission();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("文件调用仍在途");
        expect(f.quiesced).toEqual([]);
        expect(f.db.localInstance.isDraining()).toBe(false);
        endAdmission();
        f.setRemoteOutstanding(2);
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.quiesced).toEqual([f.primary.projectId]);
        expect(f.completed).toEqual([]);
        expect(f.db.localInstance.isDraining()).toBe(true);
        const operation = await f.db.persistence
          .forInstance(f.db.instanceId)
          .queryOne<{
            phase: string;
            gateway_receipt: FlowProjectControlReceipt;
          }>(
            "select phase,gateway_receipt from public.project_directory_relink_operations where instance_id=:instance and project_id=$1",
            [f.primary.projectId],
          );
        expect(operation?.phase).toBe("complete_unknown");
        expect(operation?.gateway_receipt).toMatchObject({
          draining: true,
          localSettled: true,
          quiesceSettled: true,
          remoteOutstanding: 2,
        });
        expect(
          (
            await createProjectRepository(f.db.persistence).findActiveById(
              f.db.instanceId,
              f.primary.projectId,
            )
          )?.work_dir,
        ).toBe(f.primary.nextRoot);
      } finally {
        await f.close();
      }
    }, 60000);
    it("remote outstanding in an untrusted completion observation cannot release maintenance", async () => {
      const f = await flowFixture();
      try {
        f.setRemoteOutstanding(2);
        f.useInconsistentCompleteObservation();
        const request = await f.input();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.completed).toEqual([]);
        expect(f.db.localInstance.isDraining()).toBe(true);
        const operation = await f.db.persistence
          .forInstance(f.db.instanceId)
          .queryOne<{
            phase: string;
            gateway_receipt: FlowProjectControlReceipt;
          }>(
            "select phase,gateway_receipt from public.project_directory_relink_operations where instance_id=:instance and project_id=$1",
            [f.primary.projectId],
          );
        expect(operation?.phase).toBe("complete_unknown");
        expect(operation?.gateway_receipt).toMatchObject({
          draining: false,
          remoteOutstanding: 2,
        });
      } finally {
        await f.close();
      }
    }, 60000);

    it("quiesce未知保持原根及maintenance；同operation只观察，不重复停止或接受另一目标", async () => {
      const f = await flowFixture();
      try {
        f.unknownQuiesce();
        const request = await f.input();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.db.localInstance.isDraining()).toBe(true);
        expect(() => f.db.localInstance.beginAdmission()).toThrow();
        expect(
          (
            await createProjectRepository(f.db.persistence).findActiveById(
              f.db.instanceId,
              f.primary.projectId,
            )
          )?.work_dir,
        ).toBe(f.primary.oldRoot);
        const snapshot = await f.service.snapshot(
          f.db.actor,
          f.primary.projectId,
        );
        expect(snapshot.flow).toMatchObject({
          phase: "quiesce_unknown",
          operationId: request.expectedFlow?.operationId,
          previousWorkDir: f.primary.oldRoot,
          nextWorkDir: f.primary.nextRoot,
          receipt: {
            localSettled: false,
            activeRunIds: [`local-${f.primary.projectId}`],
          },
        });
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, {
            ...request,
            nextWorkDir: join(f.db.directory, "different-target"),
          }),
        ).rejects.toThrow();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.quiesced).toEqual([f.primary.projectId]);
        Object.assign(f.readReceipt(f.primary.projectId), {
          localSettled: true,
          quiesceSettled: true,
        });
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.readReceipt(f.primary.projectId).activeRunIds).toEqual([
          `local-${f.primary.projectId}`,
        ]);
        f.settle();
        const result = await f.service.relink(
          f.db.actor,
          f.primary.projectId,
          request,
        );
        expect(result.flow?.phase).toBe("complete");
        expect(f.quiesced).toEqual([f.primary.projectId]);
        expect(f.completed).toEqual([f.primary.projectId]);
      } finally {
        await f.close();
      }
    }, 60000);
    it("根已发布而complete回执未知，冷实例重建maintenance并用同operation只观察完成", async () => {
      const f = await flowFixture();
      const cold = f.coldInstance();
      try {
        f.unknownComplete();
        const request = await f.input();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, request),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(
          (
            await createProjectRepository(f.db.persistence).findActiveById(
              f.db.instanceId,
              f.primary.projectId,
            )
          )?.work_dir,
        ).toBe(f.primary.nextRoot);
        const reopened = f.makeService(cold);
        expect(cold.isDraining()).toBe(false);
        await reopened.initialize();
        expect(cold.isDraining()).toBe(true);
        expect(() => cold.beginAdmission()).toThrow();
        const snapshot = await reopened.snapshot(
          f.db.actor,
          f.primary.projectId,
        );
        expect(snapshot).toMatchObject({
          workDir: f.primary.nextRoot,
          flow: {
            phase: "complete_unknown",
            previousWorkDir: f.primary.oldRoot,
            nextWorkDir: f.primary.nextRoot,
            operationId: request.expectedFlow?.operationId,
          },
        });
        const result = await reopened.relink(
          f.db.actor,
          f.primary.projectId,
          request,
        );
        expect(result.flow?.phase).toBe("complete");
        expect(cold.isDraining()).toBe(false);
        expect(f.quiesced).toEqual([f.primary.projectId]);
        expect(f.completed).toEqual([f.primary.projectId]);
      } finally {
        cold.cancelMaintenance();
        await f.close();
      }
    }, 60000);
    it("另一Flow项目不能加入unknown实例维护或误停其活动运行", async () => {
      const f = await flowFixture();
      try {
        const second = await f.createProject("second-flow"),
          secondRequest = await f.input(second);
        f.unknownQuiesce();
        await expect(
          f.service.relink(f.db.actor, f.primary.projectId, await f.input()),
        ).rejects.toThrow("Flow维护尚未确认");
        await expect(
          f.service.relink(f.db.actor, second.projectId, secondRequest),
        ).rejects.toThrow("Flow维护尚未确认");
        expect(f.quiesced).toEqual([f.primary.projectId]);
        expect(f.readReceipt(second.projectId)).toMatchObject({
          generation: 1,
          draining: false,
          activeRunIds: [`local-${second.projectId}`],
        });
        const count = await f.db.persistence
          .forInstance(f.db.instanceId)
          .queryOne<{ count: number | string }>(
            "select count(*) as count from public.project_directory_relink_operations where instance_id=:instance and phase<>'complete'",
          );
        expect(Number(count?.count)).toBe(1);
        expect(f.db.localInstance.isDraining()).toBe(true);
      } finally {
        await f.close();
      }
    }, 60000);
    it("并发不同项目只允许一个控制操作，不取消竞争项目且不提前释放maintenance", async () => {
      const f = await flowFixture();
      try {
        const second = await f.createProject("concurrent-flow"),
          secondRequest = await f.input(second),
          request = await f.input();
        f.unknownQuiesce();
        const held = f.holdQuiesce();
        const first = f.service
          .relink(f.db.actor, f.primary.projectId, request)
          .then(
            () => null,
            (error: unknown) => error,
          );
        await held.entered;
        await expect(
          f.service.relink(f.db.actor, second.projectId, secondRequest),
        ).rejects.toThrow();
        expect(f.quiesced).toEqual([f.primary.projectId]);
        expect(f.db.localInstance.isDraining()).toBe(true);
        held.release();
        expect(await first).toBeInstanceOf(Error);
        expect(f.readReceipt(second.projectId).activeRunIds).toEqual([
          `local-${second.projectId}`,
        ]);
        expect(f.db.localInstance.isDraining()).toBe(true);
      } finally {
        await f.close();
      }
    }, 60000);
  },
);
