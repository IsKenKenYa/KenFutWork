const CONFIGURATIONS = {
  dev: {
    appName: "KenFutWork Computer Use Dev.app",
    displayName: "KenFutWork Computer Use Dev",
    bundleId: "com.kenfutwork.cua-helper.dev",
  },
  production: {
    appName: "KenFutWork Computer Use.app",
    displayName: "KenFutWork Computer Use",
    bundleId: "com.kenfutwork.cua-helper",
  },
};

export function resolveBundleDescriptor({
  configuration = "dev",
  version = "0.1.0",
} = {}) {
  const selected = CONFIGURATIONS[configuration];
  if (!selected) throw new Error(`未知的 Helper 构建配置：${configuration}`);
  if (typeof version !== "string" || !version.trim())
    throw new Error("Helper 版本不能为空。");
  return {
    configuration,
    ...selected,
    version: version.trim(),
    bundleVersion: "1",
    executableName: "kenfutwork-cua-helper",
    minimumSystemVersion: "12.0",
    lsuielement: true,
  };
}
