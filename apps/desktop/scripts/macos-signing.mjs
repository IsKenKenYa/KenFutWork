import { spawnSync } from "node:child_process";
import { findMachOFiles, verifyMachOFiles } from "./dist-manifest.mjs";

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
  // `--verify --deep` 通过 ≠ 包内每个 Mach-O 都封好了：Resources 下的散装
  // .node / spawn-helper 不在 bundle 结构里，--deep 不覆盖它们，而运行期正是
  // 这些被 dlopen / spawn（CI 实测外层校验通过、逐文件仍有 4 个未封印）。
  // 所以外层结论只当「要不要走补封」的一半，另一半必须逐文件验。
  const machoFiles = () => findMachOFiles(appPath);
  const before = verifyMachOFiles(machoFiles(), codesign);
  const outerOk = run(verify).status === 0;
  if (outerOk && before.failedTotal === 0)
    return { repaired: false, macho: before };
  const metadata = run(["--display", "--verbose=2"]);
  const adhoc =
    metadata.status === 0 && /^Signature=adhoc$/mu.test(metadata.stderr);
  const unsigned =
    metadata.status !== 0 &&
    /code object is not signed at all/u.test(metadata.stderr);
  if (!adhoc && !unsigned)
    throw new Error(
      outerOk
        ? `外层签名有效但 ${before.failedTotal} 个内部二进制未封印，必须用原签名身份重封（不许 ad-hoc 降级）：${before.failedSample.join("、")}`
        : "已有签名验证失败，请使用原签名身份重新构建。",
    );
  // 先逐个封 Resources 下的散装 Mach-O，再封外层 bundle：`--deep` 会漏掉它们
  //（libnut.node、node-mac-permissions 的 .node、node-pty 的 pty.node 与
  // spawn-helper）。按路径深度自内向外排，避免先封外层再动内部把外层封印弄失效。
  const nested = machoFiles()
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
  // 验收口径是「逐文件失败数为 0」，不是「跑过一次补封」。
  const after = verifyMachOFiles(machoFiles(), codesign);
  if (after.failedTotal !== 0)
    throw new Error(
      `补封印后仍有 ${after.failedTotal} 个二进制未通过校验：${after.failedSample.join("、")}`,
    );
  return { repaired: true, nestedSigned: nested.length, macho: after };
}
