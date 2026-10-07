import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import type { StoredExecutionScope } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";
import { acquireTaskFileRestoreBarrier } from "./scoped-filesystem.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "file-restore-barrier-")),
  );
  directories.push(root);
  const actor = {
    instanceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    accessClientId: null,
  };
  const initial: CodeExecutionScope = {
    instanceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
    taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
    generation: 0,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  let current: StoredExecutionScope = {
    scope: initial,
    state: "ready",
    branchGeneration: 1,
  };
  const other = { ...initial, taskId: "951bd6ce-d728-4b7e-9035-4c0f1a315071" };
  const entered = deferred();
  const released = deferred();
  let blockOther = false;
  const scopes = createExecutionScopes({
    repository: {
      load: async (_instanceId, taskId) => {
        if (taskId === other.taskId && blockOther) {
          entered.resolve();
          await released.promise;
        }
        return taskId === initial.taskId
          ? current
          : { scope: other, state: "ready", branchGeneration: 1 };
      },
    },
    localInstance: {
      resolve: async () => ({ instanceId: initial.instanceId, dataDir: root }),
    },
  });
  return {
    root,
    owner: await scopes.openTask(actor, initial.taskId),
    other: await scopes.openTask(actor, other.taskId),
    async restoring() {
      current = {
        scope: { ...current.scope, generation: current.scope.generation + 1 },
        state: "revoking",
        branchGeneration: current.branchGeneration + 1,
      };
      return scopes.openRestoringTask(
        actor,
        initial.taskId,
        current.scope.generation,
      );
    },
    blockOther() {
      blockOther = true;
      return entered.promise;
    },
    releaseOther() {
      blockOther = false;
      released.resolve();
    },
  };
}

it("FS恢复lease覆盖batch到postSnapshot；普通写拒绝、只读继续、private恢复scope不扩原授权", async () => {
  const { root, owner, other, restoring } = await fixture();
  const path = join(root, "note.txt");
  await writeFile(path, "before");
  const observed = await owner.backend.observeBinary(path);
  await owner.backend.readPage({ path });
  const lease = await acquireTaskFileRestoreBarrier(owner, [root]);
  try {
    await expect(
      owner.backend.writeFile({ path, content: "ordinary" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      owner.backend.editFile({
        path,
        oldString: "before",
        newString: "ordinary",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      other.backend.applyPatch({
        patchText:
          "*** Begin Patch\n*** Add File: new.txt\n+ordinary\n*** End Patch",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await other.backend.readPage({ path })).content).toBe("before");
    const restored = await owner.backend.commitBatch(
      [
        {
          path,
          expectedVersion: observed.version,
          bytes: Buffer.from("after"),
        },
      ],
      async () => lease.authorize(await restoring()),
    );
    expect(restored.complete).toBe(true);
    expect((await other.backend.readPage({ path })).content).toBe("after");
    await expect(
      other.backend.writeFile({
        path: join(root, "post-snapshot.txt"),
        content: "late",
        createOnly: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  } finally {
    await lease.release();
    await lease.release();
  }
  expect(
    await other.backend.writeFile({
      path: join(root, "released.txt"),
      content: "allowed",
      createOnly: true,
    }),
  ).toMatchObject({ type: "create" });
});

it("其它Task已有真实写操作时拒绝恢复lease而不取消对方，完成后可以重新获取", async () => {
  const fixtureState = await fixture();
  const entered = fixtureState.blockOther();
  const pending = fixtureState.other.backend.writeFile({
    path: join(fixtureState.root, "other-write.txt"),
    content: "still running",
    createOnly: true,
  });
  await entered;
  try {
    await expect(
      acquireTaskFileRestoreBarrier(fixtureState.owner, [fixtureState.root]),
    ).rejects.toMatchObject({ statusCode: 409 });
  } finally {
    fixtureState.releaseOther();
    await pending;
  }
  expect(await pending).toMatchObject({
    type: "create",
    content: "still running",
  });
  const lease = await acquireTaskFileRestoreBarrier(fixtureState.owner, [
    fixtureState.root,
  ]);
  await lease.release();
});
