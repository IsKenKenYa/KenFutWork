import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  ensurePgmqAvailable,
  resolvePgmqShimDir,
} from "../../desktop/pgmq-shim.js";
import { createAccountRepository } from "../auth/repository.js";
import { createViewerRepository } from "../bootstrap/repository.js";
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
    const email = `task-work-${randomUUID()}@integration.local`;
    const account = await createAccountRepository(
      persistence,
    ).ensurePasswordlessAccount({ email, displayName: "隔离回归" });
    const viewer = createViewerRepository(persistence);
    await viewer.bootstrap({ email, userId: account.id, userMeta: {} });
    const workspace = await viewer.findPersonalWorkspace(account.id);
    if (!workspace) throw new Error("夹具工作区未创建。");
    const directory = join(database.directory, "project");
    await mkdir(directory);
    const { project } = await createProjectRepository(
      persistence,
    ).createProject({
      workspaceId: workspace.id,
      userId: account.id,
      kind: "code",
      name: "TaskWork隔离回归",
      slug: "task-work-test",
      description: null,
      canvasName: "unused",
      workDir: directory,
    });
    const taskId = randomUUID();
    const context: TaskWorkContext = {
      scope: {
        workspaceId: workspace.id,
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
      .forWorkspace(workspace.id)
      .execute(
        `insert into public.code_ui_sessions (id, workspace_id, project_id, root_session_id, root_directory, additional_directories, sandbox_mode, scope_generation, branch_generation) values ($1, :workspace, $2, $1, $3, '[]'::jsonb, 'workspace-write', 1, 1)`,
        [taskId, project.id, directory],
      );
    return {
      ...database,
      persistence,
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
