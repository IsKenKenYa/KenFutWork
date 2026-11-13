import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { PluginHookContribution } from "./plugin-contributions.js";
import { runPluginHooks } from "./plugin-hooks.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "plugin-hook-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function hook(
  over: Partial<PluginHookContribution> = {},
): PluginHookContribution {
  return {
    pluginId: "kenfutwork-tripo-3d",
    pluginName: "Tripo 3D",
    event: "turn-start",
    matcher: "startup|clear|compact",
    command: "node",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 意图保留 zcode 插件根占位符
    args: ["${ZCODE_PLUGIN_ROOT}/hook.mjs"],
    timeoutMs: 5_000,
    pluginRoot: dir,
    ...over,
  };
}

it("执行 SessionStart 脚本并取出 additionalContext", async () => {
  await writeFile(
    path.join(dir, "hook.mjs"),
    `let raw="";process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: input.hook_event_name,
  additionalContext: "RULE: 先确认 credits 再生成。",
}}));`,
    "utf8",
  );

  const outcome = await runPluginHooks({ hooks: [hook()], cwd: dir });
  expect(outcome.contexts).toEqual(["RULE: 先确认 credits 再生成。"]);
  expect(outcome.results).toHaveLength(1);
  expect(outcome.results[0]?.exitCode).toBe(0);
  expect(outcome.results[0]?.timedOut).toBe(false);
  expect(outcome.results[0]?.pluginId).toBe("kenfutwork-tripo-3d");
});

it("非零退出不注入上下文，但结果如实返回", async () => {
  await writeFile(path.join(dir, "hook.mjs"), "process.exit(2)", "utf8");
  const outcome = await runPluginHooks({ hooks: [hook()], cwd: dir });
  expect(outcome.contexts).toEqual([]);
  expect(outcome.results[0]?.exitCode).toBe(2);
});

it("超时被杀掉，输出仍然可见且不阻断后续钩子", async () => {
  await writeFile(
    path.join(dir, "hook.mjs"),
    "setTimeout(() => {}, 5000)",
    "utf8",
  );
  const outcome = await runPluginHooks({
    hooks: [hook({ timeoutMs: 50 })],
    cwd: dir,
  });
  expect(outcome.results[0]?.timedOut).toBe(true);
  expect(outcome.contexts).toEqual([]);
});
