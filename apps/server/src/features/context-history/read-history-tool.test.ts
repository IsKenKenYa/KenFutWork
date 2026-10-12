import { AGENT_GOVERNANCE_LIMITS } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { archiveKernelFixture, archiveTaskFixture } from "./test-fixture.js";

it("registry exposes a real readonly shared Consumer and validates pagination", async () => {
  const fixture = await archiveTaskFixture();
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
        limit: AGENT_GOVERNANCE_LIMITS.codeReadPageCharacters.max,
      }).success,
    ).toBe(true);
    expect(
      tool.zodSchema?.safeParse({
        uri: "owned:archive",
        limit: AGENT_GOVERNANCE_LIMITS.codeReadPageCharacters.max + 1,
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
        { uri: "owned:archive", limit: 16_001 },
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
