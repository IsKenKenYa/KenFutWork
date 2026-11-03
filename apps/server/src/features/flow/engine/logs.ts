import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  FlowEngineLaunch,
  FlowHostEngineLogsResponse,
} from "@kenfutwork/shared";

import {
  createProcessRunCommand,
  decodeCommandText,
  type RunCommand,
} from "./exec.js";
import { STACK_LOG_FILE } from "./install.js";
import { listEngineStackContainers } from "./stack.js";

/**
 * 引擎日志读取：安装日志落盘文件 + 各运行中容器的 `docker logs`。
 *
 * 安装日志只在数据目录里，进程重启后仍可读；容器日志必须走**与安装相同的承载目标**
 * （宿主 docker / WSL2 内 docker），否则会去另一侧找一套不存在的容器。
 * 容器名只接受 `docker compose ps` 当前清单里的名字，避免把任意容器日志读出来。
 */

const DEFAULT_TAIL = 500;
const MAX_TAIL = 20_000;

export class FlowEngineLogError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "FlowEngineLogError";
    this.statusCode = statusCode;
  }
}

export async function readEngineLogs(input: {
  source: "install" | "container";
  container?: string;
  tail?: number;
  composeFile: string;
  envFile?: string;
  dataDir: string;
  launch: FlowEngineLaunch;
  run?: RunCommand;
  listContainers?: typeof listEngineStackContainers;
}): Promise<FlowHostEngineLogsResponse> {
  if (input.source === "install") {
    return readInstallLog(input.dataDir, input.tail);
  }
  return readContainerLog({
    ...input,
    container: input.container?.trim() ?? "",
  });
}

function readInstallLog(
  dataDir: string,
  tail: number | undefined,
): FlowHostEngineLogsResponse {
  const path = join(dataDir, STACK_LOG_FILE);
  if (!existsSync(path)) {
    return {
      source: "install",
      title: "安装日志",
      path,
      lines: [],
      truncated: false,
    };
  }
  const all = readFileSync(path, "utf8").split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  const limit =
    tail === 0 ? all.length : Math.min(tail ?? DEFAULT_TAIL, MAX_TAIL);
  const lines = all.slice(Math.max(0, all.length - limit));
  return {
    source: "install",
    title: "安装日志",
    path,
    lines,
    truncated: lines.length < all.length,
  };
}

async function readContainerLog(input: {
  container: string;
  tail?: number;
  composeFile: string;
  envFile?: string;
  launch: FlowEngineLaunch;
  run?: RunCommand;
  listContainers?: typeof listEngineStackContainers;
}): Promise<FlowHostEngineLogsResponse> {
  if (!input.container) {
    throw new FlowEngineLogError("请选择要读取的容器。", 400);
  }
  const list = input.listContainers ?? listEngineStackContainers;
  const stack = await list(input.composeFile, {
    ...(input.envFile ? { envFile: input.envFile } : {}),
    launch: input.launch,
  });
  if (stack.error) {
    throw new FlowEngineLogError(`容器清单不可用：${stack.error}`);
  }
  const container = stack.containers.find(
    (item) => item.name === input.container || item.service === input.container,
  );
  if (!container) {
    throw new FlowEngineLogError("未找到该容器，可能已停止或已被删除。", 404);
  }
  const tail =
    input.tail === 0
      ? MAX_TAIL
      : Math.min(input.tail ?? DEFAULT_TAIL, MAX_TAIL);
  const args = ["logs", "--tail", String(tail), "--timestamps", container.name];
  const command =
    input.launch.kind === "wsl2"
      ? {
          command: "wsl.exe",
          args: ["-d", input.launch.distro, "--", "docker", ...args],
        }
      : { command: "docker", args };
  const run = input.run ?? createProcessRunCommand({ timeoutMs: 20_000 });
  const result = await run(command.command, command.args);
  if (result.code !== 0) {
    throw new FlowEngineLogError(
      `容器日志读取失败（退出码 ${result.code}）：${
        decodeCommandText(result.stderr) || "无输出"
      }`,
    );
  }
  const text = decodeCommandText(result.stdout);
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  return {
    source: "container",
    title: `容器日志 · ${container.service}`,
    path: null,
    lines,
    truncated: false,
  };
}
