#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * 构建「中文 Work 编辑器」web 包（自建，因上游 web 构建不内嵌 CJK 字形）。
 *
 * 背景（2026-10-27 实测）：ArtCraft 系列编辑器是 WASM + WebGPU 自绘 UI，**不读浏览器/
 * 系统字体**，只能用包里自带的字形。上游 web 构建把简体中文字体（`craft-fonts` 的
 * LXGW WenKai Lite）**主动排除**（native-only），所以中文界面整片方框；宿主只能钉英文
 * 规避。ZCode 的做法是自打 `default-chinese.patch` 重建 —— 本脚本做同样的事，但补丁
 * 只有两处、可复现，不依赖任何私有分包。
 *
 * 两处补丁：
 *   1) `crates/ui-egui/src/craft_fonts_policy.rs`：`WEB_ALLOWED` 加 `LXGW WenKai Lite/Regular`；
 *   2) `crates/ui-egui/build.rs`：wasm 目标也读取 `fonts/simplified-chinese-manifest.txt`。
 *
 * 前置：rustup target `wasm32-unknown-unknown`、`trunk`（0.22+）、`CRAFT_FONTS_DIR`
 * 指向 craft-fonts 检出（含 `fonts/lxgw-wenkai-lite/*.ttf`）。
 *
 * 用法：
 *   node scripts/build-work-editor-zh.mjs --app gridcraft \
 *     --source D:/build/gridcraft --fonts D:/build/craft-fonts --out D:/build/out
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const app = argOf("app");
const source = argOf("source") ? resolve(argOf("source")) : undefined;
const fonts = argOf("fonts") ? resolve(argOf("fonts")) : undefined;
const i18nDir = argOf("i18n") ? resolve(argOf("i18n")) : undefined;
const outDir = argOf("out")
  ? resolve(argOf("out"))
  : join(process.cwd(), "tmp", "work-editor-zh");
if (!app || !source || !fonts)
  throw new Error(
    "用法：--app <id> --source <上游检出> --fonts <craft-fonts 检出> [--out <目录>]",
  );

const APP_CRATE = {
  gridcraft: "apps/gridcraft-web",
  wordcraft: "apps/wordcraft-web",
  deckcraft: "apps/deckcraft-web",
  designcraft: "apps/designcraft-web",
  effectcraft: "apps/effectcraft-web",
  filmcraft: "apps/filmcraft-web",
  vectorcraft: "apps/vectorcraft-web",
  photocraft: "apps/photocraft-web",
  cadcraft: "apps/cadcraft-web",
  pdfcraft: "apps/pdfcraft-web",
  soundcraft: "apps/soundcraft-web",
};
const crate = APP_CRATE[app];
if (!crate) throw new Error(`未登记该编辑器的 web 构建入口：${app}`);

const read = (path) => readFileSync(path, "utf8");
const eol = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * 每个编辑器放行 web 简体中文字形的锚点不同（上游把这处逻辑放在
 * `ui-egui/craft_fonts_policy.rs` 或 `crates/<x>/build.rs`）。三态判定：
 * 锚点命中→改写；已含 `applied`（说明此前补过，允许与首次改写的排版不同）→跳过；
 * 两者都没有→上游改结构，报错要人工核对。
 */
function patchOnce(path, from, to, label, applied = to) {
  const text = read(path);
  if (text.includes(from)) {
    writeFileSync(path, text.replace(from, to));
    console.log(`[zh] ${label}：${path}`);
    return;
  }
  if (text.includes(applied)) return;
  throw new Error(`补丁锚点不存在（${path}）——上游已改结构，需人工核对`);
}

// 1) ui-egui/craft_fonts_policy.rs 型（gridcraft / wordcraft）
const policyPath = join(source, "crates/ui-egui/src/craft_fonts_policy.rs");
if (existsSync(policyPath)) {
  const nl = eol(read(policyPath));
  const allowed = "pub const WEB_ALLOWED: &[(&str, &str)] = &[";
  patchOnce(
    policyPath,
    allowed,
    `${allowed}${nl}    // KenFutWork: web 构建同样内嵌简体中文（OFL，LXGW WenKai Lite）。${nl}    ("LXGW WenKai Lite", "Regular"),`,
    "已放开 WEB_ALLOWED",
  );
}

