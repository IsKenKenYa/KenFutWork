import { expect, it } from "vitest";
import { archiveKernelFixture, archiveTaskFixture } from "./test-fixture.js";

it("registry exposes a real readonly shared Consumer and validates pagination", async () => {
  const fixture = await archiveTaskFixture("code", 8000);
  const kernel = archiveKernelFixture();
  try {
    const tools = kernel.get("tools");
    expect(
      tools.resolveRunTools({
        preset: "code",
        backendFactory: () => fixture.handle.backend,
      }),
    ).toEqual([]);
    const definitions = tools.resolveRunTools({
      preset: "code",
      scopeHandle: fixture.handle,
      backendFactory: () => fixture.handle.backend,
    });
    const tool = definitions.find((entry) => entry.name === "ReadHistory");
    if (!tool) throw new Error("real Consumer missing");
    expect(tool.access).toBe("read");
    expect(
      tool.zodSchema?.safeParse({
        uri: "owned:archive",
        limit: 8000,
      }).success,
    ).toBe(true);
    expect(
      tool.zodSchema?.safeParse({
        uri: "owned:archive",
        limit: 8001,
      }).success,
    ).toBe(false);
    kernel
      .get("contextHistoryArchives")
      .bind(fixture.execution, async (input) => ({
        text: `${input.uri}:${input.offset}:${input.limit}`,
        nextOffset: 8,
        totalCodeUnits: 40,
      }));
    const result = await tools.executeDefinition(
      tool,
      { uri: "owned:archive", offset: 3, limit: 5 },
      fixture.execution,
    );
    expect(result).toEqual({
      uri: "owned:archive",
      text: "owned:archive:3:5",
      nextOffset: 8,
      totalCodeUnits: 40,
    });
    await expect(
      tools.executeDefinition(
        tool,
        { uri: "owned:archive", limit: 8001 },
        fixture.execution,
      ),
    ).rejects.toThrow();
    await expect(
      tools.executeDefinition(
        tool,
        { uri: "owned:archive", path: "/private/foreign" },
        fixture.execution,
      ),
    ).rejects.toThrow();
    await expect(
      tools.executeDefinition(tool, { uri: "owned:archive" }, {}),
    ).rejects.toThrow("真实Task");
  } finally {
    kernel.dispose();
    await fixture.cleanup();
  }
});

it("schema and execution share the opened scope budget while later scopes see new settings", async () => {
  const fixture = await archiveTaskFixture("code", 8000);
  const kernel = archiveKernelFixture();
  try {
    const resolve = (handle: typeof fixture.handle) => {
      const definition = kernel
        .get("tools")
        .resolveRunTools({
          preset: "code",
          scopeHandle: handle,
          backendFactory: () => handle.backend,
        })
        .find((entry) => entry.name === "ReadHistory");
      if (!definition) throw new Error("real Consumer missing");
      return definition;
    };
    const tool = resolve(fixture.handle);
    expect(tool.parameters).toMatchObject({
      properties: { limit: { maximum: 8000 } },
    });
    const archives = kernel.get("contextHistoryArchives");
    archives.bind(fixture.execution, async (input) => ({
      text: String(input.limit),
      nextOffset: null,
      totalCodeUnits: 8000,
    }));
    fixture.setPageBudget(4000);
    expect(
      await kernel
        .get("tools")
        .executeDefinition(
          tool,
          { uri: "owned:archive", limit: 8000 },
          fixture.execution,
        ),
    ).toMatchObject({ text: "8000" });
    const nextHandle = await fixture.scopes.openTask(
      fixture.actor,
      fixture.identity.taskId,
    );
    const nextTool = resolve(nextHandle);
    expect(nextTool.parameters).toMatchObject({
      properties: { limit: { maximum: 4000 } },
    });
    expect(
      nextTool.zodSchema?.safeParse({ uri: "owned:archive", limit: 4001 })
        .success,
    ).toBe(false);
  } finally {
    kernel.dispose();
    await fixture.cleanup();
  }
});

it.each([
  undefined,
  Number.NaN,
  127,
  8000.5,
  AGENT_GOVERNANCE_LIMITS.codeReadPageCharacters.max + 1,
])(
  "invalid scope budget %s fails before exposing or executing an archive tool",
  async (budget) => {
    const fixture = await archiveTaskFixture();
    const kernel = archiveKernelFixture();
    try {
      Object.defineProperty(fixture.handle.backend, "limits", {
        value: {
          ...fixture.handle.backend.limits,
          codeReadPageCharacters: budget,
        },
      });
      expect(() =>
        kernel.get("tools").resolveRunTools({
          preset: "code",
          scopeHandle: fixture.handle,
          backendFactory: () => fixture.handle.backend,
        }),
      ).toThrow("预算");
      const archives = kernel.get("contextHistoryArchives");
      archives.bind(fixture.execution, async () => ({
        text: "should not read",
        nextOffset: null,
        totalCodeUnits: 0,
      }));
      await expect(
        archives.read({ uri: "owned:archive" }, fixture.execution),
      ).rejects.toThrow("预算");
    } finally {
      kernel.dispose();
      await fixture.cleanup();
    }
  },
);

import { AGENT_GOVERNANCE_LIMITS } from "@kenfutwork/shared";
