import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/dependency-security.mjs", import.meta.url),
);

for (const scenario of ["file-type", "image-size", "node-forge"]) {
  test(`安全补丁保留 ${scenario} 的真实消费接口并拒绝恶意输入`, async () => {
    // 独立进程的测试期限用于捕获解析循环，不能依赖被阻塞的事件循环计时。
    const { stdout } = await execFileAsync(
      process.execPath,
      [fixture, scenario],
      {
        timeout: 5000,
      },
    );
    assert.equal(stdout.trim(), `${scenario}: ok`);
  });
}
