//! KenFutWork 桌面壳（多端计划 §4，FORM-2）。
//!
//! 职责边界（保持薄）：窗口/托盘/自更新/深链归这里；业务一律在服务端 sidecar
//! （同一份 apps/server 代码，桌面数据落本地数据目录）。
//! 服务端生命周期管理见 `server_handle`（spawn / 探活 / 复用 / 优雅退出）。

pub mod server_handle;

pub use server_handle::{
  ensure_server_running, probe_health, HealthStatus, LifecycleError, ProbeError,
  ServerLaunch, ServerSpawnConfig,
};

use std::time::Duration;
use tauri::Manager;

/// 桌面壳探活命令（前端可通过 invoke 调用确认壳活着）。
#[tauri::command]
fn ping() -> String {
    "KenFutWork desktop shell".into()
}

/// 服务端默认端口（与 web 端 `NEXT_PUBLIC_SERVER_BASE_URL` 缺省值一致）。
const SERVER_PORT: u16 = 3001;
/// 退出宽限：SIGTERM 后等这么久，超时升级 SIGKILL（服务端 SIGTERM 会停 jobLoop 并停库）。
const SHUTDOWN_GRACE: Duration = std::time::Duration::from_secs(10);

/// 持有服务端句柄的托管状态；`Reused`（复用用户自己的 dev）时为 None。
struct ServerState(std::sync::Mutex<Option<server_handle::ServerHandle>>);

fn spawn_config(data_dir: std::path::PathBuf) -> ServerSpawnConfig {
    // 命令与 cwd 可用 env 覆盖（dev.sh 会注入 LOOMIC_DESKTOP_SERVER_CWD=仓库根）；
    // 打包态（sidecar）落地时改为二进制路径注入，接口不变。
    let command =
        std::env::var("LOOMIC_DESKTOP_SERVER_CMD").unwrap_or_else(|_| "pnpm".into());
    let args = std::env::var("LOOMIC_DESKTOP_SERVER_ARGS")
        .unwrap_or_else(|_| "--filter @loomic/server dev:server".into())
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut config = ServerSpawnConfig::new(&command, args, data_dir, SERVER_PORT);
    if let Ok(cwd) = std::env::var("LOOMIC_DESKTOP_SERVER_CWD") {
        config.cwd = cwd.into();
    }
    config
}

/// 外部终止信号（pkill/系统注销/ctrl-c）→ 同样走优雅停服，避免孤儿化服务端。
/// 窗口关闭按钮走下面的 RunEvent::Exit，两条路径共用同一份句柄状态。
fn register_signal_shutdown(app: tauri::AppHandle) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    std::thread::spawn(move || {
        let mut signals =
            signal_hook::iterator::Signals::new([SIGINT, SIGTERM]).expect("注册信号失败");
        for signal in signals.forever() {
            if let Some(state) = app.try_state::<ServerState>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut handle) = guard.take() {
                        println!("[desktop] 收到信号 {signal}：优雅停服务端…");
                        handle.shutdown(SHUTDOWN_GRACE);
                    }
                }
            }
            std::process::exit(0);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let mut config = spawn_config(data_dir);
            if let Ok(cwd) = std::env::var("LOOMIC_DESKTOP_SERVER_CWD") {
                config.cwd = cwd.into();
            }
            match ensure_server_running(config) {
                Ok(ServerLaunch::Spawned(handle)) => {
                    println!("[desktop] 服务端已拉起（pid {}）", handle.pid());
                    app.manage(ServerState(std::sync::Mutex::new(Some(handle))));
                }
                Ok(ServerLaunch::Reused) => {
                    println!("[desktop] 端口 {SERVER_PORT} 已有健康服务端，复用");
                    app.manage(ServerState(std::sync::Mutex::new(None)));
                }
                Err(error) => return Err(Box::new(error)),
            }
            register_signal_shutdown(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 窗口关闭/应用退出 → 优雅停服务端（停 jobLoop + 停库），超时强杀
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<ServerState>() {
                    if let Some(mut handle) = state.0.lock().ok().and_then(|mut s| s.take()) {
                        println!("[desktop] 退出：优雅停服务端…");
                        handle.shutdown(SHUTDOWN_GRACE);
                    }
                }
            }
        });
}
