//! 快捷键录制态：录制时临时收掉原生菜单。
//!
//! 为什么需要：macOS 的系统菜单项（Cmd+W / Cmd+Q 等）由 WebView 外层消费，
//! 页面里的录制监听拿不到按键就被系统动作抢走。原 Electron 宿主用
//! `setShortcutRecordingActive` 做同一件事（通知主进程释放菜单快捷键），
//! 这里落到 Tauri 菜单层：录制开始 remove_menu，结束恢复默认菜单。
//!
//! 只影响**原生菜单**；页面内的应用快捷键由 `shortcuts/bindings` 的录制标记短路，
//! 两处都开着才算完整接管。

use std::sync::Mutex;

use tauri::menu::Menu;

#[derive(Default)]
pub struct ShortcutRecordingState(Mutex<bool>);

pub fn register_shortcut_commands(
  builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
  builder.manage(ShortcutRecordingState::default())
}

#[tauri::command]
pub fn set_shortcut_recording_active(
  app: tauri::AppHandle,
  state: tauri::State<'_, ShortcutRecordingState>,
  active: bool,
) -> Result<(), String> {
  let mut recording = state
    .0
    .lock()
    .map_err(|_| "快捷键录制状态锁失败".to_string())?;
  if *recording == active {
    return Ok(());
  }
  if active {
    app
      .remove_menu()
      .map_err(|error| format!("收起源生菜单失败：{error}"))?;
  } else {
    let menu = Menu::default(&app).map_err(|error| format!("恢复原生菜单失败：{error}"))?;
    app
      .set_menu(menu)
      .map_err(|error| format!("恢复原生菜单失败：{error}"))?;
  }
  *recording = active;
  Ok(())
}
