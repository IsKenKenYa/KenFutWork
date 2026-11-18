import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandResult } from "./exec.js";
import { STACK_LOG_FILE } from "./install.js";
import { FlowEngineLogError, readEngineLogs } from "./logs.js";

const dirs: string[] = [];

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "kfw-engine-logs-"));
  dirs.push(dir);
  return dir;
}

function ok(stdout: string): CommandResult {
  return {
    code: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

const compose = "C:/repo/dify/docker-compose.dify.yml";
const dataDir = () => tempDataDir();

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("引擎日志读取", () => {
  it("安装日志按 tail 截断，tail=0 返回全量", async () => {
    const root = dataDir();
    writeFileSync(join(root, STACK_LOG_FILE), "one\ntwo\nthree\n");
    const tail = await readEngineLogs({
      source: "install",
      composeFile: compose,
      dataDir: root,
      launch: { kind: "host" },
      tail: 2,
    });
    expect(tail.lines).toEqual(["two", "three"]);
    expect(tail.truncated).toBe(true);
    expect(tail.path).toBe(join(root, STACK_LOG_FILE));

    const all = await readEngineLogs({
      source: "install",
      composeFile: compose,
      dataDir: root,
      launch: { kind: "host" },
      tail: 0,
    });
    expect(all.lines).toEqual(["one", "two", "three"]);
    expect(all.truncated).toBe(false);
  });

  it("安装日志不存在时返回空内容而不是报错", async () => {
    const result = await readEngineLogs({
      source: "install",
      composeFile: compose,
      dataDir: dataDir(),
      launch: { kind: "host" },
    });
    expect(result.lines).toEqual([]);
  });

  it("按承载目标读取指定容器日志", async () => {
    const run = vi.fn(async () => ok("2026-11-02T00:00:00Z line-a\nline-b\n"));
    const listContainers = vi.fn(async () => ({
      containers: [
        {
          service: "api",
          name: "kenfutwork-dify-api-1",
          state: "running",
          health: "healthy",
          ports: ["127.0.0.1:15001->5001/tcp"],
        },
      ],
    }));
    const result = await readEngineLogs({
      source: "container",
      container: "kenfutwork-dify-api-1",
      composeFile: compose,
      dataDir: dataDir(),
      launch: { kind: "host" },
      run,
      listContainers,
    });
    expect(result.title).toBe("容器日志 · api");
    expect(result.lines).toEqual(["2026-11-02T00:00:00Z line-a", "line-b"]);
    expect(run).toHaveBeenCalledWith("docker", [
      "logs",
      "--tail",
      "500",
      "--timestamps",
      "kenfutwork-dify-api-1",
    ]);
  });

  it("WSL2 承载时经 wsl.exe 调用 docker", async () => {
    const run = vi.fn(async () => ok("line"));
    await readEngineLogs({
      source: "container",
      container: "api",
      composeFile: compose,
      dataDir: dataDir(),
      launch: { kind: "wsl2", distro: "Ubuntu" },
      run,
      listContainers: vi.fn(async () => ({
        containers: [
          {
            service: "api",
            name: "kfw-api",
            state: "running",
            health: null,
            ports: [],
          },
        ],
      })),
    });
    expect(run).toHaveBeenCalledWith("wsl.exe", [
      "-d",
      "Ubuntu",
      "--",
      "docker",
      "logs",
      "--tail",
      "500",
      "--timestamps",
      "kfw-api",
    ]);
  });

  it("未知容器拒绝读取", async () => {
    await expect(
      readEngineLogs({
        source: "container",
        container: "other-container",
        composeFile: compose,
        dataDir: dataDir(),
        launch: { kind: "host" },
        run: vi.fn(async () => ok("")),
        listContainers: vi.fn(async () => ({ containers: [] })),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("容器清单不可用时返回可读原因", async () => {
    await expect(
      readEngineLogs({
        source: "container",
        container: "api",
        composeFile: compose,
        dataDir: dataDir(),
        launch: { kind: "host" },
        run: vi.fn(async () => ok("")),
        listContainers: vi.fn(async () => ({
          containers: [],
          error: "docker 不可用",
        })),
      }),
    ).rejects.toBeInstanceOf(FlowEngineLogError);
  });
});
