import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "完整输出发表事务 integration",
  () => {
    it("真实新根SQL失败不留下副本/Task/native，失败重放不复制且源字节不动", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "output-rollback-bash",
          name: "Bash",
          arguments: {
            command: "printf '%s' 'IMMUTABLE_OUTPUT_ROLLBACK_SOURCE'",
            run_in_background: false,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        await host.command("sendText", {
          text: "SOURCE_BEFORE_PUBLICATION_FAILURE",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        model.finish(1);
        const source = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        const bash = source.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Bash",
        );
        if (bash?.kind !== "toolCall" || !bash.output?.text)
          throw new Error("真实事务源输出缺失");
        const sourcePath = JSON.parse(bash.output.text).outputPath;
        const assistant = source.rows.window.find(
          (row) => row.kind === "assistantText" && row.state === "complete",
        );
        if (!assistant?.entityId) throw new Error("事务源回复缺失");
        const blobFiles = async () =>
          (
            await readdir(join(fixture.directory, "blobs"), {
              recursive: true,
              withFileTypes: true,
            })
          )
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name))
            .sort();
        const currentHost = host;
        const list = async () =>
          (
            await currentHost.client.request("/api/code-ui/rpc", {
              service: "zcode-task",
              method: "listTasks",
              args: [
                {
                  workspacePath: currentHost.workspacePath,
                  projectId: currentHost.projectId,
                },
              ],
            })
          ).body.result;
        await mkdir(join(fixture.directory, "blobs"), { recursive: true });
        const beforeFiles = await blobFiles();
        const beforeList = await list();
        const beforeNative = await fixture.database.persistence.query(
          "select distinct thread_id from langgraph.checkpoints order by thread_id",
        );
        await fixture.database.persistence.execute(
          "create function public.reject_test_output_root() returns trigger language plpgsql as $$ begin raise exception '测试输出发表失败'; end $$",
        );
        await fixture.database.persistence.execute(
          "create trigger reject_test_output_root before insert on public.code_ui_sessions for each row execute function public.reject_test_output_root()",
        );
        const commandId = randomUUID();
        const payload = {
          target: { rowId: assistant.rowId, entityId: assistant.entityId },
        };
        const guard = {
          baseRevision: source.revision,
          baseLogEpoch: source.logEpoch,
        };
        const failed = await host.command(
          "forkAssistant",
          payload,
          commandId,
          guard,
        );
        expect(failed.body.result).toMatchObject({
          status: "failed",
          reasonCode: "fork_failed",
          message: "测试输出发表失败",
        });
        expect(await list()).toEqual(beforeList);
        expect(await blobFiles()).toEqual(beforeFiles);
        expect(
          await fixture.database.persistence.query(
            "select distinct thread_id from langgraph.checkpoints order by thread_id",
          ),
        ).toEqual(beforeNative);
        expect(await readFile(sourcePath, "utf8")).toBe(
          "IMMUTABLE_OUTPUT_ROLLBACK_SOURCE",
        );
        const replayed = await host.command(
          "forkAssistant",
          payload,
          commandId,
          guard,
        );
        expect(replayed.body.result).toEqual({
          ...failed.body.result,
          status: "duplicate",
        });
        expect(await blobFiles()).toEqual(beforeFiles);
        expect((await snapshot(fixture, host.sessionId)).control.phase).toBe(
          "completedSuccess",
        );
        expect(model.requests).toHaveLength(2);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
