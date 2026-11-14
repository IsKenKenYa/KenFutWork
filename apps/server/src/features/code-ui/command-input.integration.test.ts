import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canvasCreateResponseSchema,
  codeUiWorkspaceListSchema,
  modelListResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
  wsServerErrorSchema,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { modelRequestSchema } from "./user-question-model.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function createDesignTask(fixture: Fixture, provider: Host) {
  const created = await fixture.client.request("/api/projects", {
    name: "命令Design验收",
    kind: "design",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(created.body).project;
  const canvasResponse = await fixture.client.request(
    `/api/projects/${project.id}/canvases`,
    { name: "命令Design画布" },
  );
  expect(canvasResponse.status, JSON.stringify(canvasResponse.body)).toBe(201);
  const { canvas } = canvasCreateResponseSchema.parse(canvasResponse.body);
  const workspaceResponse = await fixture.client.request(
    "/api/code-ui/workspaces",
  );
  expect(workspaceResponse.status).toBe(200);
  const workspace = codeUiWorkspaceListSchema
    .parse(workspaceResponse.body)
    .workspaces.find((entry) => entry.projectId === project.id);
  if (!workspace) throw new Error("Design 项目缺少真实工作目录。");
  const source = protocol.conversationSnapshotSchema.parse(
    await provider.snapshot(),
  );
  const sessionResponse = await provider.stream.rpc(
    "sendConversationCommandV4",
    [
      {
        workspacePath: workspace.path,
        projectId: project.id,
        envelope: {
          commandId: randomUUID(),
          clientId: provider.clientId,
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: project.id,
            config: { modelSelection: source.config.modelSelection },
            workContext: { preset: "design", canvasId: canvas.id },
          },
          issuedAt: Date.now(),
        },
      },
    ],
  );
  expect(sessionResponse.status, JSON.stringify(sessionResponse.body)).toBe(
    200,
  );
  const task = protocol.commandAckSchema.parse(sessionResponse.body.result);
  if (task.result?.type !== "createSession")
    throw new Error("Design 创建缺少真实 Task 身份。");
  return { sessionId: task.result.sessionId, canvasId: canvas.id };
}

