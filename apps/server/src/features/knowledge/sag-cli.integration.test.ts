/**
 * 真实 `sag` CLI 的集成测试（默认跳过，CI 不强制）。
 *
 * 前置：本机安装 `@zleap-ai/sag@0.1.8`（仅 Windows x64 / macOS Apple Silicon），
 * 且 `SAG_DATA_DIR` 指向**隔离的临时目录**，禁止碰用户真实知识库。
 * 启用方式（手工验收时）：把下面的 `describe.skip` 改成 `describe` 再单独运行；
 * 不要接进默认 `pnpm test`，也不引入新的环境变量（env 权威表门禁会拦）。
 *
 * 本机（2026-11-08）未安装 sag，故 fixture 仍是按上游 serde 定义推导的值；
 * 在有 CLI 的机器上先跑 `probe/collect.mjs` 实采，再跑本用例。
 */

import { describe, it } from "vitest";

describe.skip("SAG CLI 实机集成（需真实二进制与隔离数据目录）", () => {
  it("sag config / list / check / search --json 与 zod 契约一致", async () => {
    // 实施步骤留待实机：
    // 1. 用 createProcessSagRunner({ binary: process.env.SAG_BIN ?? "sag" })；
    // 2. 逐条跑 ["config"]、["list","--json"]、["check", root, "--json"]、
    //    ["<query>", "--json", "-m", "5"]；
    // 3. 分别用 sagModelConfigSchema / sagListOutputSchema /
    //    sagCheckOutputSchema / sagSearchOutputSchema 解析并断言字段；
    // 4. 断言 --key-stdin 的凭据不出现在任何 argv 或输出中。
    // 本用例默认跳过，绝不连用户的真实知识库。
  });
});
