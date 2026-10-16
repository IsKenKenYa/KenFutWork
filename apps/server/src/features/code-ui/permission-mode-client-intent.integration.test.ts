import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type HttpFixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type ModelTools = NonNullable<
  NonNullable<Parameters<typeof heldModel>[0]>["toolsByRequest"]
>;
const FILE_SENTINEL = "PERMISSION_SUBMISSION_REAL_FILE_532d";

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function scope(host: Host) {
  const result = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(result.status).toBe(200);
  return codeTaskScopeResponseSchema.parse(result.body).scope;
}

async function toolResult(host: Host, name: "Read" | "Write") {
  return vi.waitFor(
    async () => {
      const row = (await snapshot(host)).rows.window.find(
        (entry) => entry.kind === "toolCall" && entry.toolName === name,
      );
      if (
        row?.kind !== "toolCall" ||
        !["success", "error"].includes(row.status)
      )
        throw new Error("真实文件工具尚未返回终态");
      return row;
    },
    { timeout: 30_000 },
  );
}

async function fileContent(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}

async function withTask(
  initialMode: "build" | "yolo",
  tool: "Read" | "Write" | undefined,
  run: (input: {
    host: Host;
    model: Model;
    outside: string;
    fixture: HttpFixture;
    toolsByRequest: ModelTools;
  }) => Promise<void>,
) {
  const fixture = await createCodeUiHttpFixture();
  const outside = join(fixture.directory, "permission-outside.txt");
  if (tool === "Read") await writeFile(outside, FILE_SENTINEL);
  const toolsByRequest: ModelTools = {};
  const model = await heldModel({
    toolsByRequest,
    ...(tool
      ? {
          initialTool: {
            id: `permission-${tool.toLowerCase()}`,
            name: tool,
            arguments:
              tool === "Write"
                ? { file_path: outside, content: FILE_SENTINEL }
                : { file_path: outside },
          },
        }
      : {}),
  });
  let host: Host | undefined;
  try {
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig: { mode: initialMode, planEnabled: false },
    });
    await run({ host, model, outside, fixture, toolsByRequest });
  } finally {
    if (host) {
      if ((await snapshot(host)).control.canStop)
        await host.command("stop", {});
      await host.dispose();
    }
    await model.close();
    await fixture.close();
  }
}

