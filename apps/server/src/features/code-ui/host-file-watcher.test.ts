import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeUiViewerScope } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import {
  type CodeUiFileWatchers,
  createCodeUiFileWatchers,
} from "./host-file-watcher.js";
import type { CodeUiHostConnection } from "./host-service-rpc.js";

const resources: Array<{ root: string; watchers: CodeUiFileWatchers }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.watchers.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-code-watcher-")),
  );
  const actor: AuthenticatedUser = {
    id: randomUUID(),
    email: "watch@test",
    accessToken: "private",
    userMetadata: {},
  };
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const connection: CodeUiHostConnection = {
    connectionId: randomUUID(),
    workspaceId,
    userId: actor.id,
  };
  const otherConnection = { ...connection, connectionId: randomUUID() };
  const openConnections = new Set([
    connection.connectionId,
    otherConnection.connectionId,
  ]);
  let generation = 1;
  let waitForResolve: Promise<void> | undefined;
  const events: Array<{ connectionId: string; id: string; data: unknown }> = [];
  const watchers = createCodeUiFileWatchers({
    assertConnection: (owner) => {
      if (
        !openConnections.has(owner.connectionId) ||
        owner.workspaceId !== workspaceId
      )
        throw new Error("连接已关闭");
    },
    resolveTarget: async (owner, viewer, path) => {
      await waitForResolve;
      if (
        owner.id !== actor.id ||
        (viewer.kind === "project"
          ? viewer.projectId !== projectId
          : viewer.taskId !== taskId)
      )
        throw new Error("目标不属于当前工作区");
      return {
        workspaceId,
        projectId,
        rootDirectory: root,
        viewerScope: viewer,
        path: await resolveReadOnlyProjectPath(
          { rootDirectory: root, additionalDirectories: [] },
          path,
        ),
        ...(viewer.kind === "task" ? { generation } : {}),
      };
    },
    send: async (owner, id, data) => {
      events.push({ connectionId: owner.connectionId, id, data });
    },
  });
  resources.push({ root, watchers });
  const viewerScope: CodeUiViewerScope = { kind: "task", taskId };
  return {
    root,
    actor,
    workspaceId,
    projectId,
    taskId,
    connection,
    otherConnection,
    openConnections,
    watchers,
    events,
    viewerScope,
    revoke: () => {
      generation++;
    },
    hold: (promise: Promise<void>) => {
      waitForResolve = promise;
    },
  };
}
it("原watch/onDynamicChange/unwatch真实事件按connection与watcher隔离并关闭原生句柄", async () => {
  const f = await fixture();
  const a = (
    await f.watchers.call(
      f.actor,
      "watch",
      [{ path: f.root, viewerScope: f.viewerScope }],
      f.connection,
    )
  )?.result as { id: string };
  const b = (
    await f.watchers.call(
      f.actor,
      "watch",
      [{ path: f.root, viewerScope: f.viewerScope, recursive: true }],
      f.otherConnection,
    )
  )?.result as { id: string };
  await writeFile(join(f.root, "actual.txt"), "真实事件");
  await expect
    .poll(() => new Set(f.events.map((event) => event.id)).size)
    .toBe(2);
  expect(
    f.events.every((event) =>
      event.id === a.id
        ? event.connectionId === f.connection.connectionId
        : event.id === b.id &&
          event.connectionId === f.otherConnection.connectionId,
    ),
  ).toBe(true);
  expect(f.events[0]?.data).toEqual({ dirPath: f.root });
  await expect(
    f.watchers.call(f.actor, "unwatch", [{ id: a.id }], f.otherConnection),
  ).rejects.toThrow(/连接/);
  await f.watchers.call(f.actor, "unwatch", [{ id: a.id }], f.connection);
  await f.watchers.closeConnection(
    f.workspaceId,
    f.otherConnection.connectionId,
  );
  const count = f.events.length;
  await writeFile(join(f.root, "after-close.txt"), "不再监视");
  await f.watchers.close();
  expect(f.events).toHaveLength(count);
});
it("Project只读viewer可监视授权目录，raw path、其它目标与路径逃逸不可签发watcher", async () => {
  const f = await fixture();
  await expect(
    f.watchers.call(f.actor, "watch", [{ path: f.root }], f.connection),
  ).rejects.toThrow();
  await expect(
    f.watchers.call(
      f.actor,
      "watch",
      [
        {
          path: "/private",
          viewerScope: { kind: "project", projectId: f.projectId },
        },
      ],
      f.connection,
    ),
  ).rejects.toThrow();
  await expect(
    f.watchers.call(
      f.actor,
      "watch",
      [{ path: f.root, viewerScope: { kind: "task", taskId: randomUUID() } }],
      f.connection,
    ),
  ).rejects.toThrow(/工作区/);
  expect(
    await f.watchers.call(
      f.actor,
      "watch",
      [
        {
          path: f.root,
          viewerScope: { kind: "project", projectId: f.projectId },
        },
      ],
      f.connection,
    ),
  ).toMatchObject({ result: { id: expect.any(String) } });
  await f.watchers.call(f.actor, "disposeAll", [], f.connection);
});
it("Task关闭与连接关闭取消pending启动，迟到resolver不得建立监视句柄", async () => {
  for (const closeConnection of [false, true]) {
    const f = await fixture();
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const opening = f.watchers.call(
      f.actor,
      "watch",
      [{ path: f.root, viewerScope: f.viewerScope }],
      f.connection,
    );
    const rejected = expect(opening).rejects.toThrow(/关闭/);
    if (closeConnection) {
      f.openConnections.delete(f.connection.connectionId);
      await f.watchers.closeConnection(
        f.workspaceId,
        f.connection.connectionId,
      );
    } else await f.watchers.closeTask(f.workspaceId, f.taskId);
    release();
    await rejected;
    await writeFile(join(f.root, "late.txt"), "不能创建迟到watcher");
    expect(f.events).toEqual([]);
  }
});
it("授权代际变化后真实文件事件不再向旧watcher发送", async () => {
  const f = await fixture();
  await f.watchers.call(
    f.actor,
    "watch",
    [{ path: f.root, viewerScope: f.viewerScope }],
    f.connection,
  );
  f.revoke();
  await writeFile(join(f.root, "revoked.txt"), "授权已撤回");
  await f.watchers.closeTask(f.workspaceId, f.taskId);
  expect(f.events).toEqual([]);
});