// 2) wasm 也读简体中文 manifest（仅 gridcraft/wordcraft 把字体表建在 ui-egui）
const buildPath = join(source, "crates/ui-egui/build.rs");
const uiEguiChinese =
  "let chinese = if wasm { Vec::new() } else { chinese_font_rows(dir, required)? };";
if (existsSync(buildPath) && read(buildPath).includes(uiEguiChinese)) {
  patchOnce(
    buildPath,
    uiEguiChinese,
    "let chinese = chinese_font_rows(dir, required)?;",
    "已让 wasm 读取简体中文 manifest",
  );
}

// 2b) 用户字体：每个 web 壳在启动时读同源 `fonts/manifest.txt`，把宿主上传的字体交给
//     各自的字体库。`user_fonts.rs` 是一份同构实现，各编辑器的注册点不同（见下表）。
const USER_FONT_HOOKS = {
  deckcraft: ["apps/deckcraft-web/src/user_fonts.rs", "deckcraft_fonts::FontDb::global().add_font(bytes)"],
  wordcraft: [
    "apps/wordcraft-web/src/web/user_fonts.rs",
    'wordcraft_fonts::FontDb::global().install_font(&format!("host-font-{}", bytes.len()), &bytes).is_ok() as usize',
  ],
  designcraft: ["apps/designcraft-web/src/user_fonts.rs", "designcraft_fonts::FontDb::global().add_font(bytes)"],
  effectcraft: ["apps/effectcraft-web/src/user_fonts.rs", "effectcraft_text::fonts::add_font_data(bytes).len()"],
  filmcraft: ["apps/filmcraft-web/src/user_fonts.rs", "filmcraft_text::fonts::add_font_data(bytes).len()"],
  vectorcraft: ["apps/vectorcraft-web/src/user_fonts.rs", "vectorcraft_text::FontDb::global().add_font(bytes)"],
  gridcraft: [
    "apps/gridcraft-web/src/user_fonts.rs",
    'gridcraft_ui_egui::fonts::add_font_bytes(&format!("host-{}", bytes.len()), bytes)',
  ],
  cadcraft: [
    "apps/cadcraft-web/src/user_fonts.rs",
    'if cadcraft_fonts::ttf::register_family_font(bytes).is_empty() { 0 } else { 1 }',
  ],
};
const userFontsSource = resolve(import.meta.dirname, "work-editor/user_fonts.rs");
const hook = USER_FONT_HOOKS[app];
if (hook && existsSync(userFontsSource)) {
  cpSync(userFontsSource, join(source, hook[0]));
  console.log(`[zh] 已放置用户字体加载器：${hook[0]}`);
}
// 有些编辑器的字体目录是「扫描到的系统字体」模型，wasm 端没有字库：用随仓库的补丁加入
// 内存字形表与启动时的清单加载（`git apply` 幂等，已打则跳过）。
const USER_FONT_PATCHES = {
  gridcraft: "work-editor/gridcraft-user-fonts.patch",
  cadcraft: "work-editor/cadcraft-user-fonts.patch",
};
if (USER_FONT_PATCHES[app]) {
  const patchFile = resolve(import.meta.dirname, USER_FONT_PATCHES[app]);
  try {
    execFileSync("git", ["apply", "--check", patchFile], { cwd: source, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: source, stdio: "inherit" });
    console.log(`[zh] 已应用 ${app} 用户字体补丁`);
  } catch {
    console.log(`[zh] ${app} 用户字体补丁已应用，跳过`);
  }
}

