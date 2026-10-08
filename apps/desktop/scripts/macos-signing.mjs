import { spawnSync } from "node:child_process";

/** 独立CLI边界供收集器调用；测试可提供外部codesign进程，不替换本模块。 */
export function ensureMacosAppSeal(appPath, codesign = "/usr/bin/codesign") {
  const run = (args) => {
    const result = spawnSync(codesign, [...args, appPath], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error || result.status === null)
      throw new Error("签名工具执行失败，请检查 codesign。");
    return result;
  };
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
  if (run(["--force", "--deep", "--sign", "-"]).status !== 0)
    throw new Error("应用资源封印失败。");
  if (run(verify).status !== 0)
    throw new Error("补封印后验证失败，请重新构建应用。");
  return { repaired: true };
}
