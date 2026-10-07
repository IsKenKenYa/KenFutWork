import { describe, expect, it } from "vitest";

import type { RunCommand } from "./exec.js";
import { listEngineStackContainers } from "./stack.js";

/**
 * 引擎栈容器清单：`docker compose ps --format json` 的解析口径。
 * 两个版本形态（老版逐行 NDJSON / 新版单个 JSON 数组）都要吃下；查询失败不抛，
 * 回空清单 + 可读原因（信息页据此如实展示「查不到」而不是整页崩）。
 */
function runWith(stdout: string, code = 0, stderr = ""): RunCommand {
  const run: RunCommand = async () => ({
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
  return run;
}

const PS_ARRAY = JSON.stringify([
  {
    Service: "dify-api",
    Name: "futureflow-dify-api-1",
    State: "running",
    Health: "healthy",
    Publishers: [
      { URL: "127.0.0.1", TargetPort: 5001, PublishedPort: 15001, Protocol: "tcp" },
    ],
  },
  {
    Service: "dify-worker",
    Name: "futureflow-dify-worker-1",
    State: "running",
    Health: "",
    Publishers: [],
  },
]);

const PS_NDJSON = [
  JSON.stringify({
    Service: "postgres",
    Name: "futureflow-postgres",
    State: "running",
    Health: "healthy",
    Publishers: [
      { URL: "0.0.0.0", TargetPort: 5432, PublishedPort: 55433, Protocol: "tcp" },
    ],
  }),
  "{ not json — 跳过这一行 }",
  JSON.stringify({
    Service: "weaviate",
    Name: "futureflow-weaviate",
    State: "exited",
    Publishers: [],
  }),
].join("\n");

describe("引擎栈容器清单：docker compose ps 解析", () => {
  it("新版本 JSON 数组：服务/健康/端口映射齐全，按服务名排序", async () => {
    const { containers, error } = await listEngineStackContainers("compose.yml", { run: runWith(PS_ARRAY) });
    expect(error).toBeUndefined();
    expect(containers.map((item) => item.service)).toEqual([
      "dify-api",
      "dify-worker",
    ]);
    expect(containers[0]).toEqual({
      service: "dify-api",
      name: "futureflow-dify-api-1",
      state: "running",
      health: "healthy",
      ports: ["127.0.0.1:15001->5001/tcp"],
    });
    // 空 Health 归 null（界面按 state 显示，不显示空徽标）
    expect(containers[1]?.health).toBeNull();
  });

  it("老版本逐行 NDJSON：脏行跳过，0.0.0.0 归一成 127.0.0.1", async () => {
    const { containers } = await listEngineStackContainers("compose.yml", { run: runWith(PS_NDJSON) });
    expect(containers).toHaveLength(2);
    expect(containers.find((item) => item.service === "postgres")?.ports).toEqual(
      ["127.0.0.1:55433->5432/tcp"],
    );
  });

  it("docker 不可用：不抛，回空清单 + 可读原因", async () => {
    const { containers, error } = await listEngineStackContainers("compose.yml", { run: runWith("", 127, "docker: command not found") });
    expect(containers).toEqual([]);
    expect(error).toContain("docker compose ps 失败");
    expect(error).toContain("command not found");
  });

  it("空输出（栈没起）：空清单且无错误", async () => {
    const { containers, error } = await listEngineStackContainers("compose.yml", { run: runWith("") });
    expect(containers).toEqual([]);
    expect(error).toBeUndefined();
  });
});

describe("引擎栈容器清单：端口口径与状态校正材料", () => {
  it("PublishedPort=0（仅 expose 未 publish）不出现在端口映射里", async () => {
    const ps = JSON.stringify([
      {
        Service: "db",
        Name: "db-1",
        State: "running",
        Health: "healthy",
        Publishers: [
          { URL: "127.0.0.1", TargetPort: 5432, PublishedPort: 0, Protocol: "tcp" },
          { URL: "127.0.0.1", TargetPort: 5001, PublishedPort: 15001, Protocol: "tcp" },
        ],
      },
    ]);
    const { containers } = await listEngineStackContainers("compose.yml", {
      run: runWith(ps),
    });
    expect(containers[0]?.ports).toEqual(["127.0.0.1:15001->5001/tcp"]);
  });
});
