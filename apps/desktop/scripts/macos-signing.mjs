import { spawnSync } from "node:child_process";
import { findMachOFiles } from "./dist-manifest.mjs";

/** 独立CLI边界供收集器调用；测试可提供外部codesign进程，不替换本模块。 */
export function ensureMacosAppSeal(appPath, codesign = "/usr/bin/codesign") {
  const runOn = (target, args) => {
    const result = spawnSync(codesign, [...args, target], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error || result.status === null)
      throw new Error("签名工具执行失败，请检查 codesign。");
    return result;
  };
  const run = (args) => runOn(appPath, args);
  const verify = ["--verify", "--deep", "--strict"];
  if (run(verify).status === 0) return { repaired: false };
  const metadata = run(["--display", "--verbose=2"]);
  const adhoc =
    metadata.status === 0 && /^Signature=adhoc$/mu.test(metadata.stderr);
  const unsigned =
    metadata.status !== 0 &&
    /code object is not signed at all/u.test(metadata.stderr);
  if (!adhoc && !unsigned)
    throw new Error("已有签名验证失败，请使用原签名身份重新构建。");
  // 先逐个封 Resources 下的散装 Mach-O，再封外层 bundle：`--deep` 会漏掉它们
  //（CI 实测 204 个 Mach-O 里 4 个未封印——libnut.node、node-mac-permissions 的 .node、
  // node-pty 的 pty.node 与 spawn-helper），而运行期正是这些被 dlopen / spawn。
  // 按路径深度自内向外排，避免先封外层再动内部把外层封印弄失效。
  const nested = findMachOFiles(appPath)
    .filter((file) => file !== appPath)
    .sort((a, b) => b.split("/").length - a.split("/").length);
  for (const file of nested) {
    if (runOn(file, ["--force", "--sign", "-"]).status !== 0)
      throw new Error(`嵌套二进制封印失败：${file}`);
  }
  if (run(["--force", "--deep", "--sign", "-"]).status !== 0)
    throw new Error("应用资源封印失败。");
  if (run(verify).status !== 0)
    throw new Error("补封印后验证失败，请重新构建应用。");
  return { repaired: true, nestedSigned: nested.length };
}
