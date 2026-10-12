import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { createContextHistoryArchiveBindings } from "./service.js";
import { archiveTaskFixture } from "./test-fixture.js";

const page = {
  text: "owned original evidence",
  nextOffset: null,
  totalCodeUnits: 23,
};
it("requires actual Task, actor and private native thread binding", () => {
  const service = createContextHistoryArchiveBindings();
  expect(() => service.bind({}, async () => page)).toThrow("真实Task");
});

it.each(["code", "design"] as const)(
  "%s Task readonly history checks active branch before and after IO",
  async (preset) => {
    const fixture = await archiveTaskFixture(preset);
    try {
      const service = createContextHistoryArchiveBindings();
      const read = vi.fn(async () => page);
      service.bind(fixture.execution, read);
      expect(
        await service.read({ uri: "owned:checkpoint" }, fixture.execution),
      ).toEqual(page);
      await expect(
        service.read(
          { uri: "owned:checkpoint" },
          { ...fixture.execution, threadId: "foreign" },
        ),
      ).rejects.toThrow("没有可读取");
      const forged = await fixture.scopes.openTask(
        fixture.actor,
        fixture.identity.taskId,
      );
      await expect(
        service.read(
          { uri: "owned:checkpoint" },
          { ...fixture.execution, scopeHandle: forged },
        ),
      ).rejects.toThrow("没有可读取");
      fixture.staleBranch();
      await expect(
        service.read({ uri: "owned:checkpoint" }, fixture.execution),
      ).rejects.toThrow("分支");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  },
);

it("branch revocation during archive IO blocks publication", async () => {
  const fixture = await archiveTaskFixture();
  try {
    const service = createContextHistoryArchiveBindings();
    service.bind(fixture.execution, async () => {
      fixture.staleBranch();
      return page;
    });
    await expect(
      service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).rejects.toThrow("分支");
  } finally {
    await fixture.cleanup();
  }
});

it("uses the opened scope page budget and adopts settings changes only in a new scope", async () => {
  const fixture = await archiveTaskFixture("code", 128);
  try {
    const service = createContextHistoryArchiveBindings();
    const read = vi.fn(async (input) => ({
      ...page,
      text: String(input.limit),
    }));
    service.bind(fixture.execution, read);

    expect(
      await service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).toMatchObject({ text: "128" });
    await expect(
      service.read({ uri: "owned:checkpoint", limit: 129 }, fixture.execution),
    ).rejects.toThrow("实例设置上限（128）");
    expect(read).toHaveBeenCalledTimes(1);

    fixture.setPageBudget(256);
    await expect(
      service.read({ uri: "owned:checkpoint", limit: 200 }, fixture.execution),
    ).rejects.toThrow("128");
    expect(read).toHaveBeenCalledTimes(1);
    const nextHandle = await fixture.scopes.openTask(
      fixture.actor,
      fixture.identity.taskId,
    );
    const nextExecution = {
      ...fixture.execution,
      scopeHandle: nextHandle,
      runId: "next-run",
    };
    service.bind(nextExecution, read);
    expect(
      await service.read(
        { uri: "owned:checkpoint", limit: 200 },
        nextExecution,
      ),
    ).toMatchObject({ text: "200" });
    expect(
      await service.read({ uri: "owned:checkpoint" }, nextExecution),
    ).toMatchObject({ text: "256" });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    await fixture.cleanup();
  }
});

it("uses the resolved scope default without a second settings resolver", async () => {
  const fixture = await archiveTaskFixture();
  try {
    const service = createContextHistoryArchiveBindings();
    const read = vi.fn(async (input) => ({
      ...page,
      text: String(input.limit),
    }));
    service.bind(fixture.execution, read);
    expect(
      await service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).toMatchObject({
      text: String(AGENT_GOVERNANCE_DEFAULTS.codeReadPageCharacters),
    });
  } finally {
    await fixture.cleanup();
  }
});

it("release closes late calls; an old disposer cannot delete a replacement provider", async () => {
  const fixture = await archiveTaskFixture();
  try {
    const service = createContextHistoryArchiveBindings();
    const oldRelease = service.bind(fixture.execution, async () => ({
      ...page,
      text: "old",
    }));
    const release = service.bind(fixture.execution, async () => page);
    oldRelease();
    expect(
      await service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).toEqual(page);
    release();
    release();
    await expect(
      service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).rejects.toThrow("没有可读取");
    const next = { ...fixture.execution, runId: "new-run" };
    service.bind(next, async () => page);
    expect(await service.read({ uri: "owned:checkpoint" }, next)).toEqual(page);
    await expect(
      service.read({ uri: "owned:checkpoint" }, fixture.execution),
    ).rejects.toThrow("没有可读取");
  } finally {
    await fixture.cleanup();
  }
});