// 原HTTP/SSE、已有Task、真实PG与文件工具；仅外部模型输出受控。
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "基础权限点击接纳与真实Task工作域 integration",
  () => {
    it("已有build Task发送yolo输入后，公开作用域及实际Run都能写授权根外的本机文件", async () => {
      await withTask("build", "Write", async ({ host, outside }) => {
        expect((await scope(host)).sandboxMode).toBe("workspace-write");
        expect(
          (
            await host.command("sendText", {
              text: "以本次完全访问选择写文件",
              mode: "yolo",
              planEnabled: false,
            })
          ).body.result.status,
        ).toBe("accepted");
        const written = await toolResult(host, "Write");
        expect.soft((await scope(host)).sandboxMode).toBe("danger-full-access");
        expect.soft(written.status).toBe("success");
        expect.soft(await fileContent(outside)).toBe(FILE_SENTINEL);
        expect((await snapshot(host)).pendingInteractions).toEqual([]);
      });
    }, 90_000);

    it("已有yolo Task发送build输入后，公开作用域收窄且实际Run不能沿用全盘读取", async () => {
      await withTask("yolo", "Read", async ({ host }) => {
        expect((await scope(host)).sandboxMode).toBe("danger-full-access");
        expect(
          (
            await host.command("sendText", {
              text: "按本次变更前确认选择调查",
              mode: "build",
              planEnabled: false,
            })
          ).body.result.status,
        ).toBe("accepted");
        const read = await toolResult(host, "Read");
        expect.soft((await scope(host)).sandboxMode).toBe("workspace-write");
        expect.soft(read.status).toBe("error");
        expect.soft(JSON.stringify(read.output)).not.toContain(FILE_SENTINEL);
      });
    }, 90_000);

    it.each([
      {
        initial: "build",
        next: "yolo",
        before: "workspace-write",
        after: "danger-full-access",
      },
      {
        initial: "yolo",
        next: "build",
        before: "danger-full-access",
        after: "workspace-write",
      },
    ] as const)(
      "忙时$initial→$next的guide请求排队为新Run，不改旧Run工作域",
      async ({ initial, next, before, after }) => {
        await withTask(initial, undefined, async ({ host, model }) => {
          await host.command("sendText", { text: "保留原前台运行" });
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          const first = (await snapshot(host)).control.activeWorks.find(
            (work) => work.kind === "primaryTurn",
          )?.foregroundExecutionId;
          if (!first) throw new Error("真实前台Run未建立");
          const queued = await host.command("sendText", {
            text: "本次权限选择的新工作",
            mode: next,
            planEnabled: false,
            requestedDelivery: "guide",
          });
          expect(queued.body.result.status).toBe("accepted");
          const waiting = await snapshot(host);
          const input = waiting.queue.items.find(
            (item) => item.text === "本次权限选择的新工作",
          );
          expect.soft(input?.delivery.admitted).toBe("queue");
          expect((await scope(host)).sandboxMode).toBe(before);
          expect(
            waiting.control.activeWorks.find(
              (work) => work.kind === "primaryTurn",
            )?.foregroundExecutionId,
          ).toBe(first);
          model.finish(0);
          await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
            timeout: 30_000,
          });
          const running = await snapshot(host);
          expect
            .soft(
              running.control.activeWorks.find(
                (work) => work.kind === "primaryTurn",
              )?.foregroundExecutionId,
            )
            .not.toBe(first);
          expect.soft((await scope(host)).sandboxMode).toBe(after);
        });
      },
      90_000,
    );

    it("同批yolo队列真实Write成功，后续build队列真实Read不能沿用全盘读取", async () => {
      await withTask(
        "build",
        undefined,
        async ({ host, model, outside, toolsByRequest }) => {
          toolsByRequest[1] = {
            id: "queue-full-write",
            name: "Write",
            arguments: { file_path: outside, content: FILE_SENTINEL },
          };
          toolsByRequest[3] = {
            id: "queue-final-read",
            name: "Read",
            arguments: { file_path: outside },
          };
          await host.command("sendText", {
            text: "先保留第一轮",
            mode: "build",
          });
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          await host.command("sendText", {
            text: "下一轮完全访问",
            mode: "yolo",
            requestedDelivery: "queue",
          });
          await host.command("sendText", {
            text: "再下一轮变更前确认",
            mode: "build",
            requestedDelivery: "queue",
          });
          expect((await snapshot(host)).queue.items).toHaveLength(2);
          expect((await scope(host)).sandboxMode).toBe("workspace-write");
          model.finish(0);
          const written = await toolResult(host, "Write");
          expect.soft(written.status).toBe("success");
          expect.soft(await fileContent(outside)).toBe(FILE_SENTINEL);
          expect
            .soft((await scope(host)).sandboxMode)
            .toBe("danger-full-access");
          expect((await snapshot(host)).pendingInteractions).toEqual([]);
          await vi.waitFor(() => expect(model.requests).toHaveLength(3), {
            timeout: 30_000,
          });
          model.finish(2);
          const read = await toolResult(host, "Read");
          expect.soft((await scope(host)).sandboxMode).toBe("workspace-write");
          expect.soft(read.status).toBe("error");
          expect(JSON.stringify(read.output)).not.toContain(FILE_SENTINEL);
          expect((await snapshot(host)).queue.items).toEqual([]);
        },
      );
    }, 120_000);

    it("内部权限已更新但尚未派发时Stop获准，迟到接线不得执行模型或真实Write", async () => {
      await withTask(
        "build",
        "Write",
        async ({ host, model, outside, fixture }) => {
          let entered = false;
          let release!: () => void;
          const ready = new Promise<void>((resolve) => {
            release = resolve;
          });
          const stopListening = fixture.app.kernel
            .get("executionScopes")
            .onUpdated(async ({ next }) => {
              if (
                next.taskId !== host.sessionId ||
                next.sandboxMode !== "danger-full-access"
              )
                return;
              entered = true;
              await ready;
            });
          try {
            const accepted = await host.command("sendText", {
              text: "本次完整访问写入",
              mode: "yolo",
            });
            expect(accepted.body.result.status).toBe("accepted");
            await vi.waitFor(() => expect(entered).toBe(true), {
              timeout: 30_000,
            });
            const current = await snapshot(host);
            const execution = current.control.activeWorks.find(
              (work) => work.kind === "primaryTurn",
            )?.foregroundExecutionId;
            if (!execution) throw new Error("权限准备阶段缺少真实Run身份");
            expect(
              (
                await host.command("stop", {
                  expectedForegroundExecutionId: execution,
                })
              ).body.result.status,
            ).toBe("accepted");
            release();
            await vi.waitFor(
              async () =>
                expect((await snapshot(host)).control.phase).not.toBe(
                  "running",
                ),
              { timeout: 30_000 },
            );
            expect.soft(model.requests).toHaveLength(0);
            expect(await fileContent(outside)).toBeNull();
          } finally {
            release();
            stopListening();
          }
        },
      );
    }, 120_000);

    it("内部升权ready后的外部撤权胜过迟到代际迁移，不重新扩大权限或执行Write", async () => {
      await withTask(
        "build",
        "Write",
        async ({ host, model, outside, fixture }) => {
          let entered = false;
          let release!: () => void;
          const ready = new Promise<void>((resolve) => {
            release = resolve;
          });
          const stopListening = fixture.app.kernel
            .get("executionScopes")
            .onUpdated(async ({ next }) => {
              if (
                next.taskId !== host.sessionId ||
                next.sandboxMode !== "danger-full-access"
              )
                return;
              entered = true;
              await ready;
            });
          try {
            expect(
              (
                await host.command("sendText", {
                  text: "升权准备后发生明确撤权",
                  mode: "yolo",
                })
              ).body.result.status,
            ).toBe("accepted");
            await vi.waitFor(() => expect(entered).toBe(true), {
              timeout: 30_000,
            });
            const revoked = await host.client.request(
              `/api/code-ui/tasks/${host.sessionId}/scope`,
              { sandboxMode: "workspace-write" },
              "PATCH",
            );
            expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
            release();
            await vi.waitFor(
              async () =>
                expect((await snapshot(host)).control.phase).toBe("error"),
              { timeout: 30_000 },
            );
            expect
              .soft((await scope(host)).sandboxMode)
              .toBe("workspace-write");
            expect.soft(model.requests).toHaveLength(0);
            expect(await fileContent(outside)).toBeNull();
          } finally {
            release();
            stopListening();
          }
        },
      );
    }, 120_000);

    it("历史yolo轮次在明确收窄后重试，不重新签发旧全权且真实Read仍被拒绝", async () => {
      await withTask(
        "yolo",
        undefined,
        async ({ host, model, outside, toolsByRequest }) => {
          await writeFile(outside, FILE_SENTINEL);
          await host.command("sendText", {
            text: "原完全访问输入",
            mode: "yolo",
          });
          await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
            timeout: 30_000,
          });
          model.finish(0);
          await vi.waitFor(
            async () =>
              expect((await snapshot(host)).control.phase).toBe(
                "completedSuccess",
              ),
            { timeout: 30_000 },
          );
          const completed = await snapshot(host);
          const target = completed.rows.window
            .filter((row) => row.kind === "assistantText")
            .at(-1);
          if (target?.kind !== "assistantText" || !target.actions?.canRetry)
            throw new Error("原轮次没有公开可重试正文");
          expect(
            (
              await host.client.request(
                `/api/code-ui/tasks/${host.sessionId}/scope`,
                { sandboxMode: "workspace-write" },
                "PATCH",
              )
            ).status,
          ).toBe(200);
          toolsByRequest[1] = {
            id: "retry-read",
            name: "Read",
            arguments: { file_path: outside },
          };
          const current = await snapshot(host);
          const retried = await host.command(
            "retryTurn",
            {
              target: { rowId: target.rowId, entityId: target.entityId },
            },
            undefined,
            { baseRevision: current.revision, baseLogEpoch: current.logEpoch },
          );
          expect(retried.body.result.status, JSON.stringify(retried.body)).toBe(
            "accepted",
          );
          const read = await toolResult(host, "Read");
          expect.soft((await scope(host)).sandboxMode).toBe("workspace-write");
          expect.soft(read.status).toBe("error");
          expect(JSON.stringify(read.output)).not.toContain(FILE_SENTINEL);
        },
      );
    }, 120_000);
  },
);
