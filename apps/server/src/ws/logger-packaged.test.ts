import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("真实CJS管线日志写托管数据目录，不在签名应用资源中创建文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "kfw-pipeline-package-"));
  const resources = join(root, "Resources");
  const bundle = join(resources, "app", "server", "pipeline.cjs");
  const data = join(root, "数据");
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./logger.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      define: { "import.meta.dirname": "__dirname" },
    });
    await exec(
      process.execPath,
      [
        "-e",
        'require(process.argv[1]).createPipelineLogger("package-regression").info("owned-write", { value: "中文🙂" });',
        bundle,
      ],
      { env: { ...process.env, KENFUTWORK_DATA_DIR: data } },
    );
    const files = await readdir(join(data, "logs"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name) throw new Error("托管日志未创建");
    expect(
      JSON.parse(await readFile(join(data, "logs", name), "utf8")),
    ).toMatchObject({
      scope: "package-regression",
      event: "owned-write",
      value: "中文🙂",
    });
    expect(existsSync(join(resources, "logs"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
