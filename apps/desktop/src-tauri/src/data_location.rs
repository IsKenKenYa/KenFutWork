//! 数据目录的系统胶水；复制、内容校验与配置提交由同源Node离线命令负责。
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;

use crate::{desktop_access, navigate_main_window, start_server, ServerState};

pub struct DataLocationState(pub std::sync::Mutex<Location>);
pub struct Location {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub port: u16,
    pub ui_base: String,
    pub moving: bool,
}

pub fn resolve_data_dir(default: &Path, pointer: &Path) -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("KENFUTWORK_DATA_DIR") {
        if !explicit.trim().is_empty() {
            let path = PathBuf::from(explicit.trim());
            if !path.is_absolute() {
                return Err("应用数据目录必须是绝对路径。".into());
            }
            return Ok(path);
        }
    }
    let content = match std::fs::read_to_string(pointer) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default.to_path_buf())
        }
        Err(error) => return Err(format!("读取数据目录配置失败：{error}")),
    };
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| "数据目录配置不是合法JSON。")?;
    let path = value
        .get("dataDir")
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .ok_or("数据目录配置缺少dataDir。")?;
    if !path.is_absolute() {
        return Err("数据目录配置必须是绝对路径。".into());
    }
    Ok(path)
}

fn snapshot(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(PathBuf, PathBuf, u16, String), String> {
    let state = app.state::<DataLocationState>();
    let state = state.0.lock().map_err(|_| "读取桌面状态失败。")?;
    let actual = window.url().map_err(|_| "无法读取当前窗口地址。")?;
    let expected = tauri::Url::parse(&state.ui_base).map_err(|_| "桌面界面地址无效。")?;
    if window.label() != "main" || actual.origin() != expected.origin() {
        return Err("当前页面不是本机工作台，不能控制桌面实例。".into());
    }
    Ok((
        state.data_dir.clone(),
        state.config_dir.clone(),
        state.port,
        state.ui_base.clone(),
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationReply {
    data_dir: String,
}

#[tauri::command]
pub async fn open_in_browser(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let (data_dir, _, port, ui_base) = snapshot(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = desktop_access::connection_url(&data_dir, port, &ui_base)?;
        crate::desktop_system::open_external(url)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_data_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let (data_dir, _, _, _) = snapshot(&app, &window)?;
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    Command::new(program)
        .arg(data_dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开数据目录失败：{error}"))
}

fn offline_command(
    _app: &tauri::AppHandle,
    mode: &str,
    payload: serde_json::Value,
) -> Result<Option<PathBuf>, String> {
    #[cfg(not(debug_assertions))]
    let packaged = crate::bundled_server_launch(_app);
    #[cfg(debug_assertions)]
    let packaged: Option<(PathBuf, Vec<String>, PathBuf)> = None;
    let mut command = if let Some((program, args, cwd)) = packaged {
        let mut command = Command::new(program);
        command.args(args).current_dir(cwd);
        command
    } else {
        let mut command = Command::new("pnpm");
        command.args([
            "--filter",
            "@kenfutwork/server",
            "exec",
            "node",
            "--import",
            "tsx",
            "src/server.ts",
        ]);
        if let Ok(cwd) = std::env::var("KENFUTWORK_DESKTOP_SERVER_CWD") {
            command.current_dir(cwd);
        }
        command
    };
    command
        .arg(mode)
        .arg(payload.to_string())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| format!("执行数据目录离线命令失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "数据目录操作失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if mode != "--move-data-location" {
        return Ok(None);
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let relocated = output
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find_map(|value| {
            value
                .get("dataDir")
                .and_then(|value| value.as_str())
                .map(PathBuf::from)
        })
        .ok_or("离线移动命令未返回校验后的数据目录。")?;
    if !relocated.is_absolute() {
        return Err("离线移动命令返回了相对目录。".into());
    }
    Ok(Some(relocated))
}

fn restart(
    app: &tauri::AppHandle,
    data_dir: &Path,
    port: u16,
    ui_base: &str,
) -> Result<(), String> {
    let (_, selected_port) = start_server(app, data_dir)?;
    let port = selected_port.unwrap_or(port);
    let ui_base = if selected_port.is_some() {
        format!("http://127.0.0.1:{port}/")
    } else {
        ui_base.into()
    };
    {
        let state = app.state::<DataLocationState>();
        let mut state = state.0.lock().map_err(|_| "保存桌面状态失败。")?;
        state.data_dir = data_dir.into();
        state.port = port;
        state.ui_base = ui_base.clone();
    }
    let url = desktop_access::connection_url(data_dir, port, &ui_base)?;
    let handle = app.clone();
    app.run_on_main_thread(move || navigate_main_window(&handle, &url))
        .map_err(|error| error.to_string())
}

fn pointer_is_unchanged(pointer: &Path, previous: &Option<String>) -> Result<bool, String> {
    let current = match std::fs::read_to_string(pointer) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取当前数据目录配置失败：{error}")),
    };
    Ok(&current == previous)
}

/// 恢复指针的失败不能阻断原实例重启；保留最初失败并汇总恢复失败。
fn recover_original_instance(
    failure: String,
    pointer_unchanged: Result<bool, String>,
    rollback: impl FnOnce() -> Result<(), String>,
    restart_source: impl FnOnce() -> Result<(), String>,
) -> String {
    let mut errors = vec![failure];
    let needs_rollback = match pointer_unchanged {
        Ok(unchanged) => !unchanged,
        Err(error) => {
            errors.push(error);
            true
        }
    };
    if needs_rollback {
        if let Err(error) = rollback() {
            errors.push(format!("原指针恢复失败：{error}"));
        }
    }
    if let Err(error) = restart_source() {
        errors.push(format!("原目录重启失败：{error}"));
    }
    errors.join("；")
}

fn move_directory(
    app: &tauri::AppHandle,
    source: PathBuf,
    config: PathBuf,
    port: u16,
    ui_base: String,
    target: String,
) -> Result<DataLocationReply, String> {
    if std::env::var("KENFUTWORK_DATA_DIR").is_ok_and(|value| !value.trim().is_empty()) {
        return Err(
            "数据目录已由启动环境变量固定，请移除KENFUTWORK_DATA_DIR后重启桌面应用再移动。".into(),
        );
    }
    let pointer = config.join("data-location.json");
    let previous = match std::fs::read_to_string(&pointer) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取原目录配置失败：{error}")),
    };
    if app.state::<ServerState>().0.pid().is_none() {
        return Err(
            "当前服务由外部进程管理，无法停库移动。请由桌面应用启动本机服务后再试。".into(),
        );
    }
    let ready = desktop_access::local_request(
        &source,
        port,
        "/api/instance/data-location/prepare",
        &serde_json::json!({ "dataDir": target }),
    )?;
    if ready.get("ready").and_then(|value| value.as_bool()) != Some(true) {
        return Err("本机工作尚未结束，不能移动数据目录。".into());
    }
    let outcome = (|| {
        desktop_access::local_request(
            &source,
            port,
            "/api/instance/data-location/shutdown",
            &serde_json::json!({}),
        )?;
        app.state::<ServerState>()
            .0
            .wait_for_clean_exit()
            .map_err(|error| format!("服务端未正常停机：{error}"))?;
        let relocated = offline_command(
            app,
            "--move-data-location",
            serde_json::json!({ "source": source, "target": target, "pointerFile": pointer }),
        )?
        .ok_or("未获得新的数据目录。")?;
        restart(app, &relocated, port, &ui_base)?;
        Ok(DataLocationReply {
            data_dir: relocated.to_string_lossy().to_string(),
        })
    })();
    match outcome {
        Ok(reply) => Ok(reply),
        Err(error) => {
            // 原目录保留；新目录启动失败也撤回配置，然后重新建立原实例连接。
            app.state::<ServerState>()
                .0
                .stop_current(crate::SHUTDOWN_GRACE);
            Err(recover_original_instance(
                error,
                pointer_is_unchanged(&pointer, &previous),
                || {
                    offline_command(
                        app,
                        "--rollback-data-location",
                        serde_json::json!({ "pointerFile": pointer, "previous": previous }),
                    )
                    .map(|_| ())
                },
                || restart(app, &source, port, &ui_base),
            ))
        }
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn unchanged_unwritable_pointer_is_not_rewritten_and_source_restarts() {
        let restarted = Cell::new(false);
        let error = recover_original_instance(
            "配置目录不可写".into(),
            Ok(true),
            || panic!("原指针未改变时不应再次写配置"),
            || {
                restarted.set(true);
                Ok(())
            },
        );
        assert!(restarted.get());
        assert_eq!(error, "配置目录不可写");
    }

    #[test]
    fn failed_pointer_rollback_still_restarts_source_and_keeps_original_error() {
        let events = RefCell::new(Vec::new());
        let error = recover_original_instance(
            "目标实例启动失败".into(),
            Ok(false),
            || {
                events.borrow_mut().push("rollback");
                Err("系统配置目录拒绝写入".into())
            },
            || {
                events.borrow_mut().push("restart");
                Ok(())
            },
        );
        assert_eq!(*events.borrow(), vec!["rollback", "restart"]);
        assert_eq!(
            error,
            "目标实例启动失败；原指针恢复失败：系统配置目录拒绝写入"
        );
    }

    #[test]
    fn rollback_and_restart_failures_are_reported_together() {
        let error = recover_original_instance(
            "复制失败".into(),
            Ok(false),
            || Err("无法恢复原指针".into()),
            || Err("原数据库无法启动".into()),
        );
        assert_eq!(
            error,
            "复制失败；原指针恢复失败：无法恢复原指针；原目录重启失败：原数据库无法启动"
        );
    }

    #[test]
    fn unreadable_pointer_attempts_recovery_and_source_restart() {
        let restarted = Cell::new(false);
        let rollback = Cell::new(false);
        let error = recover_original_instance(
            "移动失败".into(),
            Err("无法读取当前配置".into()),
            || {
                rollback.set(true);
                Ok(())
            },
            || {
                restarted.set(true);
                Ok(())
            },
        );
        assert!(rollback.get());
        assert!(restarted.get());
        assert_eq!(error, "移动失败；无法读取当前配置");
    }
}

#[tauri::command]
pub async fn move_data_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    data_dir: String,
) -> Result<DataLocationReply, String> {
    let (source, config, port, ui_base) = snapshot(&app, &window)?;
    {
        let state = app.state::<DataLocationState>();
        let mut state = state.0.lock().map_err(|_| "读取桌面状态失败。")?;
        if state.moving {
            return Err("另一个数据目录移动操作正在进行。".into());
        }
        state.moving = true;
    }
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        move_directory(&worker_app, source, config, port, ui_base, data_dir)
    })
    .await
    .map_err(|error| error.to_string());
    if let Ok(mut state) = app.state::<DataLocationState>().0.lock() {
        state.moving = false;
    }
    result?
}
