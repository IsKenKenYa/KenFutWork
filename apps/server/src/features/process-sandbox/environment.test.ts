import { expect, it } from "vitest";
import { executionEnvironment, prependExecutionPath } from "./environment.js";

const sep = process.platform === "win32" ? ";" : ":";

it("prependExecutionPath：随包运行时 bin 前置进 PATH（去重、不重复插入）", () => {
  const env: Record<string, string> = { PATH: ["/usr/bin", "/bin"].join(sep) };
  prependExecutionPath(env, [
    "/opt/kfw/runtime/python",
    "/opt/kfw/runtime/node",
  ]);
  expect(env.PATH?.split(sep)).toEqual([
    "/opt/kfw/runtime/python",
    "/opt/kfw/runtime/node",
    "/usr/bin",
    "/bin",
  ]);
  // 再调一次不产生重复项
  prependExecutionPath(env, ["/opt/kfw/runtime/python"]);
  expect(
    env.PATH?.split(sep).filter((p) => p === "/opt/kfw/runtime/python"),
  ).toHaveLength(1);
});

it("prependExecutionPath：空/未给 additions 时不动 PATH", () => {
  const env: Record<string, string> = { PATH: "/usr/bin" };
  prependExecutionPath(env, undefined);
  prependExecutionPath(env, []);
  expect(env.PATH).toBe("/usr/bin");
});

it("prependExecutionPath：PATH 缺失时也能落成 additions", () => {
  const env: Record<string, string> = {};
  prependExecutionPath(env, ["/opt/kfw/runtime/python"]);
  expect(env.PATH).toBe("/opt/kfw/runtime/python");
});

it("executionEnvironment 与 prependExecutionPath 组合：宿主 PATH 在前置项之后", () => {
  const env = executionEnvironment({
    PATH: `/host/bin`,
    SystemRoot: "C:/Windows",
  });
  prependExecutionPath(env, ["/opt/kfw/runtime/uv"]);
  expect(env.PATH?.split(sep)[0]).toBe("/opt/kfw/runtime/uv");
  expect(env.PATH).toContain("/host/bin");
});
