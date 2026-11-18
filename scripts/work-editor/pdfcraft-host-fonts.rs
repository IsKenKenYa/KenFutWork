//! 宿主上传的用户字体（Work 引擎页）：同源 `fonts/manifest.txt` →（家族名, 字体字节）。
//!
//! 为什么需要：PdfCraft 的字形来自「文档内嵌字体」，界面字体列表也只看文档资源；宿主的
//! 用户字体库要能进「格式文本」的字体下拉，就得先把清单和文件拉下来。缺清单（404）等于
//! 没有用户字体，返回空表——非 Work 宿主的页面不受影响。

use wasm_bindgen::JsCast as _;
use wasm_bindgen_futures::JsFuture;

const MANIFEST_URL: &str = "fonts/manifest.txt";

/// 拉取全部用户字体；任一步失败只跳过该条，返回实际拿到的 (家族名, 字节)。
pub(crate) async fn fetch_host_fonts() -> Vec<(String, Vec<u8>)> {
    let Some(rows) = manifest_rows().await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (family, path) in rows {
        let Some(bytes) = fetch_bytes(&path).await else {
            log::warn!("user font {path}: download failed");
            continue;
        };
        out.push((family, bytes));
    }
    out
}

/// 清单里的 (家族名, 字体文件路径)；只接受站内相对路径。
async fn manifest_rows() -> Option<Vec<(String, String)>> {
    let text = fetch_text(MANIFEST_URL).await?;
    let mut rows = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split(" | ").map(str::trim).collect();
        let (Some(family), Some(file)) = (fields.first(), fields.get(2)) else { continue };
        if family.is_empty() || file.is_empty() || file.starts_with('/') || file.contains("..") || file.contains('\\') {
            continue;
        }
        rows.push(((*family).to_string(), (*file).to_string()));
    }
    (!rows.is_empty()).then_some(rows)
}

async fn fetch_text(url: &str) -> Option<String> {
    let text = get(url).await?.text().ok()?;
    JsFuture::from(text).await.ok()?.as_string()
}

async fn fetch_bytes(url: &str) -> Option<Vec<u8>> {
    let buffer = get(url).await?.array_buffer().ok()?;
    let value = JsFuture::from(buffer).await.ok()?;
    Some(js_sys::Uint8Array::new(&value).to_vec())
}

async fn get(url: &str) -> Option<web_sys::Response> {
    let promise = web_sys::window()?.fetch_with_str(url);
    let value = JsFuture::from(promise).await.ok()?;
    let response: web_sys::Response = value.dyn_into().ok()?;
    response.ok().then_some(response)
}