// 3) 其余编辑器的字体放行（每个上游写法不同，逐条幂等替换）
const ZERO_PATCHES = {
  deckcraft: [
    [
      "crates/fonts/build.rs",
      'if wasm && !matches!((*family, *style), ("BIZ UDPGothic", "Regular") | ("Inter", "Regular" | "Bold" | "Variable")) {',
      'let chinese = scripts.split(\',\').any(|s| matches!(s.trim(), "Hani" | "Hans"));\n        if wasm && !chinese && !matches!((*family, *style), ("BIZ UDPGothic", "Regular") | ("Inter", "Regular" | "Bold" | "Variable")) {',
    ],
  ],
  cadcraft: [
    [
      "crates/fonts/build.rs",
      'let web_face = (*family == "BIZ UDPGothic" && *style == "Regular") || arabic;',
      'let web_face = (*family == "BIZ UDPGothic" && *style == "Regular") || arabic || scripts.split(',
      ').any(|s| matches!(s.trim(), "Hani" | "Hans"));',
    ],
  ],
  filmcraft: [
    [
      "crates/text/build.rs",
      'if wasm && !(*family == "BIZ UDPGothic" && *style == "Regular") {',
      'if wasm && !((*family == "BIZ UDPGothic" && *style == "Regular") || scripts.split(\',\').any(|s| matches!(s.trim(), "Hani" | "Hans"))) {',
    ],
  ],
  vectorcraft: [
    [
      "crates/text/build.rs",
      "if wasm && !(*family == WEB_FONT.0 && *style == WEB_FONT.1) {",
      'if wasm && !((*family == WEB_FONT.0 && *style == WEB_FONT.1) || scripts.split(\',\').any(|s| matches!(s.trim(), "Hani" | "Hans"))) {',
    ],
    // WEB_FONTS 从简体中文 manifest 取 LXGW，但 Trunk 的字体拷贝钩子只读 fonts/manifest.txt：
    // 补上同一来源，否则运行时 404（SRI 校验失败，中文缺字）。
    [
      "xtask/src/web_fonts.rs",
      `    let manifest = read(&dir.join("fonts/manifest.txt"))?;
    let rows: Vec<Vec<&str>> =
        manifest.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(|l| l.split(" | ").map(str::trim).collect()).collect();`,
      `    let manifest = read(&dir.join("fonts/manifest.txt"))?;
    let chinese = read(&dir.join("fonts/simplified-chinese-manifest.txt")).unwrap_or_default();
    let mut rows: Vec<Vec<&str>> =
        manifest.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(|l| l.split(" | ").map(str::trim).collect()).collect();
    rows.extend(chinese.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(|l| l.split(" | ").map(str::trim).collect::<Vec<_>>()));`,
      'fonts/simplified-chinese-manifest.txt")).unwrap_or_default()',
    ],
  ],
};
for (const [file, from, to, already] of ZERO_PATCHES[app] ?? []) {
  patchOnce(join(source, file), from, to, "已放行 CJK", already ?? to);
}

// 3) 构建：多数编辑器用 trunk（站点产物在 <repo>/dist/web）；EffectCraft 与 FilmCraft
//    没有 index.html，用自家的 `cargo xtask web`（wasm-bindgen 直出到 <target>/web/dist）。
const XTASK_APPS = new Set(["effectcraft", "filmcraft"]);
const cwd = join(source, crate);
if (!existsSync(cwd)) throw new Error(`找不到 web 构建目录：${cwd}`);
console.log(`[zh] 构建 ${app} …（首次编译约 6 分钟）`);
const buildEnv = {
  ...process.env,
  CRAFT_FONTS_DIR: fonts,
  ...(i18nDir ? { CRAFT_I18N_DIR: i18nDir } : {}),
};
if (XTASK_APPS.has(app)) {
  execFileSync("cargo", ["xtask", "web"], { cwd: source, stdio: "inherit", env: buildEnv });
} else {
  execFileSync(
    "trunk",
    ["build", "--release", "--locked", "--skip-version-check", "--color", "never"],
    { cwd, stdio: "inherit", env: buildEnv },
  );
}

// 4) 收集产物
const dist = XTASK_APPS.has(app)
  ? join(source, "target", "web", "dist")
  : join(source, "dist/web");
if (!existsSync(dist)) throw new Error(`构建成功但没有产物目录：${dist}`);
const target = join(outDir, app);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of readdirSync(dist)) {
  if (entry === ".trunk-lock") continue;
  cpSync(join(dist, entry), join(target, entry), { recursive: true });
}
// 自建中文包标记：安装器据此拒绝被官方英文包覆盖（见 features/work/install.ts）。
writeFileSync(
  join(target, ".kenfutwork-zh-build.json"),
  `${JSON.stringify({ app, kind: "kenfutwork-zh", font: "craft-fonts", builtAt: new Date().toISOString() }, null, 2)}
`,
);
const wasm = readdirSync(target).find((name) => name.endsWith("_bg.wasm"));
if (!wasm) throw new Error("产物缺少 wasm");
console.log(
  `[zh] 完成：${target}（${wasm}，${(readFileSync(join(target, wasm)).length / 1048576).toFixed(1)}MB，含中文字体）`,
);
