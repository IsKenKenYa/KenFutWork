import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { backgroundBashOutputResultSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原后台输出详情公开接线 integration",
  () => {
    it("原RPC读取真实运行与终态日志，其他Task拒绝，完整文件按钮沿受控URI读取", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await heldModel({
        initialTool: {
          id: "ui-live-bash",
          name: "Bash",
          arguments: {
            command:
              "printf 'UI_LIVE_BOOT\n'; IFS= read -r line; printf 'UI_DONE:%s\n' \"$line\"",
            run_in_background: true,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const currentHost = host;
        await host.command("sendText", {
          text: "START_LIVE_BACKGROUND_OUTPUT",
        });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const root = await snapshot(fixture, host.sessionId);
        const work = root.backgroundWorks.find(
          (entry) => entry.kind === "bash" && entry.status === "running",
        );
        if (!work) throw new Error("真实后台命令身份缺失");
        const query = {
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          workId: work.workId,
        };
        await vi.waitFor(
          async () => {
            const result = await currentHost.stream.rpc(
              "backgroundBashOutputV4",
              [query],
            );
            expect(result.body.result).toMatchObject({
              kind: "output",
              output: expect.stringContaining("UI_LIVE_BOOT"),
            });
          },
          { timeout: 30_000 },
        );
        const current = await host.stream.rpc("backgroundBashOutputV4", [
          query,
        ]);
        expect(current.status, JSON.stringify(current.body)).toBe(200);
        const live = backgroundBashOutputResultSchema.parse(
          current.body.result,
        );
        expect(live).toMatchObject({
          kind: "output",
          workId: work.workId,
          status: "running",
          output: expect.stringContaining("UI_LIVE_BOOT"),
        });
        if (live.kind !== "output") throw new Error("原输出详情未真实读取");
        expect(live.outputPath).toMatch(/^code-output:/u);
        const another = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              type: "createSession",
              sessionId: null,
              commandId: randomUUID(),
              clientId: host.clientId,
              issuedAt: Date.now(),
              payload: {
                workspaceId: host.projectId,
                config: { modelSelection: root.config.modelSelection },
              },
            },
          },
        ]);
        const otherId = another.body.result.result.sessionId;
        const wrong = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, sessionId: otherId },
        ]);
        expect(wrong.body.result).toEqual({
          kind: "unavailable",
          workId: work.workId,
        });
        const wrongPath = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, workspacePath: `${host.workspacePath}/not-authorized` },
        ]);
        expect(wrongPath.status).toBe(404);
        tools[2] = {
          id: "release-ui-live-bash",
          name: "TaskInput",
          arguments: { task_id: work.workId, data: "中文尾部\n", close: true },
        };
        model.finish(1);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        await host.command("sendText", {
          text: "FINISH_REAL_BACKGROUND_COMMAND",
        });
        await vi.waitFor(
          () => expect(model.requests.length).toBeGreaterThanOrEqual(4),
          { timeout: 30_000 },
        );
        await vi.waitFor(
          async () => {
            const ended = await currentHost.stream.rpc(
              "backgroundBashOutputV4",
              [query],
            );
            expect(ended.status).toBe(200);
            expect(
              backgroundBashOutputResultSchema.parse(ended.body.result),
            ).toMatchObject({
              kind: "output",
              status: "completed",
              output: expect.stringContaining("UI_DONE:中文尾部"),
            });
          },
          { timeout: 30_000 },
        );
        const file = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          args: [
            {
              path: live.outputPath,
              viewerScope: { kind: "task", taskId: host.sessionId },
              maxBytes: 4096,
            },
          ],
        });
        expect(file.status, JSON.stringify(file.body)).toBe(200);
        expect(file.body.result.content).toBe(
          "UI_LIVE_BOOT\nUI_DONE:中文尾部\n",
        );
        const scope = { kind: "task", taskId: host.sessionId };
        const metadata = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "stat",
          args: [{ path: live.outputPath, viewerScope: scope }],
        });
        expect(metadata.status).toBe(200);
        expect(metadata.body.result).toMatchObject({
          path: live.outputPath,
          type: "file",
          size: Buffer.byteLength("UI_LIVE_BOOT\nUI_DONE:中文尾部\n"),
        });
        const range = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "readFileRange",
          args: [
            {
              path: live.outputPath,
              viewerScope: scope,
              offset: 13,
              length: 7,
            },
          ],
        });
        expect(range.status).toBe(200);
        expect(Buffer.from(range.body.result.data, "base64").toString()).toBe(
          "UI_DONE",
        );
        const wrongFile = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          args: [
            {
              path: live.outputPath,
              viewerScope: { kind: "task", taskId: otherId },
              maxBytes: 4096,
            },
          ],
        });
        expect(wrongFile.status).toBe(404);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);

    it("真实捕获文件丢失时返回原read_failed，原目录与未知工作仍各自拒绝", async () => {
      const fixture = await createCodeUiHttpFixture();
      const tools: NonNullable<
        Parameters<typeof heldModel>[0]
      >["toolsByRequest"] = {};
      const model = await heldModel({
        initialTool: {
          id: "ui-missing-bash",
          name: "Bash",
          arguments: {
            command: "printf 'CAPTURE_BEFORE_REMOVAL'",
            run_in_background: true,
          },
        },
        toolsByRequest: tools,
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const currentHost = host;
        await host.command("sendText", { text: "CAPTURE_TO_REMOVE" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const current = await snapshot(fixture, host.sessionId);
        const bash = current.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolName === "Bash",
        );
        if (bash?.kind !== "toolCall" || !bash.output?.text)
          throw new Error("实际后台Bash结果缺失");
        const captured = JSON.parse(bash.output.text);
        const query = {
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          workId: captured.taskId,
        };
        await vi.waitFor(
          async () => {
            const result = await currentHost.stream.rpc(
              "backgroundBashOutputV4",
              [query],
            );
            expect(result.body.result).toMatchObject({
              kind: "output",
              status: "completed",
              output: "CAPTURE_BEFORE_REMOVAL",
            });
          },
          { timeout: 30_000 },
        );
        tools[2] = {
          id: "read-capture-path",
          name: "TaskOutput",
          arguments: { task_id: captured.taskId },
        };
        model.finish(1);
        // 真实完成通知自动开启下一Run，不能把已被续跑的Task误等为空闲。
        await vi.waitFor(() => expect(model.requests).toHaveLength(4), {
          timeout: 30_000,
        });
        const reading = await snapshot(fixture, host.sessionId);
        const row = reading.rows.window.find(
          (entry) =>
            entry.kind === "toolCall" && entry.toolName === "TaskOutput",
        );
        if (row?.kind !== "toolCall" || !row.output?.text)
          throw new Error("公开TaskOutput未返回真实输出");
        const read = JSON.parse(row.output.text);
        if (
          typeof read.outputRef !== "string" ||
          !read.outputRef.startsWith(`${fixture.directory}/`)
        )
          throw new Error("待移除的真实捕获不在独占fixture内");
        await writeFile(read.outputRef, "TAMPERED_CAPTURE");
        const corrupt = await host.stream.rpc("backgroundBashOutputV4", [
          query,
        ]);
        expect(corrupt.body.result).toMatchObject({
          kind: "read_failed",
          workId: captured.taskId,
        });
        await writeFile(read.outputRef, "CAPTURE_BEFORE_REMOVAL");
        const restored = await host.stream.rpc("backgroundBashOutputV4", [
          query,
        ]);
        expect(restored.body.result).toMatchObject({
          kind: "output",
          output: "CAPTURE_BEFORE_REMOVAL",
        });
        await rm(read.outputRef);
        const missing = await host.stream.rpc("backgroundBashOutputV4", [
          query,
        ]);
        expect(missing.status, JSON.stringify(missing.body)).toBe(200);
        expect(
          backgroundBashOutputResultSchema.parse(missing.body.result),
        ).toEqual({
          kind: "read_failed",
          workId: captured.taskId,
          code: "ENOENT",
        });
        const absent = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, workId: randomUUID() },
        ]);
        expect(absent.body.result).toEqual({
          kind: "unavailable",
          workId: expect.any(String),
        });
        const wrong = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, workspacePath: `${host.workspacePath}/foreign` },
        ]);
        expect(wrong.status).toBe(404);
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);

    it("运行中大日志遵守尾窗预算且中文emoji完整，原全文读取保留开头", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel({
        initialTool: {
          id: "ui-unicode-tail",
          name: "Bash",
          arguments: {
            command:
              "printf 'START_OF_FULL_FILE\n'; i=0; while [ \"$i\" -lt 1000 ]; do printf '中文🙂'; i=$((i + 1)); done; printf '🙂中文尾窗'; IFS= read -r line",
            run_in_background: true,
          },
        },
      });
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const currentHost = host;
        expect(
          (
            await host.client.request(
              "/api/instance/settings",
              { processPreviewMaxChars: 128 },
              "PATCH",
            )
          ).status,
        ).toBe(200);
        await host.command("sendText", { text: "START_LONG_LOG" });
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const state = await snapshot(fixture, host.sessionId);
        const work = state.backgroundWorks.find(
          (entry) => entry.kind === "bash" && entry.status === "running",
        );
        if (!work) throw new Error("真实大日志后台身份缺失");
        const query = {
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          workId: work.workId,
        };
        await vi.waitFor(
          async () => {
            const result = await currentHost.stream.rpc(
              "backgroundBashOutputV4",
              [query],
            );
            expect(result.body.result).toMatchObject({
              kind: "output",
              output: expect.stringContaining("🙂中文尾窗"),
            });
          },
          { timeout: 30_000 },
        );
        const response = await host.stream.rpc("backgroundBashOutputV4", [
          query,
        ]);
        const preview = backgroundBashOutputResultSchema.parse(
          response.body.result,
        );
        if (preview.kind !== "output")
          throw new Error("原尾窗没有返回真实日志");
        expect(preview.status).toBe("running");
        expect(preview.truncated).toBe(true);
        expect(Buffer.byteLength(preview.output)).toBeLessThanOrEqual(512);
        expect(preview.output).not.toContain("\ufffd");
        expect(preview.output).not.toContain("START_OF_FULL_FILE");
        const file = await host.client.request("/api/code-ui/rpc", {
          service: "file",
          method: "readTextFile",
          args: [
            {
              path: preview.outputPath,
              viewerScope: { kind: "task", taskId: host.sessionId },
              maxBytes: 16_384,
            },
          ],
        });
        expect(file.status).toBe(200);
        expect(file.body.result.content).toBe(
          `START_OF_FULL_FILE\n${"中文🙂".repeat(1000)}🙂中文尾窗`,
        );
        expect(file.body.result.truncated).toBe(false);
        const invalid = await host.stream.rpc("backgroundBashOutputV4", [
          { ...query, workId: "../../foreign" },
        ]);
        expect(invalid.body.result).toEqual({
          kind: "unavailable",
          workId: "../../foreign",
        });
      } finally {
        if (host) await host.dispose();
        await model.close();
        await fixture.close();
      }
    }, 120_000);
  },
);
