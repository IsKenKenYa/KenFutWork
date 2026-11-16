// @vitest-environment node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { throwPublicHttpError } from "@kenfutwork/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../../server/src/features/local-instance/types.js";
import type { PersistenceService } from "../../server/src/features/persistence/types.js";
import type { InspectionCall } from "../src/components/workbench/zcode/host/contextInspectionReader.js";
import { useContextInspection } from "../src/components/workbench/zcode/host/useContextInspection.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import type { PublicFixture } from "./setup/code-public-session.js";

const unavailableMessage = "请求记录已不可用，请重新选择任务。";
type HttpFixture = PublicFixture & {
  cookie: string;
  origin: string;
  actor: LocalActor;
  app: {
    kernel: {
      get(key: "persistence"): PersistenceService;
      get(key: "localInstance"): LocalInstanceService;
    };
  };
};
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function recordRequest(fixture: HttpFixture, host: Host) {
  const { createContextInspectionService } = await import(
    "../../server/src/features/context-insights/service.js"
  );
  const context = createContextInspectionService({
    persistence: fixture.app.kernel.get("persistence"),
    localInstance: fixture.app.kernel.get("localInstance"),
    readPageCharacters: async () => 128,
  });
  const { instanceId } = await fixture.app.kernel
    .get("localInstance")
    .resolve(fixture.actor);
  const requestId = randomUUID();
  await context.writer.start({
    id: requestId,
    owner: { instanceId, taskId: host.sessionId, runId: randomUUID() },
    startedAt: new Date().toISOString(),
    input: {
      model: "local",
      tools: [],
      messages: [[{ type: "human", data: { content: "真实请求内容" } }]],
    },
  });
  return requestId;
}

async function readRpc(
  fixture: HttpFixture,
  host: Host,
  method: string,
  args?: unknown[],
) {
  const response = await fetch(`${fixture.baseUrl}/api/code-ui/rpc`, {
    method: "POST",
    headers: {
      origin: fixture.origin,
      cookie: fixture.cookie,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({
      connectionId: host.stream.ready.hello.connectionId,
      service: "context-insights",
      method,
      args,
    }),
  });
  if (!response.ok) return throwPublicHttpError(response);
  return (await response.json()).result;
}

async function removeTask(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "deleteTask",
    args: [
      {
        taskId: host.sessionId,
        projectId: host.projectId,
        workspacePath: host.workspacePath,
        workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function createInspectionFixture(holdReads: boolean) {
  const http: {
    createCodeUiHttpFixture(): Promise<HttpFixture>;
  } = await import(fixturePath);
  const { createCodeSessionFixture } = await import(
    "../../server/src/features/code-ui/host-session.fixture.js"
  );
  const { heldModel } = await import(
    "../../server/src/features/code-ui/model-stream.fixture.js"
  );
  const cleanups: Array<() => void | Promise<void>> = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "上下文报错验证清理失败");
  };
  try {
    const fixture = await http.createCodeUiHttpFixture();
    cleanups.push(() => fixture.close());
    const model = await heldModel();
    cleanups.push(() => model.close());
    const host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
    });
    cleanups.push(() => host.dispose());
    const requestId = await recordRequest(fixture, host);
    let releaseRead!: () => void;
    let onRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      onRead = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const call: InspectionCall = async (method, args) => {
      if (method === "read" && holdReads) {
        onRead();
        await allowed;
      }
      return readRpc(fixture, host, method, args);
    };
    const releaseDom = await installCodePublicHostDom();
    cleanups.push(releaseDom, releaseRead);
    return {
      host,
      model,
      requestId,
      call,
      reading,
      releaseRead,
      removeTask: () => removeTask(host),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "上下文报错验证准备失败");
    }
    throw error;
  }
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "不存在及删除后的任务显示公开处理建议，重新选择后可读取",
  async () => {
    const fixture = await createInspectionFixture(false);
    const initialProps: { task: string } = { task: randomUUID() };
    const hook = renderHook(
      ({ task }: { task: string }) => useContextInspection(fixture.call, task),
      {
        initialProps,
      },
    );
    try {
      await waitFor(() =>
        expect(hook.result.current.error).toBe(unavailableMessage),
      );
      expect(hook.result.current.requests).toEqual([]);
      hook.rerender({ task: fixture.host.sessionId });
      await waitFor(() =>
        expect(
          hook.result.current.content?.input.messages.flat()[0]?.data.content,
        ).toBe("真实请求内容"),
      );
      expect(hook.result.current.error).toBeNull();
      await fixture.removeTask();
      await act(async () => hook.result.current.refresh());
      expect(hook.result.current.error).toBe(unavailableMessage);
      expect(hook.result.current.requests).toEqual([]);
      expect(hook.result.current.content).toBeNull();
      expect(fixture.model.requests).toHaveLength(0);
    } finally {
      hook.unmount();
      await fixture.close();
    }
  },
  60_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "正文开始读取后删除任务，读取提示保留服务端公开原因",
  async () => {
    const fixture = await createInspectionFixture(true);
    const hook = renderHook(() =>
      useContextInspection(fixture.call, fixture.host.sessionId),
    );
    try {
      await fixture.reading;
      expect(hook.result.current.selected?.id).toBe(fixture.requestId);
      await fixture.removeTask();
      await act(async () => fixture.releaseRead());
      await waitFor(() =>
        expect(hook.result.current.error).toBe(unavailableMessage),
      );
      expect(hook.result.current.reading).toBe(false);
      expect(hook.result.current.content).toBeNull();
      expect(fixture.model.requests).toHaveLength(0);
    } finally {
      hook.unmount();
      await fixture.close();
    }
  },
  60_000,
);
