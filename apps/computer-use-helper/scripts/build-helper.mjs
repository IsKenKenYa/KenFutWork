import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBundleDescriptor } from "./bundle-config.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const helperRoot = resolve(scriptDirectory, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? helperRoot,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} 失败（exit=${result.status ?? "null"}）`,
    );
}

function insertPlistValue(plistPath, key, type, value) {
  execFileSync("/usr/bin/plutil", [
    "-insert",
    key,
    `-${type}`,
    String(value),
    plistPath,
  ]);
}

export async function buildHelperApp({
  out,
  configuration = "dev",
  version = "0.1.0",
  identity,
  skipBuild = false,
} = {}) {
  if (!out) throw new Error("必须提供 Helper 输出目录。");
  const descriptor = resolveBundleDescriptor({ configuration, version });
  const outputRoot = resolve(out);
  await mkdir(outputRoot, { recursive: true });

  if (!skipBuild)
    run("swift", ["build", "-c", "release", "--package-path", helperRoot]);

  const binary = join(
    helperRoot,
    ".build",
    "release",
    descriptor.executableName,
  );
  const appPath = join(outputRoot, descriptor.appName);
  await rm(appPath, { recursive: true, force: true });
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await cp(binary, join(macos, descriptor.executableName));
  await chmod(join(macos, descriptor.executableName), 0o755);

  const infoPath = join(contents, "Info.plist");
  execFileSync("/usr/bin/plutil", ["-create", "xml1", infoPath]);
  insertPlistValue(
    infoPath,
    "CFBundleIdentifier",
    "string",
    descriptor.bundleId,
  );
  insertPlistValue(
    infoPath,
    "CFBundleExecutable",
    "string",
    descriptor.executableName,
  );
  insertPlistValue(infoPath, "CFBundleName", "string", descriptor.displayName);
  insertPlistValue(
    infoPath,
    "CFBundleDisplayName",
    "string",
    descriptor.displayName,
  );
  insertPlistValue(infoPath, "CFBundlePackageType", "string", "APPL");
  insertPlistValue(
    infoPath,
    "CFBundleShortVersionString",
    "string",
    descriptor.version,
  );
  insertPlistValue(
    infoPath,
    "CFBundleVersion",
    "string",
    descriptor.bundleVersion,
  );
  insertPlistValue(
    infoPath,
    "LSMinimumSystemVersion",
    "string",
    descriptor.minimumSystemVersion,
  );
  insertPlistValue(infoPath, "LSUIElement", "bool", "YES");
  insertPlistValue(infoPath, "NSHighResolutionCapable", "bool", "YES");
  insertPlistValue(
    infoPath,
    "NSAppleEventsUsageDescription",
    "string",
    "KenFutWork Computer Use 需要控制 System Events 以激活目标应用。",
  );
  execFileSync("/usr/bin/plutil", ["-lint", infoPath]);

  const signingIdentity = identity?.trim() || "-";
  const signArgs = ["--force", "--deep", "--sign", signingIdentity];
  if (signingIdentity !== "-") signArgs.push("--options", "runtime");
  run("/usr/bin/codesign", [...signArgs, appPath]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

  return appPath;
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--skip-build") {
      values.skipBuild = true;
      continue;
    }
    if (!["--out", "--configuration", "--version", "--identity"].includes(key))
      throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${key} 缺少参数值。`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const app = await buildHelperApp(options);
    console.log(`Helper.app 已生成：${app}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
