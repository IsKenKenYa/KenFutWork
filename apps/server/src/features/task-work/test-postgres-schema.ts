import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { Client } from "pg";
import {
  ensurePgmqAvailable,
  resolvePgmqShimDir,
} from "../../desktop/pgmq-shim.js";
import { createLocalAccessService } from "../local-access/service.js";
import { createLocalAccessStore } from "../local-access/store.js";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import {
  applyMigrations,
  loadMigrationSet,
} from "../persistence/migrations.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTemporaryPostgres } from "./test-postgres.js";
import type { TaskWorkContext } from "./types.js";

/** Schema 唯一来源仍为bootstrap+migrations；夹具只通过服务/公开SQL入口创建业务数据。 */
export async function createTaskWorkDatabase() {
  const database = await createTemporaryPostgres();
  const client = new Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    await ensurePgmqAvailable(client, {
      binDir: database.binDir,
      shimDir: resolvePgmqShimDir({ env: {}, repoRoot: root }),
    });
    const files = loadMigrationSet({
      bootstrapDir: join(root, "supabase", "bootstrap"),
      migrationsDir: join(root, "supabase", "migrations"),
    });
    const queryable = {
      async query<T = Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ) {
        const result = await client.query(text, values);
        return { rowCount: result.rowCount, rows: result.rows as T[] };
      },
    };
    const first = await applyMigrations(queryable, files);
    const second = await applyMigrations(queryable, files);
    const persistence = createPostgresPersistence({
      databaseUrl: database.connectionString,
    });
    const localInstance = createLocalInstanceService({
      repository: createLocalInstanceRepository(persistence),
      dataDir: database.directory,
    });
    const { instanceId } = await localInstance.getContext();
    const localAccess = createLocalAccessService({
      instance: localInstance,
      store: createLocalAccessStore(persistence),
      allowedOrigins: [],
      readGovernance: async () => ({
        ticketTtlMs: AGENT_GOVERNANCE_DEFAULTS.localAccessTicketTtlMs,
        sessionMaxAgeMs: AGENT_GOVERNANCE_DEFAULTS.localAccessSessionMaxAgeMs,
      }),
    });
    const desktopToken = await localAccess.getDesktopToken();
    const actor = await localAccess.authenticate({
      ip: "127.0.0.1",
      headers: { authorization: `Bearer ${desktopToken}` },
    });
    if (!actor) throw new Error("隔离夹具本地接入未初始化。");
    const directory = join(database.directory, "project");
    await mkdir(directory);
    const { project } = await createProjectRepository(
      persistence,
    ).createProject({
      instanceId,
      createdByClientId: actor.accessClientId,
      kind: "code",
      name: "TaskWork隔离回归",
      slug: "task-work-test",
      description: null,
      canvasName: "unused",
      workDir: directory,
    });
    const taskId = randomUUID();
    const context: TaskWorkContext = {
      actor,
      scope: {
        instanceId,
        projectId: project.id,
        taskId,
        generation: 1,
        rootDirectory: directory,
        additionalDirectories: [],
        sandboxMode: "workspace-write",
      },
      agentId: "main",
      runId: "test-run",
      branchGeneration: 1,
    };
    await persistence
      .forInstance(instanceId)
      .execute(
        `insert into public.code_ui_sessions (id, instance_id, project_id, root_session_id, root_directory, additional_directories, sandbox_mode, scope_generation, branch_generation) values ($1, :instance, $2, $1, $3, '[]'::jsonb, 'workspace-write', 1, 1)`,
        [taskId, project.id, directory],
      );
    return {
      ...database,
      persistence,
      localInstance,
      localAccess,
      actor,
      desktopToken,
      instanceId,
      context,
      replayed: first.applied,
      expectedMigrations: files.length,
      secondReplay: second.applied,
      async close() {
        await persistence.close();
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  } finally {
    await client.end();
  }
}
