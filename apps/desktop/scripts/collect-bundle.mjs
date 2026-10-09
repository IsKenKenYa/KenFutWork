#!/usr/bin/env node
/**
 * 把刚打出来的安装包**收到仓库根目录**（用户口径：默认产物就在项目根，别埋在
 * `target/release/bundle/…` 那种深层路径里）。构建由 `pnpm --filter @kenfutwork/desktop build`
 * 串起来：`tauri build && node scripts/collect-bundle.mjs`。
 *
 * 根目录只留**最新一份**：每次收的时候把同名的旧副本删掉，免得攒出好几个几十 MB 的文件。
 * 原始产物仍在 tauri 的 bundle 目录里（发布流水线要它就在那），这里只是多放一份顺手的位置。
 *
 * 按平台收不同产物：Windows 收 NSIS 的 `*-setup.exe`；macOS 的 DMG **不用** tauri 的
 * bundler（它靠 AppleScript 驱动 Finder 走 UI，无头/受限环境必挂），而是用 **appdmg**
 * 生成带品牌背景 + 拖拽引导布局的镜像（Docker 式「拖入 Applications」，纯 JS 无
 * AppleScript；失败回落 hdiutil 无布局镜像）。2026-09-23，见 scripts/package-mac.mjs。
 * Linux 没有产物，静默跳过。
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import {
  buildDistManifest,
  classifyAuthenticode,
  classifyCodesignDisplay,
  findMachOFiles,
  readBuildTooling,
  verifyMachOFiles,
  writeDistManifest,
} from "./dist-manifest.mjs";
import { ensureMacosAppSeal } from "./macos-signing.mjs";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const bundleBase = join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
);

/** git 读数：CI 上优先用 runner 注入的环境变量，本机出包回落到 git 命令。 */
function readGitValue(names, gitArgs) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  const probe = spawnSync("git", gitArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return probe.status === 0 ? probe.stdout.trim() || null : null;
}

