//! 桌面壳的**系统缝**：下载落盘（`save_file`）、文件管理器定位（`reveal_path`）、
//! 外链交给系统浏览器（`open_external`）。
//!
//! 为什么要有这一层：macOS 壳的内核是 WKWebView——`<a download>` 点了毫无反应，
//! `target="_blank"` 开不了新窗口；同一份 Web 代码在浏览器里都好好的，进壳就「没反应」。
//! 约定：前端拿好字节（blob/dataURL 都行）→ `save_file` 落系统下载目录 → `reveal_path`
//! 定位过去（即用户口径的「打开访达窗口」，也是下载成功的唯一可见反馈）；外链统一
//! `open_external` 交给系统默认浏览器。
//!
//! 安全口径：落点**固定**系统下载目录（不接受前端传目标路径）；文件名只留末段并清洗
//! 分隔符/控制字符；外链只接受 http/https——防页面被劫持时借壳写任意位置或唤起协议处理器。

use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::Manager;

/// 清洗前端传来的文件名：先按路径分隔符取**末段**（防 `../` 穿越），再剥控制字符；
/// 空名/纯点号兜底；超长截断（下载目录的文件名没必要超 120 字符）。
pub fn sanitize_filename(raw: &str) -> String {
    let last_segment = raw.rsplit(['/', '\\', ':']).next().unwrap_or(raw);
    let name: String = last_segment.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim().trim_start_matches('.');
    if name.is_empty() {
        return "download".into();
    }
    if name.chars().count() <= 120 {
        return name.to_string();
    }
    name.chars().take(120).collect()
}

/// 重名自动顺延：`a.png` → `a (1).png`（stem 加序号，扩展名保留）——
/// 与 Safari/Chrome 下载同一条用户习惯，不静默覆盖已有文件。
pub fn dedupe_download_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    for index in 1..10_000u32 {
        let indexed = dir.join(format!("{stem} ({index}){ext}"));
        if !indexed.exists() {
            return indexed;
        }
    }
    dir.join(format!("{stem} (many){ext}"))
}

/// 外链白名单：只放 http/https（`file:`、自定义 scheme、`javascript:` 一律不交给系统）。
pub fn validate_external_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(());
    }
    Err(format!("只允许打开 http/https 外链，收到：{url}"))
}

/// 下载落盘：base64 字节 → 系统下载目录（重名顺延）。返回最终绝对路径（前端拿它定位）。
#[tauri::command]
fn save_file(
    app: tauri::AppHandle,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("无法定位系统下载目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("下载数据不是合法的 base64：{error}"))?;
    let path = dedupe_download_path(&dir, &sanitize_filename(&name));
    std::fs::write(&path, bytes)
        .map_err(|error| format!("写入下载文件失败（{}）：{error}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// 在系统文件管理器里定位文件（macOS Finder / Windows 资源管理器 / Linux 桌面）。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    #[cfg(target_os = "macos")]
    let (command, args): (&str, Vec<String>) = ("open", vec!["-R".into(), path]);
    #[cfg(target_os = "windows")]
    let (command, args): (&str, Vec<String>) = ("explorer", vec![format!("/select,{path}")]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (command, args): (&str, Vec<String>) = (
        "xdg-open",
        vec![target
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or(path)],
    );
    std::process::Command::new(command)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开系统文件管理器失败：{error}"))
}

/// 外链交给系统默认浏览器（WKWebView 里 `target="_blank"` 开不了新窗口）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    let (command, args): (&str, Vec<String>) = ("open", vec![url]);
    #[cfg(target_os = "windows")]
    // `start` 的第一个带引号参数是窗口标题，占位空串，否则 URL 会被当标题吞掉
    let (command, args): (&str, Vec<String>) =
        ("cmd", vec!["/C".into(), "start".into(), String::new(), url]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (command, args): (&str, Vec<String>) = ("xdg-open", vec![url]);
    std::process::Command::new(command)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开系统浏览器失败：{error}"))
}

/// 挂上系统缝命令（`generate_handler!` 不能在泛型上下文里展开，故固定 Wry 运行时；
/// Tauri 2 的 `invoke_handler` 按注册顺序链式尝试，不会顶掉 ping / browser_embed）。
pub fn register_system_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        save_file,
        reveal_path,
        open_external
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_paths_and_controls() {
        assert_eq!(sanitize_filename("a/b/c.png"), "c.png");
        assert_eq!(sanitize_filename("..\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("C:\\temp\\x.bin"), "x.bin");
        assert_eq!(sanitize_filename("re\u{7}port.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("  spaced  "), "spaced");
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
    }

    #[test]
    fn sanitize_filename_truncates_to_120_chars() {
        let long = "x".repeat(300);
        assert_eq!(sanitize_filename(&long).chars().count(), 120);
    }

    #[test]
    fn dedupe_keeps_unique_name_and_indexes_collisions() {
        let root = std::env::temp_dir().join(format!("kfw-dedupe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let first = dedupe_download_path(&root, "a.png");
        std::fs::write(&first, b"x").unwrap();
        let second = dedupe_download_path(&root, "a.png");
        std::fs::write(&second, b"y").unwrap();
        assert_eq!(first.file_name().unwrap(), "a.png");
        assert_eq!(second.file_name().unwrap(), "a (1).png");
        let third = dedupe_download_path(&root, "a.png");
        assert_eq!(third.file_name().unwrap(), "a (2).png");
        // 无扩展名同样顺延
        assert_eq!(
            dedupe_download_path(&root, "noext").file_name().unwrap(),
            "noext"
        );
        std::fs::write(root.join("noext"), b"w").unwrap();
        assert_eq!(
            dedupe_download_path(&root, "noext").file_name().unwrap(),
            "noext (1)"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn external_url_whitelist_only_http_https() {
        assert!(validate_external_url("https://example.com/docs").is_ok());
        assert!(validate_external_url("http://localhost:3000/x").is_ok());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("ms-settings:update").is_err());
    }
}
