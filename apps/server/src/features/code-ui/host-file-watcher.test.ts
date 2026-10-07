import { randomUUID } from "node:crypto";
import type { PathLike, WatchOptionsWithStringEncoding } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeUiViewerScope } from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  type CodeUiFileWatchers,
  createCodeUiFileWatchers,
} from "./host-file-watcher.js";
import type { CodeUiHostConnection } from "./host-service-rpc.js";

const { nativeWatches } = vi.hoisted(() => ({
  nativeWatches: [] as { changes: number; errors: string[]; closed: boolean }[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    // 保留真正的OS监听，只观察原生事件与close，区分投递延迟和被静默关闭。
    watch(path: PathLike, options: WatchOptionsWithStringEncoding) {
      const watcher = fs.watch(path, options);
      const state = { changes: 0, errors: [] as string[], closed: false };
      nativeWatches.push(state);
      watcher.on("change", () => {
        state.changes += 1;
      });
      watcher.on("error", (error) => {
        state.errors.push(error.message);
      });
      watcher.once("close", () => {
        state.closed = true;
      });
      return watcher;
    },
  };
});

const resources: Array<{ root: string; watchers: CodeUiFileWatchers }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.watchers.close();
    await rm(resource.root, { recursive: true, force: true });
  }
  nativeWatches.splice(0);
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-code-watcher-")),
  );
  const instanceId = randomUUID();
  const actor: LocalActor = { instanceId, accessClientId: null };
  const projectId = randomUUID();
  const taskId = randomUUID();
  const connection: CodeUiHostConnection = {
    connectionId: randomUUID(),
    instanceId,
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
        owner.instanceId !== instanceId
      )
        throw new Error("连接已关闭");
    },
    resolveTarget: async (owner, viewer, path) => {
      await waitForResolve;
      if (
        owner.instanceId !== actor.instanceId ||
        (viewer.kind === "project"
          ? viewer.projectId !== projectId
          : viewer.taskId !== taskId)
      )
        throw new Error("目标不属于当前工作区");
      return {
        instanceId,
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
    instanceId,
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
  let change = 0;
  // fs.watch没有OS ready回执；持续发起真实变化，避免假设Darwin首个事件必然投递。
  // 每个通知仍必须来自原生watcher，隔离、权限重验及句柄关闭断言不放宽。
  await expect
    .poll(
      async () => {
        await writeFile(join(f.root, `actual-${change++}.txt`), "真实事件");
        return {
          delivered: [...new Set(f.events.map((event) => event.id))].sort(),
          nativeChanged: nativeWatches.map((state) => state.changes > 0),
          nativeErrors: nativeWatches.map((state) => state.errors),
          nativeClosed: nativeWatches.map((state) => state.closed),
        };
      },
      { timeout: 5_000 },
    )
    .toEqual({
      delivered: [a.id, b.id].sort(),
      nativeChanged: [true, true],
      nativeErrors: [[], []],
      nativeClosed: [false, false],
    });
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
    f.instanceId,
    f.otherConnection.connectionId,
  );
  expect(nativeWatches.map((state) => state.closed)).toEqual([true, true]);
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
      await f.watchers.closeConnection(f.instanceId, f.connection.connectionId);
    } else await f.watchers.closeTask(f.instanceId, f.taskId);
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
  await f.watchers.closeTask(f.instanceId, f.taskId);
  expect(f.events).toEqual([]);
});
