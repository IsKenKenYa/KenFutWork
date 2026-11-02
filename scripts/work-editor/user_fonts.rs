//! 宿主编排的用户字体：页面启动时从同源 `fonts/manifest.txt` 读取清单，把每个字体文件
//! 下载下来交给编辑器的字体库注册。
//!
//! 为什么需要：编辑器是 WASM + WebGPU 自绘界面，**读不到系统字体**，只能用包内嵌的或
//! 站点同源提供的。宿主（KenFutWork）在 Work 引擎页让用户上传 ttf/otf，落到实例数据
//! 目录后由主页面的 `/api/work/host/editors/<id>/fonts/manifest.txt` 暴露——本模块就是
//! 把那份清单变成真正的字形。
//!
//! 清单格式沿用 craft-fonts：`family | style | file | scripts | licence | licence file | sha256 | source`，
//! `file` 相对站点根。缺清单（404）等于没有用户字体，静默跳过。

use wasm_bindgen::JsCast as _;
use wasm_bindgen_futures::JsFuture;

const MANIFEST_URL: &str = "fonts/manifest.txt";

/// 拉取并注册全部用户字体，返回成功注册的字体个数。
pub async fn install<F>(mut add_font: F) -> usize
where
    F: FnMut(Vec<u8>) -> usize,
{
    let Some(paths) = manifest_files().await else {
        return 0;
    };
    let mut installed = 0;
    for path in paths {
        let Some(bytes) = fetch_bytes(&path).await else {
            log::warn!("user font {path}: download failed");
            continue;
        };
        let count = add_font(bytes);
        if count == 0 {
            log::warn!("user font {path}: no face registered (unreadable or already present)");
        }
        installed += 1;
    }
    installed
}

/// 清单里的字体文件路径（只接受站内相对路径，拒绝绝对路径与 `..`）。
async fn manifest_files() -> Option<Vec<String>> {
    let text = fetch_text(MANIFEST_URL).await?;
    let mut files = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split(" | ").map(str::trim).collect();
        let Some(file) = fields.get(2) else { continue };
        if file.is_empty() || file.starts_with('/') || file.contains("..") || file.contains('\\') {
            continue;
        }
        files.push((*file).to_string());
    }
    (files.len() > 0).then_some(files)
}

fn window() -> Option<web_sys::Window> {
    web_sys::window()
}

async fn fetch_text(url: &str) -> Option<String> {
    let text = fetch(url).await?.text().ok()?;
    JsFuture::from(text).await.ok()?.as_string()
}

async fn fetch_bytes(url: &str) -> Option<Vec<u8>> {
    let buffer = fetch(url).await?.array_buffer().ok()?;
    let value = JsFuture::from(buffer).await.ok()?;
    Some(js_sys::Uint8Array::new(&value).to_vec())
}

async fn fetch(url: &str) -> Option<web_sys::Response> {
    let promise = window()?.fetch_with_str(url);
    let value = JsFuture::from(promise).await.ok()?;
    let response: web_sys::Response = value.dyn_into().ok()?;
    response.ok().then_some(response)
}
