import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

/**
 * 手动执行（需要本机真实 Postgres，默认跳过）：
 *
 * RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run \
 *   src/features/code-ui/tool-output-http.integration.test.ts
 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "工具输出原文 HTTP 读取 integration",
  () => {
    function readToolOutputPath(host: Host, ref: string, offset = 0) {
      return `/api/code-ui/tool-output?sessionId=${encodeURIComponent(
        host.sessionId,
      )}&ref=${encodeURIComponent(ref)}&offset=${offset}`;
    }

    /** 写入一条真实终态工具事件；读取路由按 runId/toolCallId 在事件表里取最新一条。 */
    async function seedToolCompletion(
      fixture: Awaited<ReturnType<typeof createCodeUiHttpFixture>>,
      host: Host,
    ) {
      const runId = randomUUID();
      const toolCallId = randomUUID();
      const identity = await fixture.database.persistence.queryOne<{
        instance_id: string;
      }>(
        "select instance_id from public.code_ui_sessions where id=$1",
        [host.sessionId],
      );
      if (!identity) throw new Error("Task 身份未持久化。");
      const outputText = "工具输出片段1234".repeat(1_400);
      const event = {
        type: "tool.completed",
        runId,
        toolCallId,
        toolName: "Bash",
        status: "success",
        outputText,
        timestamp: new Date().toISOString(),
      };
      await fixture.database.persistence
        .forInstance(identity.instance_id)
        .execute(
          `insert into public.code_ui_events (instance_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
           values (:instance, $1::uuid, (select coalesce(max(seq), 0) + 1 from public.code_ui_events where instance_id = :instance and root_session_id = $1::uuid), $2, $3, $4::jsonb)`,
          [
            host.sessionId,
            `tool-output-http-${toolCallId}`,
            `fingerprint-${toolCallId}`,
            JSON.stringify(event),
          ],
        );
      return {
        ref: `${runId}/${toolCallId}`,
        outputText,
        outputBytes: Buffer.byteLength(outputText, "utf8"),
      };
    }

    it("可读回原文，归档后拒绝并给出可读原因；无效凭据被拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const currentHost = host;
        // 让 Task 先在真实事件表里拥有一次运行生命周期，归档操作才有可观察的公开状态。
        const accepted = await currentHost.command("sendText", {
          text: "查看工具输出原文",
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        const stoppedCommand = await currentHost.command("stop", {});
        expect(stoppedCommand.status, JSON.stringify(stoppedCommand.body)).toBe(
          200,
        );
        const stopped = await waitPhase(
          fixture,
          currentHost.sessionId,
          "completedInterrupted",
        );

        const seeded = await seedToolCompletion(fixture, currentHost);
        const path = readToolOutputPath(currentHost, seeded.ref);

        const read = await currentHost.client.request(path);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(read.body.text).toContain("工具输出片段");
        expect(read.body.totalBytes).toBe(seeded.outputBytes);
        expect(read.body.nextOffset).toEqual(expect.any(Number));

        let gathered: string = read.body.text;
        let offset: number | null = read.body.nextOffset;
        let pages = 1;
        while (offset !== null && pages < 10) {
          const next = await currentHost.client.request(
            readToolOutputPath(currentHost, seeded.ref, offset),
          );
          expect(next.status, JSON.stringify(next.body)).toBe(200);
          gathered += next.body.text;
          offset = next.body.nextOffset;
          pages += 1;
        }
        expect(gathered).toBe(seeded.outputText);

        if (!stopped.taskControl)
          throw new Error("归档前缺少 Task 公开观察值。");
        const archived = await currentHost.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "archiveTask",
          args: [
            {
              taskId: currentHost.sessionId,
              workspacePath: currentHost.workspacePath,
              workspaceIdentity: JSON.stringify([
                currentHost.projectId,
                currentHost.workspacePath,
              ]),
              taskControl: structuredClone(stopped.taskControl),
            },
          ],
        });
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);

        const denied = await currentHost.client.request(path);
        expect(denied.status, JSON.stringify(denied.body)).toBe(409);
        expect(denied.body).toMatchObject({
          error: {
            code: "code_ui_command_conflict",
            message: expect.stringContaining("已归档"),
          },
        });

        const unauthenticated = await fetch(`${fixture.baseUrl}${path}`, {
          headers: {
            origin: fixture.origin,
            connection: "close",
            cookie: "kenfutwork_local_access=forged",
          },
        });
        expect(unauthenticated.status).toBe(401);
        expect(await unauthenticated.json()).toMatchObject({
          error: { code: "unauthorized" },
        });
      } finally {
        await host?.dispose();
        await model.close();
        await fixture.close();
      }
    }, 90_000);
  },
);
