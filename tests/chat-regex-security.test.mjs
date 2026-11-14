import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

// 编译实际消费模块，在可终止的子进程中验证同步正则，防止测试自身无法结束。
const { outputFiles } = await build({
  entryPoints: [`${root}tests/fixtures/chat-regex-security.ts`],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: {
    "@zui": `${root}apps/web/src/components/workbench/zcode`,
    "@zcode/shared": `${root}packages/zcode-shared/src/index.ts`,
    // @zcode/shared 的 src 链引用的 workspace 包 exports 只指向不入库的 dist；
    // 本测试先于 CI 的上游构建执行，必须与 @zcode/shared 同样按 src 解析。
    "@zcode/model-option-map": `${root}packages/zcode-model-option-map/src/index.ts`,
  },
});

for (const scenario of [
  "mention-links",
  "prompt-label",
  "preview-url",
  "file-url",
  "plugin-token",
]) {
  test(`聊天链接 ${scenario} 在恶意长文本中正常结束并保留展示结果`, async () => {
    const execution = execFileAsync(
      process.execPath,
      ["--input-type=module", "-", scenario],
      { timeout: 5000 },
    );
    execution.child.stdin.end(outputFiles[0].text);
    const { stdout } = await execution;
    assert.equal(stdout.trim(), `${scenario}: ok`);
  });
}
