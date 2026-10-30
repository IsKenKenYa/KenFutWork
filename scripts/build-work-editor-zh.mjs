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
 * 中文文案：WordCraft 的界面译文由 craft-i18n 提供，**必须**传 `--i18n`（指向 craft-i18n
 * 检出根目录，不是它的 `locales/` 子目录）——不传则 CRAFT_I18N 为空表，界面仍然全英文
 * （实测：漏传时菜单是 Home/New/Open，传对后是 开始/新建/打开）。
 *
 * 用法：
 *   node scripts/build-work-editor-zh.mjs --app gridcraft \
 *     --source D:/build/gridcraft --fonts D:/build/craft-fonts --out D:/build/out
 *   node scripts/build-work-editor-zh.mjs --app wordcraft \
 *     --source D:/build/wordcraft --fonts D:/build/craft-fonts \
 *     --i18n D:/build/craft-i18n --out D:/build/out
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
    "用法：--app <id> --source <上游检出> --fonts <craft-fonts 检出> [--i18n <craft-i18n 检出>] [--out <目录>]",
  );
// WordCraft 的界面译文只来自 craft-i18n：漏传会静默得到「中文字形 + 英文文案」的包。
if (app === "wordcraft" && !i18nDir)
  throw new Error(
    "wordcraft 需要 --i18n <craft-i18n 检出根目录>：不传则 CRAFT_I18N 为空表，界面仍然全英文。",
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
  const nl = eol(text);
  // Windows 克隆出来的源码是 CRLF：锚点按 LF 写，匹配前统一换行，写回再按原风格还原。
  const lf = (value) => value.replace(/\r\n/g, "\n");
  const textLf = lf(text);
  const fromLf = lf(from);
  if (textLf.includes(fromLf)) {
    writeFileSync(path, textLf.replace(fromLf, lf(to)).replace(/\n/g, nl));
    console.log(`[zh] ${label}：${path}`);
    return;
  }
  if (textLf.includes(lf(applied))) return;
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

// 2) gridcraft 的 web 壳在「浏览器语言是中日韩」时**故意不走**该语言（上游没内嵌 CJK 字形，
//    怕整屏方框）；本构建已内嵌简体中文字形，这条护栏只剩「中文用户永远看英文」的副作用。
const gridCraftGuard = `                    if !matches!(
                        browser,
                        gridcraft_ui_egui::i18n::Language::Zh | gridcraft_ui_egui::i18n::Language::Ja | gridcraft_ui_egui::i18n::Language::Ko
                    ) {
                        app.ui.language = browser;
                    }`;
const gridCraftWeb = join(source, "apps/gridcraft-web/src/web.rs");
if (existsSync(gridCraftWeb)) {
  patchOnce(
    gridCraftWeb,
    gridCraftGuard,
    "                    // KenFutWork: 已内嵌简体中文字形，跟随浏览器语言（含中日韩）。\n                    app.ui.language = browser;",
    "已解除中文回退英文护栏",
  );
  // Ribbon 的字体框只列硬编码名单：宿主上传的字体注册进了字体库却选不到。
  // 同时把字体名换成中文显示（选中值仍是真实家族名，写进单元格才找得到字）。
  const ribbonHome = join(source, "crates/ui-egui/src/ribbon/home.rs");
  patchOnce(
    ribbonHome,
    "    let items: Vec<(&str, String)> = FONTS.iter().map(|f| (*f, f.to_string())).collect();",
    "    // KenFutWork: 字体库里的家族排前面（宿主上传 + 内置），再列硬编码名单；\n    // 只列硬编码名单时用户装完字体在框里找不到。\n    let installed = crate::fonts::families();\n    let mut items: Vec<(&str, String)> = Vec::new();\n    for family in &installed {\n        if FONTS.iter().any(|known| known.eq_ignore_ascii_case(family)) {\n            continue;\n        }\n        items.push((family.as_str(), font_label(family)));\n    }\n    for f in FONTS {\n        items.push((*f, f.to_string()));\n    }",
    "已让字体框列出字体库全部家族",
    "        items.push((family.as_str(), font_label(family)));",
  );
  patchOnce(
    ribbonHome,
    "    let resp = ui.add_sized([150.0, 24.0], egui::Button::new(egui::RichText::new(&name).font(theme::ui_font(12.5))));",
    "    let resp = ui.add_sized([150.0, 24.0], egui::Button::new(egui::RichText::new(font_label(&name)).font(theme::ui_font(12.5))));",
    "已让字体框显示中文名",
    "egui::RichText::new(font_label(&name))",
  );
  patchOnce(
    ribbonHome,
    "fn font_combo(app: &mut SheetApp, ui: &mut Ui, st: &Style) {",
    "/// KenFutWork: 字体下拉显示中文名；写进单元格 / 选中值仍是字体真实家族名。\nfn font_label(family: &str) -> String {\n    match family {\n        \"LXGW WenKai Lite\" => \"霞鹜文楷\",\n        \"LXGW Marker Gothic\" => \"霞鹜漫黑\",\n        \"Smiley Sans\" | \"Smiley Sans Oblique\" => \"得意黑\",\n        \"Yozai\" => \"悠哉字体\",\n        \"Ma Shan Zheng\" => \"马善政\",\n        \"ZCOOL KuaiLe\" => \"站酷快乐体\",\n        \"Noto Sans CJK SC\" => \"思源黑体\",\n        \"Noto Serif CJK SC\" => \"思源宋体\",\n        \"MiSans\" => \"小米 MiSans\",\n        \"BIZ UDMincho\" => \"BIZ UD明朝\",\n        _ => return family.to_owned(),\n    }\n    .to_owned()\n}\n\nfn font_combo(app: &mut SheetApp, ui: &mut Ui, st: &Style) {",
    "已加字体中文名映射",
    "fn font_label(family: &str) -> String {",
  );
  // 网页端「另存为」可能只拿到没有扩展名的文件名（如 “1”）：按 Excel 默认补 .xlsx，
  // 否则引擎直接报 unknown file format，用户看到的就是「保存坏了」。
  const engineFile = join(source, "crates/engine/src/cmd/file.rs");
  if (existsSync(engineFile)) {
    patchOnce(
      engineFile,
      "    let d = s.doc_mut()?;\n    // The document's own file keeps the format its content had when opened;",
      "    // KenFutWork: 没有扩展名的文件名按 .xlsx 保存，而不是报 unknown file format。\n    let path = if std::path::Path::new(&path).extension().is_none() { format!(\"{path}.xlsx\") } else { path };\n    let d = s.doc_mut()?;\n    // The document's own file keeps the format its content had when opened;",
      "已让无扩展名的保存补 .xlsx",
      "let path = if std::path::Path::new(&path).extension().is_none()",
    );
  }
  // 弹窗正文（保存/新建）上游没走 i18n，只翻了按钮：这里补中文并接到 lang.tr。
  const zhTable = join(source, "crates/ui-egui/src/i18n/zh.rs");
  if (existsSync(zhTable)) {
    patchOnce(
      zhTable,
      "        _ => return None,",
      "        \"Do you want to save the changes?\" => \"是否保存更改？\",\n        \"Don't Save\" => \"不保存\",\n        \"Cancel\" => \"取消\",\n        \"OK\" => \"确定\",\n        \"Save a copy as\" => \"另存副本\",\n        \"Start a new workbook\" => \"新建工作簿\",\n        \"Open…\" => \"打开…\",\n        _ => return None,",
      "已补中文弹窗文案",
      '"Do you want to save the changes?" => "是否保存更改？",',
    );
  }
  const dialogShow = join(source, "crates/ui-egui/src/dialogs/show.rs");
  // 网页端「另存副本」原来是自绘的文件名输入框；宿主没有文件对话框时应直接走系统选择器。
  if (existsSync(dialogShow)) {
    patchOnce(
      dialogShow,
      '                    let mut path = d.values.get("path").and_then(Json::as_str).unwrap_or("").to_string();\n                    ui.text_edit_singleline(&mut path);',
      '                    let web = app.services.pick_save.is_none() && app.services.download.is_some();\n                    let mut path = d.values.get("path").and_then(Json::as_str).unwrap_or("").to_string();\n                    if !web {\n                        ui.text_edit_singleline(&mut path);\n                    }',
      "已让网页端另存副本走系统选择器",
      "let web = app.services.pick_save.is_none() && app.services.download.is_some();",
    );
  }
  if (existsSync(dialogShow)) {
    patchOnce(
      dialogShow,
      '                    ui.label(format!("Do you want to save the changes you made to {}?", d.values.get("title").and_then(Json::as_str).unwrap_or("this workbook")));',
      '                    let lang = app.ui.language;\n                    ui.label(lang.tr("Do you want to save the changes?"));',
      "已让关闭确认弹窗走中文",
      'ui.label(lang.tr("Do you want to save the changes?"));',
    );
    patchOnce(
      dialogShow,
      '                            if ui.button(label).clicked() && app.answer_save_changes(answer, quitting, ui.ctx()) {',
      '                            if ui.button(lang.tr(label)).clicked() && app.answer_save_changes(answer, quitting, ui.ctx()) {',
      "已让关闭确认按钮走中文",
      "if ui.button(lang.tr(label)).clicked() && app.answer_save_changes",
    );
    patchOnce(
      dialogShow,
      '                    ui.label(format!("Save a copy as .{fmt}"));',
      '                    ui.label(format!("{} .{fmt}", app.ui.language.tr("Save a copy as")));',
      "已让另存副本弹窗走中文",
      'app.ui.language.tr("Save a copy as")',
    );
    patchOnce(
      dialogShow,
      '                    ui.heading("Start a new workbook");',
      '                    ui.heading(app.ui.language.tr("Start a new workbook"));',
      "已让新建弹窗标题走中文",
      'app.ui.language.tr("Start a new workbook")',
    );
  }
  // 老的英文构建会把 language=en 写进 localStorage，下次启动又被恢复成英文；那不是用户选择。
  // 浏览器明确是中文时以中文为准（界面里手动切换的档位本轮仍生效）。
  patchOnce(
    gridCraftWeb,
    "                    crate::prefs::restore(&mut app, stored_ui.as_deref(), stored_prefs.as_deref());",
    "                    crate::prefs::restore(&mut app, stored_ui.as_deref(), stored_prefs.as_deref());\n                    if app.ui.language == gridcraft_ui_egui::i18n::Language::En\n                        && browser == gridcraft_ui_egui::i18n::Language::Zh\n                    {\n                        app.ui.language = gridcraft_ui_egui::i18n::Language::Zh;\n                    }",
    "已让旧英文偏好让位于中文",
  );
}

// 2c) 照片（PhotoCraft）：网页端语言检测 + 界面中文字形 + 字体菜单中文名。
if (app === "photocraft") {
  const systemRs = join(source, "crates/ui-egui/src/i18n/system.rs");
  if (existsSync(systemRs)) {
    patchOnce(
      systemRs,
      "#[cfg(not(target_arch = \"wasm32\"))]\nconst MAX_SYSTEM_TAGS: usize = 64;\n#[cfg(not(target_arch = \"wasm32\"))]\nconst MAX_SYSTEM_TAG_BYTES: usize = 128;",
      "// KenFutWork: 网页端也要用同一套上限（浏览器语言列表）。\nconst MAX_SYSTEM_TAGS: usize = 64;\nconst MAX_SYSTEM_TAG_BYTES: usize = 128;",
      "已去掉语言上限的 native-only 门",
      "// KenFutWork: 网页端也要用同一套上限（浏览器语言列表）。",
    );
    patchOnce(
      systemRs,
      "#[cfg(not(target_arch = \"wasm32\"))]\nfn bounded_tags(",
      "fn bounded_tags(",
      "已让浏览器语言共用 bounded_tags",
      "fn bounded_tags(",
    );
    patchOnce(
      systemRs,
      "#[cfg(all(not(test), target_arch = \"wasm32\"))]\nfn detect_system_tags() -> Vec<String> {\n    Vec::new()\n}",
      "#[cfg(all(not(test), target_arch = \"wasm32\"))]\nfn detect_system_tags() -> Vec<String> {\n    // KenFutWork: 网页端没有 OS locale API，改读浏览器语言列表。\n    let mut tags = Vec::new();\n    if let Some(window) = web_sys::window() {\n        let nav = window.navigator();\n        let langs = nav.languages();\n        for i in 0..langs.length() {\n            if let Some(tag) = langs.get(i).as_string() {\n                tags.push(tag);\n            }\n        }\n        if tags.is_empty() {\n            if let Some(tag) = nav.language() {\n                tags.push(tag);\n            }\n        }\n    }\n    bounded_tags(tags)\n}",
      "已让网页端读浏览器语言",
      "let langs = nav.languages();",
    );
  }
  patchOnce(
    join(source, "crates/ui-egui/Cargo.toml"),
    "[target.'cfg(not(target_arch = \"wasm32\"))'.dependencies]\nrayon = { workspace = true }",
    "[target.'cfg(target_arch = \"wasm32\")'.dependencies]\nweb-sys = { version = \"0.3\", features = [\"Window\", \"Navigator\"] }\n\n[target.'cfg(not(target_arch = \"wasm32\"))'.dependencies]\nrayon = { workspace = true }",
    "已给 wasm 加 web-sys（浏览器语言）",
    "web-sys = { version = \"0.3\", features = [\"Window\", \"Navigator\"] }",
  );
  patchOnce(
    join(source, "crates/ui-egui/src/cjk_fonts.rs"),
    "/// The egui plugin that watches drawn text and loads fallback fonts on demand.",
    "pub fn install_ui_served_font(ctx: &egui::Context, family: &str, bytes: Vec<u8>) {\n    let name = format!(\"kfw-ui-cjk:{family}\");\n    let mut data = FontData::from_owned(bytes);\n    let families = [FontFamily::Proportional, FontFamily::Monospace]\n        .into_iter()\n        .map(|family| InsertFontFamily { family, priority: FontPriority::Lowest })\n        .collect();\n    crate::theme::size_ui_font(ctx, &name, &mut data);\n    ctx.add_font(FontInsert { name, data, families });\n    ctx.request_repaint();\n}\n\n/// The egui plugin that watches drawn text and loads fallback fonts on demand.",
    "已加界面中文字体注入",
    "pub fn install_ui_served_font(",
  );
  const typeTool = join(source, "crates/ui-egui/src/type_tool.rs");
  if (existsSync(typeTool)) {
    patchOnce(
      typeTool,
      "fn localized_families() -> Arc<HashMap<String, String>> {",
      "const KFW_FONT_LABELS: &[(&str, &str)] = &[\n    (\"LXGW WenKai Lite\", \"霞鹜文楷\"),\n    (\"LXGW Marker Gothic\", \"霞鹜漫黑\"),\n    (\"Smiley Sans\", \"得意黑\"),\n    (\"Smiley Sans Oblique\", \"得意黑\"),\n    (\"Yozai\", \"悠哉字体\"),\n    (\"Ma Shan Zheng\", \"马善政毛笔楷书\"),\n    (\"ZCOOL KuaiLe\", \"站酷快乐体\"),\n    (\"Noto Sans CJK SC\", \"思源黑体\"),\n    (\"Noto Serif CJK SC\", \"思源宋体\"),\n    (\"MiSans\", \"小米 MiSans\"),\n    (\"Sarasa Gothic SC\", \"更纱黑体\"),\n];\n\nfn localized_families() -> Arc<HashMap<String, String>> {",
      "已加字体菜单中文名表",
      "const KFW_FONT_LABELS",
    );
    patchOnce(
      typeTool,
      "    let v = Arc::new(photocraft_text::shared().lock().map(|mut e| e.fonts.localized_family_names()).unwrap_or_default());",
      "    let mut names = photocraft_text::shared().lock().map(|mut e| e.fonts.localized_family_names()).unwrap_or_default();\n    for (family, label) in KFW_FONT_LABELS {\n        match names.get(*family) {\n            Some(existing) if existing != family => {}\n            _ => {\n                names.insert((*family).to_string(), (*label).to_string());\n            }\n        }\n    }\n    let v = Arc::new(names);",
      "已用中文名表补字体菜单",
      "let mut names = photocraft_text::shared().lock()",
    );
  }
  const webRs = join(source, "apps/photocraft-web/src/web.rs");
  if (existsSync(webRs)) {
    patchOnce(
      webRs,
      "    served: Served,\n    database: Option<web_sys::IdbDatabase>,\n    presets: crate::preset_bridge::Bridge,\n}",
      "    served: Served,\n    database: Option<web_sys::IdbDatabase>,\n    presets: crate::preset_bridge::Bridge,\n    /// KenFutWork: 是否已把中文字体挂到界面字体栈。\n    ui_cjk: bool,\n}",
      "已给 WebShell 加中文字体标记",
      "ui_cjk: bool,",
    );
    patchOnce(
      webRs,
      "Ok(Box::new(WebShell { app, inbox, place_inbox, unsaved, served, database, presets }))",
      "Ok(Box::new(WebShell { app, inbox, place_inbox, unsaved, served, database, presets, ui_cjk: false }))",
      "已初始化中文字体标记",
      "ui_cjk: false",
    );
    patchOnce(
      webRs,
      "        served_fonts::install(&mut self.app, arrived);",
      "        if !self.ui_cjk && let Some((family, bytes)) = arrived.iter().find(|(family, _)| family.contains(\"CJK\") || family.chars().any(|c| c as u32 >= 0x2E80)) {\n            photocraft_ui_egui::cjk_fonts::install_ui_served_font(ctx, family, bytes.clone());\n            self.ui_cjk = true;\n        }\n        served_fonts::install(&mut self.app, arrived);",
      "已在字体送达时挂界面中文字体",
      "install_ui_served_font(ctx, family, bytes.clone())",
    );
  }
}

// 3) wasm 也读简体中文 manifest（仅 gridcraft/wordcraft 把字体表建在 ui-egui）
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
  pdfcraft: "work-editor/pdfcraft-user-fonts.patch",
  designcraft: "work-editor/designcraft-locale.patch",
  photocraft: "work-editor/photocraft-locale.patch",
};
if (USER_FONT_PATCHES[app]) {
  // PdfCraft 的清单抓取放在 ui-egui 内（不是 web 壳），先把这个新文件放到位再打补丁。
  if (app === "pdfcraft") {
    cpSync(resolve(import.meta.dirname, "work-editor/pdfcraft-host-fonts.rs"), join(source, "crates/ui-egui/src/host_font_fetch.rs"));
  }
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

// 4) 构建：多数编辑器用 trunk（站点产物在 <repo>/dist/web）；EffectCraft 与 FilmCraft
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
