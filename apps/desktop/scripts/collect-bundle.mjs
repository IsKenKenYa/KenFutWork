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
}

if (process.platform === "win32") {
  collectLatest({
    dir: join(bundleBase, "nsis"),
    suffix: "-setup.exe",
    doneMessage: "安装包已在项目根（双击即装）",
  });
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
  // tauri 的默认 ad-hoc 签名不封 Resources（verify 报 "code has no resources"）——
  // 深签一遍把 Resources/seal 补上（ad-hoc 身份，本机可开；对外分发需 Developer ID + 公证）。
  const resign = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" },
  );
  if (resign.status !== 0) {
    console.error("[collect] 深签名失败");
    process.exit(resign.status ?? 1);
  }
  const version = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  ).version;
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
  let ok = false;
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
    const hdiutil = spawnSync(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "KenFutWork",
        "-size",
        "2g",
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
  }
  const sizeMb = (statSync(dmgPath).size / 1024 / 1024).toFixed(1);
  console.log(
    `[collect] DMG 已在项目根：${dmgPath}（${sizeMb} MB，挂载后拖入 Applications）`,
  );
} else {
  console.log("[collect] 该平台没有安装包产物，跳过收集。");
}