/** 原V4/实际Task/Harness/PG；仅外部模型HTTP为可控输出。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "实例命令真实输入展开 integration",
  () => {
    it("原转录保留命令文本，模型读取原ZCode位置参数与完整Unicode参数展开", async () => {
      const model = await heldModel();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const saved = await host.client.request(
          "/api/instance/settings",
          {
            commands: [
              {
                name: "quotecheck",
                description: "参数展开",
                prompt: "一：$1\n二：$2\n原始：$ARGUMENTS",
              },
            ],
          },
          "PATCH",
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const text = '/quotecheck "中文 空格" 雪😀';
        const sent = await host.command("sendText", {
          text,
          mode: "build",
          planEnabled: false,
        });
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        const request = modelRequestSchema.parse(model.requests[0]?.body);
        const userMessages = request.messages.filter(
          (entry) => entry.role === "user",
        );
        const input = JSON.stringify(userMessages.at(-1)?.content);
        expect(input).toContain("Run custom command /quotecheck.");
        expect(input).toContain("一：中文 空格");
        expect(input).toContain("二：雪😀");
        expect(input).toContain('原始：\\"中文 空格\\" 雪😀');
        const active = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(active.rows.window).toContainEqual(
          expect.objectContaining({
            kind: "userInput",
            text,
          }),
        );
        model.finish(0);
        await vi.waitFor(
          async () => {
            const ended = protocol.conversationSnapshotSchema.parse(
              await host?.snapshot(),
            );
            expect(ended.control.phase).toBe("completedSuccess");
          },
          { timeout: 30_000 },
        );
      } finally {
        if (host) await host.command("stop", {}).catch(() => {});
        await host?.dispose();
        await fixture?.close();
        await model.close();
      }
    });

    it("Design通过原WS运行消费同一实例命令，无占位符的Unicode参数沿原展开规则", async () => {
      const model = await heldModel();
      let fixture: Fixture | undefined;
      let provider: Host | undefined;
      let socket: WebSocket | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        provider = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const catalog = modelListResponseSchema.parse(
          (await fixture.client.request("/api/models")).body,
        );
        const selected = catalog.models.find((entry) =>
          entry.id.endsWith(":stop-model"),
        );
        if (!selected) throw new Error("真实模型目录缺少夹具模型");
        const saved = await fixture.client.request(
          "/api/instance/settings",
          {
            defaultModel: selected.id,
            commands: [
              { name: "summary", prompt: "概括资料", description: "概括" },
            ],
          },
          "PATCH",
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const { sessionId, canvasId } = await createDesignTask(
          fixture,
          provider,
        );
        const token = (
          await readFile(
            join(fixture.directory, "local-access/desktop-token"),
            "utf8",
          )
        ).trim();
        socket = new WebSocket(
          `${fixture.baseUrl.replace(/^http/, "ws")}/api/ws`,
          {
            headers: {
              origin: fixture.origin,
              authorization: `Bearer ${token}`,
            },
          },
        );
        const errors: string[] = [];
        socket.on("message", (data) => {
          const parsed = wsServerErrorSchema.safeParse(
            JSON.parse(data.toString()),
          );
          if (parsed.success) errors.push(parsed.data.message);
        });
        await new Promise<void>((resolve, reject) => {
          socket?.once("open", resolve);
          socket?.once("error", reject);
        });
        socket.send(
          JSON.stringify({
            type: "command",
            action: "agent.run",
            payload: {
              sessionId,
              conversationId: canvasId,
              canvasId,
              prompt: "/summary Unicode😀",
              preset: "design",
            },
          }),
        );
        await vi.waitFor(
          () =>
            expect(model.requests.length > 0 || errors.length > 0).toBe(true),
          {
            timeout: 30_000,
          },
        );
        expect(errors).toEqual([]);
        expect(model.requests).toHaveLength(1);
        const request = modelRequestSchema.parse(model.requests[0]?.body);
        const input = JSON.stringify(
          request.messages.filter((entry) => entry.role === "user").at(-1)
            ?.content,
        );
        expect(input).toContain("Run custom command /summary.");
        expect(input).toContain("概括资料\\n\\nUser arguments:\\nUnicode😀");
        model.finish(0);
        await vi.waitFor(
          async () => {
            const ended = await fixture?.client.request(
              `/api/code-ui/sessions/${sessionId}`,
            );
            expect(ended?.status).toBe(200);
            expect(
              protocol.conversationSnapshotSchema.parse(ended?.body.snapshot)
                .control.phase,
            ).toBe("completedSuccess");
          },
          { timeout: 30_000 },
        );
      } finally {
        socket?.close();
        await provider?.dispose();
        await fixture?.close();
        await model.close();
      }
    }, 90_000);

    it("原shell预展开明确失败，不执行命令或发模型请求", async () => {
      const model = await heldModel();
      let fixture: Fixture | undefined;
      let host: Host | undefined;
      try {
        fixture = await createCodeUiHttpFixture();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const marker = join(host.workspacePath, "command-shell-must-not-run");
        const saved = await host.client.request(
          "/api/instance/settings",
          {
            commands: [
              {
                name: "noshell",
                description: "未接入shell展开",
                prompt: `!\`touch '${marker}'\``,
              },
            ],
          },
          "PATCH",
        );
        expect(saved.status).toBe(200);
        const sent = await host.command("sendText", {
          text: "/noshell",
          mode: "build",
          planEnabled: false,
        });
        expect(sent.status).toBe(200);
        await vi.waitFor(
          async () => {
            const failed = protocol.conversationSnapshotSchema.parse(
              await host?.snapshot(),
            );
            expect(failed.control.phase).toBe("error");
            expect(failed.control.lastError?.message).toContain(
              "unsupported shell",
            );
          },
          { timeout: 30_000 },
        );
        expect(model.requests).toHaveLength(0);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (host) await host.command("stop", {}).catch(() => {});
        await host?.dispose();
        await fixture?.close();
        await model.close();
      }
    });
  },
);
