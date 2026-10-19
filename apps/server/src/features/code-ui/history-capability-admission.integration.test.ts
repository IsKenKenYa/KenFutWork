import { randomUUID } from "node:crypto";
import {
  type ExecutionMode,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCodeUiRepository } from "./repository.js";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Guard = { baseRevision: number; baseLogEpoch: string };
const INPUT = "按当前可用能力重新处理相同输入";
const toolNames = (body: Record<string, unknown>) =>
  z
    .object({
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
    })
    .parse(body)
    .tools.map((tool) => tool.function.name);

function historyCommand(
  host: Host,
  type: "editUserQuery" | "retryTurn",
  payload: unknown,
  commandId: string,
  guard: Guard,
  executionMode: ExecutionMode | undefined,
) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      ...(executionMode ? { executionMode } : {}),
      envelope: {
        type,
        sessionId: host.sessionId,
        commandId,
        clientId: host.clientId,
        payload,
        ...guard,
        issuedAt: Date.now(),
      },
    },
  ]);
}

async function lastInput(fixture: Fixture, host: Host) {
  const root = await createCodeUiRepository(fixture.database.persistence).find(
    fixture.actor.instanceId,
    host.sessionId,
  );
  const input = root?.state?.inputs?.at(-1);
  if (!root || !input) throw new Error("真实Task缺少持久输入");
  return { root, input };
}

async function completeOriginal(fixture: Fixture, host: Host, model: Model) {
  expect(
    (await host.command("sendText", { text: INPUT })).body.result,
  ).toMatchObject({ status: "accepted" });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  const request = model.requests[0];
  if (!request) throw new Error("首Run未到达实际模型");
  expect(toolNames(request.body)).toContain("history_original_capability");
  model.finish(0);
  const snapshot = await waitPhase(fixture, host.sessionId, "completedSuccess");
  const { input: original } = await lastInput(fixture, host);
  const originalCapabilities = structuredClone(original.frozenContributions);
  expect(original.executionMode).toBe("agent");
  expect(originalCapabilities?.entries).toContainEqual(
    expect.objectContaining({ id: "history_original_capability" }),
  );
  return { snapshot, original, originalCapabilities };
}

async function expectCurrentModelRequest(model: Model) {
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  const request = model.requests[1];
  if (!request) throw new Error("历史重跑未到达实际模型");
  expect(JSON.stringify(request.body.messages)).toContain(INPUT);
  expect(toolNames(request.body)).toContain("history_current_capability");
  expect(toolNames(request.body)).not.toContain("history_original_capability");
  expect(toolNames(request.body)).not.toContain(
    "history_after_admission_capability",
  );
}

async function expectReplay(
  host: Host,
  type: "editUserQuery" | "retryTurn",
  payload: unknown,
  commandId: string,
  guard: Guard,
  requested: ExecutionMode | undefined,
) {
  const repeated = await historyCommand(
    host,
    type,
    payload,
    commandId,
    guard,
    requested,
  );
  expect(repeated.body.result).toMatchObject({ status: "duplicate" });
  if (type !== "editUserQuery") return;
  const conflict = await historyCommand(
    host,
    type,
    payload,
    commandId,
    guard,
    requested === "agent" ? "solo" : "agent",
  );
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
}

// 真实HTTP/SSE、原V4历史命令、独占PG和Harness；只控制外部模型流。
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "历史重跑逐Run能力接纳 integration",
  () => {
    it.each([
      { type: "editUserQuery", requested: undefined, expected: "solo" },
      { type: "editUserQuery", requested: "agent", expected: "agent" },
      { type: "retryTurn", requested: "solo", expected: "agent" },
    ] as const)(
      "$type显式方式$requested：新Run捕获当前能力与代际，工作方式为$expected，重放不再执行",
      async ({ type, requested, expected }) => {
        const fixture = await createCodeUiHttpFixture();
        const model = await heldModel();
        const registry = fixture.app.kernel.get("tools");
        const register = (name: string) =>
          registry.register({
            name,
            scope: "code",
            access: "read",
            description: "历史重跑能力接纳探针",
            parameters: { type: "object", properties: {} },
            execute: async () => "无需执行探针",
          });
        const removeOriginal = register("history_original_capability");
        let removeCurrent: (() => void) | undefined;
        let removeLate: (() => void) | undefined;
        let host: Host | undefined;
        try {
          host = await createCodeSessionFixture(model.baseUrl, {
            client: fixture.client,
          });
          const { original, originalCapabilities } = await completeOriginal(
            fixture,
            host,
            model,
          );
          removeOriginal();
          removeCurrent = register("history_current_capability");
          expect(
            (
              await host.client.request(
                `/api/execution-modes/${host.sessionId}`,
                { mode: "solo" },
                "PUT",
              )
            ).status,
          ).toBe(200);
          const snapshot = protocol.conversationSnapshotSchema.parse(
            await host.snapshot(),
          );
          const currentCapabilities = registry.captureContributions("code");
          const target = snapshot.rows.window.find(
            (row) =>
              row.kind ===
              (type === "editUserQuery" ? "userInput" : "assistantText"),
          );
          if (!target) throw new Error("历史命令缺少原输入或回复边界");
          const payload = {
            target: { rowId: target.rowId, entityId: target.entityId },
            workspaceMode: "preserve",
            ...(type === "editUserQuery" ? { newText: INPUT } : {}),
          };
          const guard = {
            baseRevision: snapshot.revision,
            baseLogEpoch: snapshot.logEpoch,
          };
          const commandId = randomUUID();
          const edited = await historyCommand(
            host,
            type,
            payload,
            commandId,
            guard,
            requested,
          );
          expect(edited.status, JSON.stringify(edited.body)).toBe(200);
          expect(edited.body.result).toMatchObject({ status: "accepted" });
          const { root, input: rerun } = await lastInput(fixture, host);
          expect(rerun.runId).not.toBe(original.runId);
          expect(rerun.executionMode).toBe(expected);
          expect(rerun.frozenContributions).toEqual(currentCapabilities);
          expect(rerun.frozenContributions).not.toEqual(originalCapabilities);
          expect(rerun.scopeGeneration).toBe(Number(root.scope_generation));
          expect(rerun.branchGeneration).toBe(Number(root.branch_generation));
          expect(rerun.scopeGeneration).toBeGreaterThan(
            original.scopeGeneration,
          );
          expect(rerun.branchGeneration).toBeGreaterThan(
            original.branchGeneration,
          );
          removeLate = register("history_after_admission_capability");
          await expectCurrentModelRequest(model);
          expect(original.frozenContributions).toEqual(originalCapabilities);
          await expectReplay(host, type, payload, commandId, guard, requested);
          expect(model.requests).toHaveLength(2);
          model.finish(1);
          await waitPhase(fixture, host.sessionId, "completedSuccess");
        } finally {
          if (host) {
            const snapshot = protocol.conversationSnapshotSchema.parse(
              await host.snapshot(),
            );
            if (snapshot.control.canStop) await host.command("stop", {});
            await host.dispose();
          }
          removeOriginal();
          removeCurrent?.();
          removeLate?.();
          await model.close();
          await fixture.close();
        }
      },
      90_000,
    );
  },
);
