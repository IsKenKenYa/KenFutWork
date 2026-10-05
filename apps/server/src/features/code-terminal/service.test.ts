import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { TerminalOutputCursor } from "../process-sandbox/types.js";
import { createCodeTerminalService } from "./service.js";

it("显式Task终端并发同ID只认领一次，连接关闭期间迟到授权不能spawn", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-terminal-admission-")),
  );
  try {
    const scope = {
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    };
    const actor = { instanceId: scope.instanceId, accessClientId: null };
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scopes = createExecutionScopes({
      repository: {
        load: async () => {
          opened();
          await admission;
          return { scope, state: "ready", branchGeneration: 1 };
        },
      },
      localInstance: {
        resolve: async (subject: { instanceId: string }) => ({
          instanceId: subject.instanceId,
          dataDir: root,
        }),
      } as never,
    });
    let spawns = 0;
    const service = createCodeTerminalService({
      scopes,
      sandbox: {
        spawnPty: async () => {
          spawns += 1;
          throw new Error("关闭后的终端不能启动");
        },
      } as never,
      localInstance: {
        resolve: async (subject: { instanceId: string }) => ({
          instanceId: subject.instanceId,
          dataDir: root,
        }),
      } as never,
      settings: {
        getInstanceSettings: async () =>
          instanceSettingsSchema.parse({ defaultModel: "fixture" }),
      } as never,
    });
    const request = {
      taskId: scope.taskId,
      sessionId: "terminal",
      cols: 80,
      rows: 24,
    };
    const first = service.create(actor, "connection", request);
    const replay = service.create(actor, "connection", request);
    // 先为两个pending Promise挂观察，避免测试清理产生未观察拒绝。
    const results = Promise.allSettled([first, replay]);
    await opening;
    const closing = service.closeConnection(
      scope.instanceId,
      "connection",
      "socket closed",
    );
    release();
    await closing;
    expect((await results).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(spawns).toBe(0);
    await expect(service.create(actor, "connection", request)).rejects.toThrow(
      /关闭/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "真实PTY在激活订阅后交付初始输出和快速退出，按终端身份隔离",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-terminal-stream-")),
    );
    const scope = {
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write" as const,
    };
    const actor = { instanceId: scope.instanceId, accessClientId: null };
    const localInstance = {
      resolve: async (subject: { instanceId: string }) => ({
        instanceId: subject.instanceId,
        dataDir: root,
      }),
    };
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
      // 发布验证可以指定本轮构建资源；普通回归使用源码helper，不依赖某次/tmp产物。
      ...(process.env.KENFUTWORK_PTY_TEST_HELPER_PATH
        ? {
            helperPath: process.env.KENFUTWORK_PTY_TEST_HELPER_PATH,
            helperExecArgv: [],
          }
        : {}),
    });
    const service = createCodeTerminalService({
      scopes: createExecutionScopes({
        repository: {
          load: async () => ({ scope, state: "ready", branchGeneration: 1 }),
        },
        localInstance: localInstance as never,
      }),
      sandbox,
      localInstance: localInstance as never,
      settings: {
        getInstanceSettings: async () =>
          instanceSettingsSchema.parse({
            defaultModel: "fixture",
            terminalShell: "sh",
          }),
      } as never,
    });
    try {
      const first = await service.create(actor, "connection", {
        taskId: scope.taskId,
        sessionId: "first",
        cols: 80,
        rows: 24,
      });
      const second = await service.create(actor, "connection", {
        taskId: scope.taskId,
        sessionId: "second",
        cols: 91,
        rows: 29,
      });
      await service.write(
        actor,
        "connection",
        first.id,
        "printf '\\110\\105\\114\\114\\117\\n'; exit\r",
      );
      let data = "";
      let other = "";
      const frames: Array<{ data: string; cursor: TerminalOutputCursor }> = [];
      const order: string[] = [];
      const exited: number[] = [];
      await expect(
        service.subscribe(
          { ...actor, instanceId: "00000000-0000-4000-8000-000000000099" },
          "connection",
          first.id,
          {
            output: async () => {},
            exit: async () => {},
          },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await service.subscribe(actor, "connection", first.id, {
        output: async (value, cursor) => {
          data += value;
          frames.push({ data: value, cursor });
          order.push("output");
        },
        exit: async (value) => {
          exited.push(value.exitCode ?? -1);
          order.push("exit");
        },
      });
      await service.subscribe(actor, "connection", second.id, {
        output: async (value) => {
          other += value;
        },
        exit: async () => {},
      });
      await expect.poll(() => exited).toEqual([0]);
      expect(data.match(/HELLO/gu)).toHaveLength(1);
      expect(other).not.toContain("HELLO");
      expect(order.at(-1)).toBe("exit");
      expect(frames.length).toBeGreaterThan(0);
      for (const [index, frame] of frames.entries()) {
        expect(frame.cursor.sequence).toBe(index + 1);
        expect(frame.cursor.offset).toBe(
          index === 0 ? 0 : frames[index - 1]?.cursor.nextOffset,
        );
        expect(frame.cursor.nextOffset - frame.cursor.offset).toBe(
          Buffer.byteLength(frame.data),
        );
      }
      await service.subscribe(actor, "connection", first.id, {
        output: async () => {
          throw new Error("重复订阅不得再交付输出");
        },
        exit: async () => {
          throw new Error("重复订阅不得再交付退出");
        },
      });
      expect(exited).toEqual([0]);
      await service.stop(actor, "connection", first.id, "idempotent_dispose");
      await service.stop(actor, "connection", first.id, "idempotent_dispose");
    } finally {
      await service.close("test_cleanup");
      await sandbox.close("test_cleanup");
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "已退出PTY晚订阅读尽首帧之后的真实有界尾部，保持UTF8游标与单帧ACK",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-terminal-late-reader-")),
    );
    const release = join(root, "release");
    const settings = instanceSettingsSchema.parse({ defaultModel: "fixture" });
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    try {
      const child = await sandbox.spawnPty({
        scope: {
          instanceId: "late-reader-workspace",
          projectId: "late-reader-project",
          taskId: "late-reader-task",
          generation: 1,
          rootDirectory: root,
          additionalDirectories: [],
          sandboxMode: "workspace-write",
        },
        agentId: "human-terminal",
        invocationId: "late-reader",
        argv: {
          executable: process.execPath,
          args: [
            "-e",
            `const fs=require("node:fs");process.stdout.write("BEFORE");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write("HELLO中");process.exit(0)}},10)`,
          ],
        },
        pty: { cols: 80, rows: 24 },
        background: true,
        timeoutMs: null,
        limits: {
          maxOutputBytes: settings.processMaxOutputBytes,
          previewMaxChars: settings.processPreviewMaxChars,
          yieldMs: settings.processYieldMs,
          killGraceMs: settings.processKillGraceMs,
        },
      });
      await expect
        .poll(() => child.snapshot().totalBytes)
        .toBe(Buffer.byteLength("BEFORE"));
      // 文件握手让真实程序在没有reader时完成，避免交互shell的readline回压左右时序。
      await writeFile(release, "go");
      await expect
        .poll(() => child.snapshot().exit)
        .toMatchObject({ exitCode: 0, rangeEmpty: true });
      const frames: Array<{ data: string; cursor: TerminalOutputCursor }> = [];
      const dispose = child.onOutput((data, cursor) => {
        frames.push({ data, cursor });
      });
      try {
        expect(await child.waitForExit()).toMatchObject({
          exitCode: 0,
          rangeEmpty: true,
        });
        expect(frames.map((frame) => frame.data).join("")).toBe(
          "BEFOREHELLO中",
        );
        expect(frames.length).toBeGreaterThan(1);
        for (const [index, frame] of frames.entries()) {
          expect(frame.cursor.sequence).toBe(index + 1);
          expect(frame.cursor.offset).toBe(
            index === 0 ? 0 : frames[index - 1]?.cursor.nextOffset,
          );
          expect(frame.cursor.nextOffset - frame.cursor.offset).toBe(
            Buffer.byteLength(frame.data),
          );
        }
      } finally {
        dispose();
      }
    } finally {
      await sandbox.close("test_cleanup");
      await rm(root, { recursive: true, force: true });
    }
  },
);
