import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "../code-ui/code-ui-http.fixture.js";
import { createCodeSessionFixture } from "../code-ui/host-session.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";

async function getExport(fixture: Fixture, path: string) {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    headers: {
      origin: fixture.origin,
      connection: "close",
      cookie: fixture.cookie,
    },
  });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    json: () =>
      JSON.parse(body) as { error: { code: string; message: string } },
  };
}

/**
 * 真实 Postgres 集成用例，默认跳过；手动执行：
 * RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run \
 *   src/features/run-timeline/timeline-export.integration.test.ts
 */
describe.skipIf(!enabled)("Task 运行时间线 Markdown 导出", () => {
  it("按任务作用域导出、超长截断并注明、越界与归档拒绝", async () => {
    const fixture = await createCodeUiHttpFixture();
    let host: Host | undefined;
    let previousMaxBytes: number | undefined;
    try {
      host = await createCodeSessionFixture(fixture.baseUrl, {
        client: fixture.client,
      });
      const scoped = fixture.database.persistence.forInstance(
        fixture.actor.instanceId,
      );
      const runId = randomUUID();
      const chatSessionId = randomUUID();
      const threadId = randomUUID();
      const startedAt = new Date().toISOString();
      const command = "导出用命令".repeat(30);
      await scoped.query(
        "insert into public.chat_sessions (id, instance_id, project_id, mode, thread_id) values ($1, :instance, $2, 'code', $3)",
        [chatSessionId, host.projectId, threadId],
      );
      // agent_runs 无 instance_id 列，按 run id 定权，不能走实例隔离客户端。
      await fixture.database.persistence.query(
        "insert into public.agent_runs (id, model, session_id, status, thread_id, completed_at) values ($1, null, $2, 'completed', $3, now())",
        [runId, chatSessionId, threadId],
      );
      await scoped.query(
        "update public.code_ui_sessions set chat_session_id = $2 where instance_id = :instance and id = $1",
        [host.sessionId, chatSessionId],
      );
      await scoped.query(
        `insert into public.agent_turn_boundaries
             (run_id, phase, instance_id, project_id, task_id, boundary, task_kind)
           values ($1, 'pre', :instance, $2, $3, $4::jsonb, 'code')`,
        [
          runId,
          host.projectId,
          host.sessionId,
          JSON.stringify({
            phase: "pre",
            scopeGeneration: 0,
            branchGeneration: null,
          }),
        ],
      );
      for (const [index, type] of [
        "run.started",
        "tool.started",
        "tool.completed",
        "run.completed",
      ].entries()) {
        await scoped.query(
          `insert into public.code_ui_events (instance_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
             values (:instance, $1::uuid, $2, $3, $4, $5::jsonb)`,
          [
            host.sessionId,
            index + 1,
            `${runId}/${index + 1}`,
            `timeline-export-${runId}-${index + 1}`,
            JSON.stringify(
              type === "run.started"
                ? {
                    type,
                    runId,
                    sessionId: chatSessionId,
                    conversationId: chatSessionId,
                    timestamp: startedAt,
                  }
                : type === "run.completed"
                  ? {
                      type,
                      runId,
                      stopReason: "completed",
                      timestamp: startedAt,
                    }
                  : type === "tool.started"
                    ? {
                        type,
                        runId,
                        toolCallId: `timeline-export-${index}`,
                        toolName: "Bash",
                        input: { command },
                        timestamp: startedAt,
                      }
                    : {
                        type,
                        runId,
                        toolCallId: `timeline-export-${index}`,
                        toolName: "Bash",
                        status: "success",
                        outputSummary: command,
                        timestamp: startedAt,
                      },
            ),
          ],
        );
      }

      const path = `/api/agent/tasks/${host.sessionId}/runs/${runId}/timeline/export?projectId=${host.projectId}`;
      const normal = await getExport(fixture, path);
      expect(normal.status).toBe(200);
      expect(String(normal.contentType)).toContain("text/markdown");
      expect(normal.body).toContain("Bash");
      expect(normal.body).not.toContain("导出已截断");

      const settingsBefore = await fixture.client.request(
        "/api/instance/settings",
      );
      expect(settingsBefore.status, JSON.stringify(settingsBefore.body)).toBe(
        200,
      );
      previousMaxBytes = settingsBefore.body.settings.codeReadMaxBytes;
      const shrunk = await fixture.client.request(
        "/api/instance/settings",
        { codeReadMaxBytes: 1024 },
        "PATCH",
      );
      expect(shrunk.status, JSON.stringify(shrunk.body)).toBe(200);
      for (let index = 5; index <= 44; index++) {
        await scoped.query(
          `insert into public.code_ui_events (instance_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
             values (:instance, $1::uuid, $2, $3, $4, $5::jsonb)`,
          [
            host.sessionId,
            index,
            `${runId}/${index}`,
            `timeline-export-${runId}-${index}`,
            JSON.stringify({
              type: "tool.completed",
              runId,
              toolCallId: `timeline-export-${index}`,
              toolName: "Bash",
              status: "success",
              outputSummary: command.repeat(2),
              timestamp: startedAt,
            }),
          ],
        );
      }

      const truncated = await getExport(fixture, path);
      expect(truncated.status).toBe(200);
      expect(truncated.body).toContain("导出已截断");
      expect(truncated.body).toContain("共 44 条");
      expect(truncated.body).toContain("运行记录中查看");
      expect(Buffer.byteLength(truncated.body, "utf8")).toBeLessThanOrEqual(
        1024,
      );

      const foreign = await getExport(
        fixture,
        `/api/agent/tasks/${host.sessionId}/runs/${runId}/timeline/export?projectId=${randomUUID()}`,
      );
      expect(foreign.status).toBe(404);
      expect(foreign.json()).toMatchObject({
        error: { code: "run_not_found" },
      });

      await scoped.query(
        "update public.code_ui_sessions set archived = true where instance_id = :instance and id = $1",
        [host.sessionId],
      );
      const rejected = await getExport(fixture, path);
      expect(rejected.status).toBe(409);
      expect(rejected.json()).toMatchObject({
        error: { code: "task_archived" },
      });
      expect(String(rejected.json().error.message)).toContain("归档");
    } finally {
      if (previousMaxBytes !== undefined) {
        await fixture.client.request(
          "/api/instance/settings",
          { codeReadMaxBytes: previousMaxBytes },
          "PATCH",
        );
      }
      await host?.dispose();
      await fixture.close();
    }
  }, 90_000);
});