/** 随包 runtime 的版本记账：有 `runtime-lock.json` 就用它，没有就如实留空。 */
function readRuntimeVersions() {
  const lockPath = join(repoRoot, "runtime-lock.json");
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/** 产品版本：`tauri.conf.json` 是权威（另有门禁保证四处一致）。 */
function readProductVersion() {
  return (
    JSON.parse(
      readFileSync(
        join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
        "utf8",
      ),
    ).version ?? null
  );
}

function collectLatest({ dir, suffix, doneMessage }) {
  if (!existsSync(dir)) {
    console.error(`[collect] 没找到产物目录：${dir}（先跑 tauri build）`);
    process.exit(1);
  }
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    console.error(`[collect] ${dir} 里没有 *${suffix}`);
    process.exit(1);
  }
  const latest = candidates[0];
  const target = join(repoRoot, latest.split(/[\\/]/).pop());
  // 根目录只留最新一份：清掉旧的同名产物
  for (const name of readdirSync(repoRoot)) {
    if (name.endsWith(suffix) && join(repoRoot, name) !== target) {
      rmSync(join(repoRoot, name), { force: true });
      console.log(`[collect] 删掉根目录旧副本：${name}`);
    }
  }
  copyFileSync(latest, target);
  const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[collect] ${doneMessage}：${target}（${sizeMb} MB）`);
  return target;
}

if (process.platform === "win32") {
  const setupExe = collectLatest({
    dir: join(bundleBase, "nsis"),
    suffix: "-setup.exe",
    doneMessage: "安装包已在项目根（双击即装）",
  });
  // Authenticode 读数用 env 传参，不把路径拼进 PowerShell 命令行（避开引号与注入面）。
  const probe = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-AuthenticodeSignature $env:KFW_ARTIFACT).Status",
    ],
    { encoding: "utf8", env: { ...process.env, KFW_ARTIFACT: setupExe } },
  );
  const status = classifyAuthenticode(probe.stdout);
  writeDistManifest(
    repoRoot,
    buildDistManifest({
      root: repoRoot,
      version: readProductVersion(),
      platform: "win32",
      commit: readGitValue(["GITHUB_SHA"], ["rev-parse", "HEAD"]),
      ref: readGitValue(
        ["GITHUB_REF_NAME"],
        ["rev-parse", "--abbrev-ref", "HEAD"],
      ),
      build: readBuildTooling(repoRoot),
      runtimeVersions: readRuntimeVersions(),
      signing: {
        status,
        provider: status === "unsigned" ? "none" : "unknown",
      },
      artifacts: [setupExe],
    }),
  );
} else if (process.platform === "darwin") {
  // tauri 的 dmg bundler 依赖 AppleScript（Finder 自动化），无头环境跑不了。
  // 这里首选 **appdmg**（纯 JS 写 .DS_Store，无 AppleScript，背景图/图标布局全可控，
  // Docker 式「拖拽安装」引导）；失败再回落 hdiutil（出无布局但可用的镜像）。
  const appDir = join(bundleBase, "macos");
  const appPath = join(appDir, "KenFutWork.app");
  if (!existsSync(appPath)) {
    console.error(`[collect] 没找到应用包：${appDir}（先跑 tauri build）`);
    process.exit(1);
  }
  // 沿用已有有效身份；只为未签名/ad-hoc包补Resources，不能把证书签名降级。
  const seal = ensureMacosAppSeal(appPath);
  console.log(
    seal.repaired
      ? "[collect] 本机资源封印已补全"
      : "[collect] 沿用已有有效签名",
  );
  const version = readProductVersion();
  const dmgPath = join(repoRoot, `KenFutWork_${version}_${process.arch}.dmg`);
  rmSync(dmgPath, { force: true });

  // 布局（660×400pt，@2x 背景 1320×800）：应用图标左、Applications 右，背景图承载
  // 品牌标题 + 拖拽引导箭头（源文件 src-tauri/dmg/background.svg，sharp 渲染出 png）。
  const srcTauri = join(import.meta.dirname, "..", "src-tauri");
  const spec = {
    title: "KenFutWork",
    icon: join(srcTauri, "icons", "icon.icns"),
    background: join(srcTauri, "dmg", "background.png"),
    "icon-size": 128,
    window: { position: { x: 180, y: 170 }, size: { width: 660, height: 400 } },
    format: "UDZO",
    contents: [
      { x: 165, y: 225, type: "file", path: appPath },
      { x: 495, y: 225, type: "link", path: "/Applications" },
    ],
  };

  // **首选布局引擎：tauri 的 bundle_dmg.sh**（AppleScript 真实设置窗口 bounds 与
  // 图标坐标；appdmg 写的窗口尺寸在本机 Finder 不生效导致图标错位，2026-09-23
  // 用户截图实锤）。脚本与 support 已收进仓库 scripts/dmg/（带 repo 哨兵）。
  const dmgScript = join(import.meta.dirname, "dmg", "bundle_dmg.sh");
  const layout = [
    "bash",
    [
      dmgScript,
      "--volname",
      "KenFutWork",
      "--volicon",
      join(srcTauri, "icons", "icon.icns"),
      // 背景两重口径（都实测踩过）：① 必须 **1x 尺寸（660×400）**——Finder 不感知
      // @2x；② PNG 的 **DPI 元数据必须 72**——sharp 默认写 96，Finder 按 72/96=0.75
      // 缩放绘制 → 背景只铺窗口的 75%、右下露白（用户截图实锤）。渲染命令见
      // package 前置：sharp(svg,{density:72}).resize(660,400).withMetadata({density:72})。
      "--background",
      join(srcTauri, "dmg", "background.png"),
      "--window-size",
      "660",
      "400",
      "--icon-size",
      "128",
      "--icon",
      "KenFutWork.app",
      "165",
      "225",
      "--app-drop-link",
      "495",
      "225",
      // CI/无 GUI 环境必带：脚本自带的「跳过美化 Finder 的 AppleScript」开关
      //（bundle_dmg.sh 的 --skip-jenkins 文档原文即「适用 Sandbox 与非 GUI 环境」）。
      // 不带它，托管 runner 上布局引擎会在 AppleScript 那步挂死而不是降级。
      "--skip-jenkins",
      dmgPath,
      appDir,
    ],
  ];
  const layoutOk = (() => {
    if (!existsSync(dmgScript)) {
      console.log("[collect] 未找到 bundle_dmg.sh，跳过布局引擎");
      return false;
    }
    const run = spawnSync(layout[0], layout[1], { stdio: "inherit" });
    return run.status === 0;
  })();
  // 三档布局引擎的读数要如实进 manifest：bundle_dmg（AppleScript 真布局）
  // → appdmg（纯 JS 布局，窗口尺寸可能不被 Finder 采纳）→ hdiutil（无布局）。
  // 走哪一档不该靠人回忆，图标错位历史上就是「看不出这次用了哪档」造成的。
  let dmgLayout = layoutOk ? "bundle_dmg" : null;
  let ok = layoutOk;

  // 布局引擎失败（无头/AppleScript 权限受限）→ appdmg 兜底（纯 JS 也有布局，
  // 但窗口尺寸可能不被 Finder 采纳）；再失败 → hdiutil 无布局镜像。
  // appdmg 的原生依赖（macos-alias 的 volume.node / fs-xattr 的 xattr.node）：上游
  // tarball 不带产物、pnpm 默认拦 install 脚本，且 ABI 必须与「当前运行的 node」一致
  // ——加载/运行失败就整批删缓存产物、用当前 node 重跑 node-gyp、再试一次。
  const nativeDeps = [
    join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "macos-alias@0.2.12",
      "node_modules",
      "macos-alias",
    ),
    join(
      repoRoot,
      "node_modules",
      ".pnpm",
      readdirSync(join(repoRoot, "node_modules", ".pnpm")).find((name) =>
        name.startsWith("fs-xattr@"),
      ) ?? "fs-xattr@none",
      "node_modules",
      "fs-xattr",
    ),
  ];
  const rebuildNativeDeps = () => {
    let allOk = true;
    for (const pkgDir of nativeDeps) {
      if (!existsSync(join(pkgDir, "binding.gyp"))) continue;
      console.log(`[collect] 重编原生依赖：${basename(dirname(pkgDir))}…`);
      rmSync(join(pkgDir, "build"), { recursive: true, force: true });
      const gyp = spawnSync(
        process.execPath,
        [
          join(repoRoot, "node_modules", "node-gyp", "bin", "node-gyp.js"),
          "rebuild",
        ],
        { cwd: pkgDir, stdio: "inherit" },
      );
      if (gyp.status !== 0) allOk = false;
    }
    return allOk;
  };
  // dlopen 的 ABI 错误在**运行期**才炸（惰性 require 原生模块）。重试用 **CJS
  // require**（失败不进缓存，重编后重新 require 才生效；ESM import() 的失败会被
  // 模块图缓存，重试只会拿到同一个 rejected 结果）。
  const nodeRequire = createRequire(import.meta.url);
  for (let attempt = 1; attempt <= 2 && !ok; attempt += 1) {
    try {
      const appdmg = nodeRequire("appdmg");
      ok = await new Promise((resolve) => {
        const stream = appdmg({
          target: dmgPath,
          basepath: repoRoot,
          specification: spec,
        });
        stream.on("progress", (info) => {
          if (info.current != null) {
            process.stdout.write(
              `\r[collect] appdmg ${info.current}/${info.total ?? "?"}`,
            );
          }
        });
        stream.on("finish", () => {
          process.stdout.write("\n");
          resolve(true);
        });
        stream.on("error", (error) => {
          process.stdout.write("\n");
          console.error(`[collect] appdmg 失败：${error.message ?? error}`);
          resolve(false);
        });
      });
    } catch (error) {
      console.error(
        `[collect] appdmg 加载/运行失败：${error.message ?? error}`,
      );
    }
    if (!ok && attempt === 1) rebuildNativeDeps();
  }

  if (!ok) {
    // 兜底：hdiutil 出无布局镜像（背景/图标位缺失但完全可用）
    console.log("[collect] 回落 hdiutil（无拖拽布局）…");
    // 不再写死 `-size 2g`：`-srcfolder` + UDZO 本来就按内容定尺，14GB 盘的 CI runner
    // 上多预分配 2GB 只是白吃空间。
    const hdiutil = spawnSync(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "KenFutWork",
        "-fs",
        "HFS+",
        "-srcfolder",
        appDir,
        "-ov",
        "-format",
        "UDZO",
        dmgPath,
      ],
      { stdio: "inherit" },
    );
    if (hdiutil.status !== 0) {
      console.error("[collect] hdiutil 创建 DMG 也失败");
      process.exit(hdiutil.status ?? 1);
    }
    dmgLayout = "hdiutil";
  } else if (!dmgLayout) {
    dmgLayout = "appdmg";
  }

  const sizeMb = (statSync(dmgPath).size / 1024 / 1024).toFixed(1);
  console.log(
    `[collect] DMG 已在项目根：${dmgPath}（${sizeMb} MB，布局引擎=${dmgLayout}）`,
  );

  // .app 另出一份 zip：macOS 只对带 `com.apple.quarantine` 的产物走 Gatekeeper，浏览器下载
  // 会写这个属性、`curl -LO` 不写。未公证这版给测试者留一条免弹窗的取包路径。
  const zipPath = join(repoRoot, `KenFutWork_${version}_${process.arch}.zip`);
  rmSync(zipPath, { force: true });
  const zip = spawnSync(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
    { stdio: "inherit" },
  );
  const artifacts = [dmgPath];
  if (zip.status === 0 && existsSync(zipPath)) {
    console.log(
      `[collect] .app 已压成 zip：${zipPath}（curl 取用不写 quarantine，不会被 Gatekeeper 拦）`,
    );
    artifacts.push(zipPath);
  } else {
    console.warn("[collect] zip 产出失败（DMG 仍在，清单里如实少一项产物）");
  }

  // 逐 Mach-O 封印计数：`codesign --verify --deep` 通过**证明不了** Resources 下那批散装
  // 可执行体已封印；这批读数同时是将来上公证的第一手靶子（libjvm / libvips 就在这里被
  // 库校验杀掉）。读数进清单，不靠人回忆。
  const macho = verifyMachOFiles(findMachOFiles(appPath));
  const display = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=2", appPath],
    { encoding: "utf8" },
  );
  const signingStatus = classifyCodesignDisplay(
    `${display.stdout ?? ""}${display.stderr ?? ""}`,
  );
  writeDistManifest(
    repoRoot,
    buildDistManifest({
      root: repoRoot,
      version,
      platform: "darwin",
      commit: readGitValue(["GITHUB_SHA"], ["rev-parse", "HEAD"]),
      ref: readGitValue(
        ["GITHUB_REF_NAME"],
        ["rev-parse", "--abbrev-ref", "HEAD"],
      ),
      build: readBuildTooling(repoRoot),
      runtimeVersions: readRuntimeVersions(),
      signing: {
        status: signingStatus,
        provider:
          signingStatus === "adhoc"
            ? "adhoc"
            : signingStatus === "unsigned"
              ? "none"
              : "unknown",
      },
      macos: { dmgLayout, ...macho },
      artifacts,
    }),
  );
} else {
  console.log("[collect] 该平台没有安装包产物，跳过收集。");
}
