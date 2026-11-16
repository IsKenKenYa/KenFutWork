import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProcessRunCommand, decodeCommandText } from "./exec.js";
import { composeCommand, planEngineAutoInstall } from "./install.js";
import { listEngineStackContainers } from "./stack.js";

it.skipIf(process.env.RUN_FLOW_DOCKER_INTEGRATION !== "1")(
  "Docker 容器退出后仍可查询并且不会触发自动安装",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "kfw-flow-stopped-"));
    const composeFile = join(folder, "compose.json");
    const project = `kfw-flow-test-${randomUUID()}`;
    const run = createProcessRunCommand({ timeoutMs: 45_000 });
    async function compose(...args: string[]) {
      const command = composeCommand({ composeFile }, [
        "--project-name",
        project,
        "--profile",
        "dify",
        ...args,
      ]);
      const result = await run(command.command, command.args);
      expect(result.code, decodeCommandText(result.stderr)).toBe(0);
    }
    await writeFile(
      composeFile,
      JSON.stringify({
        name: project,
        services: {
          api: {
            image: "postgres:15-alpine",
            command: ["true"],
            network_mode: "none",
          },
        },
      }),
    );
    try {
      expect(await listEngineStackContainers(composeFile)).toEqual({
        containers: [],
      });
      await compose("up", "-d", "--pull", "never");
      await compose("wait", "api");
      const stack = await listEngineStackContainers(composeFile);
      expect(stack.error).toBeUndefined();
      expect(stack.containers).toEqual([
        expect.objectContaining({ service: "api", state: "exited" }),
      ]);
      expect(
        planEngineAutoInstall({
          installState: "idle",
          stackContainerCount: stack.containers.length,
          recommended: "container",
        }).action,
      ).toBe("skip");
    } finally {
      try {
        await compose("down", "--volumes");
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
