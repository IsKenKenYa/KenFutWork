//! 右栏浏览器的**真内核**嵌入（多端计划里的「桌面形态原生 WebView」，用户口径「路线 2」）。
//!
//! 为什么要有它：Web 形态下面板里的页面只能挂在 `iframe` 上——站点不让嵌（X-Frame-Options /
//! CSP）就白屏，而且**浏览器不允许给 iframe 单独挂调试器**。桌面形态可以嵌一个**真 WebView2**
//! （Chromium 内核）：嵌入限制不存在，调试控制台也能直接注入进页面（`browser_embed_console`）。
//!
//! 形态：主窗口里的**子 webview**（Tauri 的多 webview，需 `unstable` feature）。子 webview 是
//! 独立的一层，不随网页滚动/裁剪，所以**边界必须由前端同步**（`browser_embed_bounds`）：前端在
//! 自己的面板里留一个占位块，把 `getBoundingClientRect()` 发过来，这里照着摆。
//!
//! 生命周期：跟着面板走——面板收起/切标签/离开会话时调 `browser_embed_close()`（不是只隐藏，
//! 免得后台还在跑页面）。同一时刻只保留一个嵌入实例（右栏浏览器面板就一个）。

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
  LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl, Window,
};

/// 子 webview 的标签（固定：只保留一个嵌入实例）。
const EMBED_LABEL: &str = "browser-embed";

/// 子 webview 的句柄托管状态（`None` = 没开）。
#[derive(Default)]
struct EmbedState(Mutex<Option<tauri::Webview>>);

#[derive(Debug, Deserialize)]
pub struct EmbedBounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl EmbedBounds {
  fn clamped(&self) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    // 尺寸下限与 CSS 侧一致：0 宽高的 webview 在 WebView2 上会直接报错
    (
      LogicalPosition::new(self.x.max(0.0), self.y.max(0.0)),
      LogicalSize::new(self.width.max(1.0), self.height.max(1.0)),
    )
  }
}

fn main_window(app: &tauri::AppHandle) -> Result<Window, String> {
  app
    .get_window("main")
    .ok_or_else(|| "找不到主窗口（桌面壳应在 tauri.conf.json 里声明 main）".to_string())
}

/// 打开（或换址）嵌入的浏览器：已存在就导航过去并挪到新位置。
#[tauri::command]
fn browser_embed_open(
  app: tauri::AppHandle,
  state: tauri::State<'_, EmbedState>,
  url: String,
  bounds: EmbedBounds,
) -> Result<(), String> {
  let window = main_window(&app)?;
  let (position, size) = bounds.clamped();
  let parsed = url
    .parse::<tauri::Url>()
    .map_err(|error| format!("网址不合法：{error}"))?;

  let mut guard = state.0.lock().map_err(|_| "嵌入状态锁失败".to_string())?;
  if let Some(existing) = guard.as_ref() {
    existing
      .navigate(parsed)
      .map_err(|error| format!("导航失败：{error}"))?;
    existing
      .set_position(position)
      .map_err(|error| format!("调整位置失败：{error}"))?;
    existing
      .set_size(size)
      .map_err(|error| format!("调整尺寸失败：{error}"))?;
    existing.show().map_err(|error| format!("显示失败：{error}"))?;
    return Ok(());
  }

  let webview = window
    .add_child(
      WebviewBuilder::new(EMBED_LABEL, WebviewUrl::External(parsed)),
      position,
      size,
    )
    .map_err(|error| format!("创建子 webview 失败：{error}"))?;
  *guard = Some(webview);
  Ok(())
}

/// 同步边界：前端占位块的 `getBoundingClientRect()` 变了就调它（滚轮/拖面板/切标签都算）。
#[tauri::command]
fn browser_embed_bounds(
  state: tauri::State<'_, EmbedState>,
  bounds: EmbedBounds,
) -> Result<(), String> {
  let guard = state.0.lock().map_err(|_| "嵌入状态锁失败".to_string())?;
  let Some(webview) = guard.as_ref() else {
    return Ok(()); // 还没开：忽略
  };
  let (position, size) = bounds.clamped();
  webview
    .set_position(position)
    .map_err(|error| format!("调整位置失败：{error}"))?;
  webview
    .set_size(size)
    .map_err(|error| format!("调整尺寸失败：{error}"))?;
  Ok(())
}

/// 显隐：面板收起/切标签时隐藏（隐藏比销毁便宜；真要离开就 `close`）。
#[tauri::command]
fn browser_embed_visible(
  state: tauri::State<'_, EmbedState>,
  visible: bool,
) -> Result<(), String> {
  let guard = state.0.lock().map_err(|_| "嵌入状态锁失败".to_string())?;
  let Some(webview) = guard.as_ref() else {
    return Ok(());
  };
  if visible {
    webview.show().map_err(|error| format!("显示失败：{error}"))?;
  } else {
    webview.hide().map_err(|error| format!("隐藏失败：{error}"))?;
  }
  Ok(())
}

/// **打开调试工具**——往嵌入的页面里注入调试控制台（Eruda）。
///
/// 脚本由前端传进来（`@kenfutwork/shared` 的 `DEBUG_CONSOLE_LOADER`，与 Web 形态服务端注入的
/// 是同一份）。**不另开窗口**：控制台浮在页面底部，面板里直接就能看到（用户口径如此）。
#[tauri::command]
fn browser_embed_console(
  state: tauri::State<'_, EmbedState>,
  script: String,
) -> Result<(), String> {
  let guard = state.0.lock().map_err(|_| "嵌入状态锁失败".to_string())?;
  let webview = guard
    .as_ref()
    .ok_or_else(|| "还没有嵌入页面：先在右栏浏览器打开一个网址。".to_string())?;
  webview
    .eval(script)
    .map_err(|error| format!("注入调试控制台失败：{error}"))
}

/// 关掉嵌入实例（离开面板/换会话时调，别让页面在后台一直跑）。
#[tauri::command]
fn browser_embed_close(state: tauri::State<'_, EmbedState>) -> Result<(), String> {
  let mut guard = state.0.lock().map_err(|_| "嵌入状态锁失败".to_string())?;
  if let Some(webview) = guard.take() {
    webview
      .close()
      .map_err(|error| format!("关闭嵌入页面失败：{error}"))?;
  }
  Ok(())
}

/// 挂上嵌入相关的命令（`generate_handler!` 不能在泛型上下文里展开，故固定 Wry 运行时）。
pub fn register_embed_commands(
  builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
  builder
    .manage(EmbedState::default())
    .invoke_handler(tauri::generate_handler![
      browser_embed_open,
      browser_embed_bounds,
      browser_embed_visible,
      browser_embed_console,
      browser_embed_close
    ])
}
