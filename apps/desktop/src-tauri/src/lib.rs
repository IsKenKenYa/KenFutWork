//! KenFutWork 桌面壳（多端计划 §4，FORM-2）。
//!
//! 职责边界（保持薄）：窗口/托盘/自更新/深链归这里；业务一律在服务端 sidecar
//! （同一份 apps/server 代码，桌面数据落本地数据目录）。
//! 服务端生命周期管理见 `server_handle`（spawn / 探活 / 复用 / 优雅退出）。

pub mod browser_embed;
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

/**
 * 打包态（安装包装出来的形态）里那套「桌面形态」环境变量。
 *
 * 与 `release/启动.bat` 同一套：内嵌 PG、本机免登录、进程内队列、静态 UI 由服务端托管。
 * **为什么要把窗口指向 `http://127.0.0.1:<port>` 而不是加载打包进壳里的 UI**：local-trust 的
 * 可信来源只认**回环页面**（见 `features/auth/local-trust.ts`）——壳自带的 `tauri://localhost`
 * 不是回环，会被 401/403；服务端自己托管的那份 UI 才是它认的来源。
 */
fn desktop_env(app: &tauri::AppHandle, web_dir: &std::path::Path) -> Vec<(String, String)> {
    let _ = app;
    vec![
        ("KENFUTWORK_EMBEDDED_PG".into(), "1".into()),
        ("KENFUTWORK_AUTH_DRIVER".into(), "local-trust".into()),
        ("KENFUTWORK_QUEUE_DRIVER".into(), "in-process".into()),
        (
            "KENFUTWORK_WEB_ORIGIN".into(),
            format!("http://127.0.0.1:{SERVER_PORT}"),
        ),
        (
            "KENFUTWORK_WEB_DIST".into(),
            web_dir.to_string_lossy().to_string(),
        ),
    ]
}

/** 安装包随带的那个服务端 exe（`<resource>/app/KenFutWork-server.exe`）；仓库里跑时为 None。 */
fn bundled_server_exe(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().resource_dir().ok()?.join("app");
    let exe = dir.join("KenFutWork-server.exe");
    exe.exists().then_some(exe)
}

fn spawn_config(app: &tauri::AppHandle, data_dir: std::path::PathBuf) -> ServerSpawnConfig {
    // ① 打包态优先：随包的服务端 exe（安装包把 release/ 拷进 <resource>/app/）
    if std::env::var("LOOMIC_DESKTOP_SERVER_CMD").is_err() {
        if let Some(exe) = bundled_server_exe(app) {
            let dir = exe
                .parent()
                .map(|parent| parent.to_path_buf())
                .unwrap_or_else(|| data_dir.clone());
            let mut config = ServerSpawnConfig::new(
                exe.to_string_lossy().as_ref(),
                Vec::new(),
                data_dir,
                SERVER_PORT,
            );
            config.cwd = dir.clone();
            config.env = desktop_env(app, &dir.join("web"));
            return config;
        }
    }
    // ② 开发形态：命令与 cwd 可用 env 覆盖（dev.sh 会注入 LOOMIC_DESKTOP_SERVER_CWD=仓库根）
    let command =
        std::env::var("LOOMIC_DESKTOP_SERVER_CMD").unwrap_or_else(|_| "pnpm".into());
    let args = std::env::var("LOOMIC_DESKTOP_SERVER_ARGS")
        // 包名按品牌改过（`@kenfutwork/*`）：这里以前还写着旧作用域 `@loomic/server`，
        // 真机 `cargo check` 顺带发现——照旧名拉起会直接「找不到包」，桌面端起不来服务端。
        .unwrap_or_else(|_| "--filter @kenfutwork/server dev:server".into())
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut config = ServerSpawnConfig::new(&command, args, data_dir, SERVER_PORT);
    if let Ok(cwd) = std::env::var("LOOMIC_DESKTOP_SERVER_CWD") {
        config.cwd = cwd.into();
    }
    config
}

/// 外部终止信号（pkill / 系统注销 / ctrl-c）→ 同样走优雅停服，避免孤儿化服务端。
/// 窗口关闭按钮走下面的 RunEvent::Exit，两条路径共用同一份句柄状态。
///
/// **只在类 Unix 上注册**：`signal_hook::iterator` 在 Windows 上不存在
/// （上游是 `#[cfg(all(not(windows), feature = "iterator"))]`），此前这里没加门控，
/// 结果是**这个桌面壳在 Windows 上根本编不过**（真机 `cargo check` 才发现）。Windows 侧的
/// 正常退出由窗口关闭的 `RunEvent::Exit` 覆盖。
#[cfg(unix)]
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
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping]);
    // 右栏浏览器的真内核嵌入（子 webview + WebView2 DevTools）——见 browser_embed.rs
    browser_embed::register_embed_commands(builder)
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let bundled = bundled_server_exe(app.handle());
            let mut config = spawn_config(app.handle(), data_dir);
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
            // 打包态：**等服务端健康之后把窗口指向它托管的 UI**（`ensure_server_running` 已经
            // 探活过，这一步是即时的）。指向回环 http 而不是壳自带的 `tauri://`，是因为
            // local-trust 只认回环来源（见 `desktop_env` 的说明）。
            if bundled.is_some() {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let url = format!("http://127.0.0.1:{SERVER_PORT}/");
                    if let Ok(parsed) = url.parse() {
                        let _ = window.navigate(parsed);
                    }
                }
            }
            #[cfg(unix)]
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
