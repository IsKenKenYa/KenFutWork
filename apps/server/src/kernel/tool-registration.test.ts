import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeFileTools } from "../features/code-tools/tool-definitions.js";
import {
  archiveKernelFixture,
  archiveTaskFixture,
} from "../features/context-history/test-fixture.js";
import { AgentRunEventBus, ToolRegistryImpl } from "./context.js";
import type { ToolDefinition, ToolExecutionObservation } from "./types.js";

it("actual Registry execution emits trusted observations and strips the callback from the tool", async () => {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  const schema = z.object({ value: z.string().trim() }).strict();
  const observations: ToolExecutionObservation[] = [];
  let observerReachedTool = false;
  const tool: ToolDefinition = {
    name: "ObserveValue",
    scope: "code",
    access: "read",
    description: "observe registered execution",
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    async execute(args, execution) {
      observerReachedTool = "observeToolExecution" in execution;
      return args.value;
    },
  };
  const unregister = registry.register(tool);
  try {
    expect(
      await registry.executeDefinition(
        tool,
        { value: "  trusted  " },
        {
          runId: "run-1",
          toolCallId: "call-1",
          observeToolExecution: async (fact) => {
            observations.push(fact);
          },
        },
      ),
    ).toBe("trusted");
    expect(observations.map((fact) => fact.phase)).toEqual([
      "started",
      "completed",
    ]);
    expect(observations[0]).toMatchObject({
      runId: "run-1",
      toolCallId: "call-1",
      definition: tool,
      args: { value: "trusted" },
    });
    expect(observations[1]?.output).toBe("trusted");
    expect(observerReachedTool).toBe(false);
  } finally {
    unregister();
  }
});

it.each(["unload", "replace"] as const)(
  "actual static registration %s during pending approval prevents old and replacement side effects",
  async (change) => {
    const task = await archiveTaskFixture();
    const kernel = archiveKernelFixture();
    const registry = kernel.get("tools");
    const permissions = kernel.get("permissions");
    const claim = vi.spyOn(permissions, "claim");
    const tool = createCodeFileTools({
      backend: task.handle.backend,
      modelCapabilities: { image: false, pdf: false },
    }).find((entry) => entry.name === "Write");
    if (!tool) throw new Error("Real Write missing");
    const unregister = registry.register(tool);
    const write = vi.spyOn(task.handle.backend, "writeFile");
    let replacementCalls = 0;
    let disposeReplacement = () => {};
    try {
      const result = registry.executeDefinition(
        tool,
        { file_path: "revoked.txt", content: "must not write" },
        task.execution,
      );
      await vi.waitFor(() =>
        expect(
          permissions.listPending(task.actor.instanceId, task.identity.taskId),
        ).toHaveLength(1),
      );
      const pending = permissions.listPending(
        task.actor.instanceId,
        task.identity.taskId,
      )[0];
      if (!pending) throw new Error("Actual approval missing");
      unregister();
      if (change === "replace")
        disposeReplacement = registry.register({
          ...tool,
          execute: async () => {
            replacementCalls++;
            return "replacement";
          },
        });
      await permissions.resolve({
        interactionId: pending.interaction.interactionId,
        binding: pending.identity,
        answer: { optionId: "allowOnce" },
      });
      await expect(result).rejects.toThrow(/注册|schema/);
      expect(claim).not.toHaveBeenCalled();
      if (change === "replace") {
        const replacement = registry.get("Write");
        if (!replacement) throw new Error("New registration disappeared");
        await expect(
          registry.executeDefinition(
            replacement,
            { file_path: "revoked.txt", content: "must not write" },
            task.execution,
          ),
        ).rejects.toThrow();
        expect(
          permissions.listPending(task.actor.instanceId, task.identity.taskId),
        ).toEqual([]);
      }
      expect(write).not.toHaveBeenCalled();
      expect(replacementCalls).toBe(0);
      await expect(
        access(join(task.identity.rootDirectory, "revoked.txt")),
      ).rejects.toThrow();
      unregister();
      if (change === "replace") expect(registry.get("Write")).toBeTruthy();
    } finally {
      disposeReplacement();
      await kernel.dispose();
      await task.cleanup();
    }
  },
);

it.each(["unload", "replace", "schema"] as const)(
  "actual dynamic registration %s during approval rejects without object identity assumptions or replay",
  async (change) => {
    const task = await archiveTaskFixture();
    const kernel = archiveKernelFixture();
    const registry = kernel.get("tools");
    const permissions = kernel.get("permissions");
    const claim = vi.spyOn(permissions, "claim");
    let version = "original";
    let effects = 0;
    const makeEntry = () => ({
      id: "dynamic-write",
      scope: "code" as const,
      resolve: () => {
        const schema = z.object({ version: z.literal(version) }).strict();
        return {
          name: "DynamicWrite",
          scope: "code" as const,
          access: "write" as const,
          description: "registered dynamic side effect",
          parameters: z.toJSONSchema(schema),
          zodSchema: schema,
          execute: async () => {
            effects++;
            return version;
          },
        };
      },
    });
    const unregister = registry.registerDynamic(makeEntry());
    let replacement = () => {};
    try {
      const resolution = {
        preset: "code" as const,
        scopeHandle: task.handle,
        backendFactory: () => task.handle.backend,
      };
      const tool = registry
        .resolveRunTools(resolution)
        .find((entry) => entry.name === "DynamicWrite");
      if (!tool) throw new Error("Actual dynamic definition missing");
      const result = registry.executeDefinition(
        tool,
        { version: "original" },
        task.execution,
      );
      await vi.waitFor(() =>
        expect(
          permissions.listPending(task.actor.instanceId, task.identity.taskId),
        ).toHaveLength(1),
      );
      const pending = permissions.listPending(
        task.actor.instanceId,
        task.identity.taskId,
      )[0];
      if (!pending) throw new Error("Actual approval missing");
      if (change === "schema") version = "changed";
      else {
        unregister();
        if (change === "replace")
          replacement = registry.registerDynamic(makeEntry());
      }
      await permissions.resolve({
        interactionId: pending.interaction.interactionId,
        binding: pending.identity,
        answer: { optionId: "allowOnce" },
      });
      await expect(result).rejects.toThrow(/注册|schema/);
      expect(claim).not.toHaveBeenCalled();
      if (change === "replace" || change === "schema") {
        const current = registry
          .resolveRunTools(resolution)
          .find((entry) => entry.name === "DynamicWrite");
        if (!current) throw new Error("Current dynamic registration missing");
        await expect(
          registry.executeDefinition(current, { version }, task.execution),
        ).rejects.toThrow();
        expect(
          permissions.listPending(task.actor.instanceId, task.identity.taskId),
        ).toEqual([]);
      }
      if (change === "replace") {
        unregister();
        expect(
          registry
            .resolveRunTools(resolution)
            .some((entry) => entry.name === "DynamicWrite"),
        ).toBe(true);
      }
      expect(effects).toBe(0);
    } finally {
      unregister();
      replacement();
      await kernel.dispose();
      await task.cleanup();
    }
  },
);
