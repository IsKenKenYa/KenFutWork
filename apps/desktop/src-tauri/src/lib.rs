//! KenFutWork 桌面壳（多端计划 §4，FORM-2）。
//!
//! 职责边界（保持薄）：窗口/托盘/自更新/深链归这里；业务一律在服务端 sidecar
//! （同一份 apps/server 代码，桌面数据落本地数据目录）。
//! 服务端生命周期管理见 `server_handle`（spawn / 探活 / 复用 / 优雅退出）。

pub mod browser_embed;
pub mod server_handle;

pub use server_handle::{
    ensure_server_running, port_is_free, probe_health, probe_serves_ui, HealthStatus,
    LifecycleError, ProbeError, ServerLaunch, ServerSpawnConfig,
};

use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

/// 桌面壳探活命令（前端可通过 invoke 调用确认壳活着）。
#[tauri::command]
fn ping() -> String {
    "KenFutWork desktop shell".into()
}

/// 服务端默认端口（与 web 端 `NEXT_PUBLIC_SERVER_BASE_URL` 缺省值一致）。
const SERVER_PORT: u16 = 3001;
/**
 * 打包态端口候选个数：3001 起往后找（3001…3010），全被占才报错。
 *
 * 为什么要往后找而不是死守 3001：探活 200 只说明「有东西在听」。用户自己的 dev API、
 * 别的软件占着 3001 时，窗口指向它只能拿到 404（2026-09-17 真机截图即
 * `{"message":"Route GET:/ not found"}`）——**Design 模式因此整块失效**（画布没了）。
 * 换端口的前提是前端按「同源」解析 API base（见 apps/web/src/lib/env.ts）。
 */
const PORT_CANDIDATES: u16 = 10;
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
 * 不是回环，会被 401/403；而且 Tauri 的资源协议**不认 `/canvas` 这种无扩展名路由**
 * （服务端托管那份走 `canvas.html` 回退，见 `http/static-web.ts`）——Design 模式的画布 iframe
 * 正是 `/canvas?id=…`，所以在壳自带 UI 上**画布永远是空白**（用户 2026-09-17 报的
 * 「design 模式是画布啊，怎么又给我改坏了」就是这个）。
 */
fn desktop_env(app: &tauri::AppHandle, web_dir: &Path, port: u16) -> Vec<(String, String)> {
    let _ = app;
    vec![
        ("KENFUTWORK_EMBEDDED_PG".into(), "1".into()),
        ("KENFUTWORK_AUTH_DRIVER".into(), "local-trust".into()),
        ("KENFUTWORK_QUEUE_DRIVER".into(), "in-process".into()),
        // 监听端口必须与壳挑中的一致：不改它，服务端仍去抢 3001
        ("KENFUTWORK_SERVER_PORT".into(), port.to_string()),
        (
            "KENFUTWORK_WEB_ORIGIN".into(),
            format!("http://127.0.0.1:{port}"),
        ),
        (
            "KENFUTWORK_WEB_DIST".into(),
            web_dir.to_string_lossy().to_string(),
        ),
    ]
}

/** 安装包随带的那个服务端可执行（`<resource>/app/KenFutWork-server[.exe]`）；仓库里跑时为 None。
 *
 * 判定必须**严于 exists**：打包占位的零字节文件、tauri-build 残骸都算「存在但不可运行」，
 * 误判会让 dev 形态永远走不到 dev 拉起路径（2026-09-19 实测事故：探活盲等 90s panic）。
 */
fn bundled_server_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().resource_dir().ok()?.join("app");
    #[cfg(windows)]
    let exe = dir.join("KenFutWork-server.exe");
    #[cfg(not(windows))]
    let exe = dir.join("KenFutWork-server");

    let meta = std::fs::metadata(&exe).ok()?;
    // 零字节 = tauri-build 的占位残骸，不是真服务端
    if meta.len() == 0 {
        return None;
    }
    // Unix 上还要求可执行位（占位文件通常没有）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(exe)
}

/// 打包态的拉起配置：随包服务端 exe + 桌面环境变量 + 指定端口。
fn packaged_spawn_config(
    app: &tauri::AppHandle,
    exe: &Path,
    data_dir: PathBuf,
    port: u16,
) -> ServerSpawnConfig {
    let dir = exe
        .parent()
        .map(|parent| parent.to_path_buf())
        .unwrap_or_else(|| data_dir.clone());
    let mut config = ServerSpawnConfig::new(
        exe.to_string_lossy().as_ref(),
        Vec::new(),
        data_dir,
        port,
    );
    config.cwd = dir.clone();
    config.env = desktop_env(app, &dir.join("web"), port);
    config
}

/// 开发形态的拉起配置：命令与 cwd 可用 env 覆盖（dev.sh 注入 `KENFUTWORK_DESKTOP_SERVER_CWD`）。
fn dev_spawn_config(data_dir: PathBuf) -> ServerSpawnConfig {
    let command = std::env::var("KENFUTWORK_DESKTOP_SERVER_CMD").unwrap_or_else(|_| "pnpm".into());
    let args = std::env::var("KENFUTWORK_DESKTOP_SERVER_ARGS")
        // 包名按品牌改过（`@kenfutwork/*`）：这里以前还写着旧作用域 `@loomic/server`，
        // 真机 `cargo check` 顺带发现——照旧名拉起会直接「找不到包」，桌面端起不来服务端。
        .unwrap_or_else(|_| "--filter @kenfutwork/server dev:server".into())
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let mut config = ServerSpawnConfig::new(&command, args, data_dir, SERVER_PORT);
    if let Ok(cwd) = std::env::var("KENFUTWORK_DESKTOP_SERVER_CWD") {
        config.cwd = cwd.into();
    }
    config
}

/// 壳日志文件：GUI 进程没有控制台，启动决策与失败原因必须落盘才可排障。
fn log_line(data_dir: &Path, message: &str) {
    use std::io::Write as _;
    let path = data_dir.join("desktop-shell.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/**
 * 打包态：挑一个「确实托管着我们 UI」的端口——自己人已健康就复用，撞车就往后挑端口。
 *
 * 顺序（每个候选端口）：探活 → 有东西在听时再验它托管的首页是不是 HTML。
 * 是 → 复用；不是（别人的服务/dev API）→ 换下一个端口；没人听且可绑 → 拉自己的服务端。
 */
fn launch_packaged_server(
    app: &tauri::AppHandle,
    data_dir: &Path,
    exe: &Path,
) -> Result<(u16, ServerLaunch), String> {
    for offset in 0..PORT_CANDIDATES {
        let port = SERVER_PORT + offset;
        if probe_health(port, Duration::from_millis(300)).is_ok() {
            if probe_serves_ui(port, Duration::from_secs(2)) {
                log_line(data_dir, &format!("端口 {port} 已有本工作台服务端，复用"));
                return Ok((port, ServerLaunch::Reused));
            }
            log_line(
                data_dir,
                &format!("端口 {port} 被别的服务占用（没有托管界面），换端口"),
            );
            continue;
        }
        if !port_is_free(port) {
            // 在听但还没健康：可能正在启动，给一小段宽限
            if probe_health(port, Duration::from_secs(3)).is_ok()
                && probe_serves_ui(port, Duration::from_secs(2))
            {
                log_line(data_dir, &format!("端口 {port} 稍后健康，复用"));
                return Ok((port, ServerLaunch::Reused));
            }
            log_line(data_dir, &format!("端口 {port} 不可用，换端口"));
            continue;
        }
        let config = packaged_spawn_config(app, exe, data_dir.to_path_buf(), port);
        log_line(
            data_dir,
            &format!(
                "拉起随包服务端：{}（端口 {port}，UI 目录 {}）",
                exe.display(),
                exe.parent()
                    .map(|dir| dir.join("web").display().to_string())
                    .unwrap_or_default()
            ),
        );
        match ensure_server_running(config) {
            Ok(launch) => {
                if !probe_serves_ui(port, Duration::from_secs(10)) {
                    return Err(format!(
                        "本机服务在端口 {port} 起来了，但它没有托管界面（KENFUTWORK_WEB_DIST 无效）。"
                    ));
                }
                return Ok((port, launch));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "端口 {SERVER_PORT}–{} 都被占用，起不了本机服务。请关掉占用端口的程序后重开。",
        SERVER_PORT + PORT_CANDIDATES - 1
    ))
}

/// 启动服务端；返回窗口该指向的端口（dev 形态返回 None：窗口交给 devUrl / 壳自带 UI）。
fn start_server(
    app: &tauri::AppHandle,
    data_dir: &Path,
) -> Result<(ServerLaunch, Option<u16>), String> {
    if let Some(exe) = bundled_server_exe(app) {
        let (port, launch) = launch_packaged_server(app, data_dir, &exe)?;
        return Ok((launch, Some(port)));
    }
    ensure_server_running(dev_spawn_config(data_dir.to_path_buf()))
        .map(|launch| (launch, None))
        .map_err(|error| error.to_string())
}

/// 把窗口指向服务端托管的 UI（回环 http）。
fn navigate_main_window(app: &tauri::AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        match url.parse() {
            Ok(parsed) => {
                let _ = window.navigate(parsed);
            }
            Err(error) => log_line(
                &app.path().app_data_dir().unwrap_or_default(),
                &format!("窗口跳转失败（{url}）：{error}"),
            ),
        }
    }
}

/**
 * 启动中页面（打包态第一屏）。
 *
 * **为什么必须有**：服务端起来要时间（内嵌 Postgres 首启动要 initdb，慢的时候几十秒）。
 * 以前 `setup` 里**同步**等健康检查（最多 90 秒）——主线程被占住，窗口连重绘都轮不上，
 * 用户看到的就是长时间白屏（2026-09-19 用户报「启动很久 + 白屏」）。现在服务端改到后台
 * 线程去起，窗口先画这一页，起来了再跳转到服务端托管的 UI。
 *
 * 用 `eval` 注入而不是另做 HTML 资源：壳自带的 UI 是 `frontendDist`（web 静态导出），
 * 往里塞文件会被下一次前端构建覆盖；注入在这里与前端构建解耦，也不会漏发布。
 */
const SPLASH_SCRIPT: &str = r##"(() => {
  const paint = () => {
    if (!document.body) return false;
    // 静态启动页（`_splash.html`）已经在位：它是主路径，别再盖一层
    if (document.body.dataset.kfwSplash === "1") return true;
    if (window.__kfwSplash) return true;
    window.__kfwSplash = true;
    document.title = "KenFutWork 正在启动";
    // 用应用图标本身（静态导出里的 /app-icon.png）：换标时这里跟着换，不内联旧 logo
    const logo = '<img src="/app-icon.png" width="52" height="52" alt="" />';
    document.body.innerHTML =
      '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:16px;background:#fff;color:#2f3459;'
      + 'font:14px/1.6 system-ui,-apple-system,\'Segoe UI\',sans-serif">'
      + '<div style="display:flex;align-items:center;gap:10px">' + logo
      + '<span style="font-family:'Momo Trust Display',system-ui,sans-serif;font-size:24px;'
      + 'background:linear-gradient(90deg,#2e63fa,#214ada);-webkit-background-clip:text;'
      + 'background-clip:text;color:transparent">KenFutWork</span></div>'
      + '<div style="width:180px;height:3px;border-radius:999px;background:#e6e7ef;overflow:hidden">'
      + '<div style="width:40%;height:100%;border-radius:999px;background:#2e63fa;'
      + 'animation:kfwSlide 1.2s ease-in-out infinite"></div></div>'
      + '<div id="kfw-splash-note" style="color:#6b6f85">正在启动本机服务…</div>'
      + '</div>'
      + '<style>@keyframes kfwSlide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}</style>';
    setTimeout(() => {
      const note = document.getElementById("kfw-splash-note");
      if (note) note.textContent = "首次启动要在本机初始化数据库，可能要几十秒，请稍候…";
    }, 8000);
    return true;
  };
  if (!paint()) document.addEventListener("DOMContentLoaded", paint, { once: true });
})();"##;

/// 在窗口里画启动中页面（失败就算了：这不是主流程，起来了照样会跳转）。
fn show_startup_splash(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // 窗口文档可能还没就绪：脚本自己带 DOMContentLoaded 兜底，这里多重试几次
        for _ in 0..5 {
            if window.eval(SPLASH_SCRIPT).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// 起不来时在窗口里如实说明原因（而不是停在壳自带 UI 上假装没事）。
///
/// 用 `eval` 而不是换 URL：换 URL 要经过 WebView2 的导航策略，而 `eval` 一定作用在
/// 当前文档上。脚本串经 `serde_json` 转义，避免原因文本里的引号/换行破坏 JS。
fn show_startup_error(app: &tauri::AppHandle, data_dir: &Path, reason: &str) {
    log_line(data_dir, &format!("启动失败：{reason}"));
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let html = format!(
        "<div style=\"font:14px/1.7 system-ui;padding:32px;color:#222\">\
<h2 style=\"margin:0 0 12px;font-size:18px\">KenFutWork 启动失败</h2>\
<p style=\"margin:0 0 12px\">{reason}</p>\
<p style=\"margin:0;color:#666\">日志：{log}</p></div>",
        reason = reason.replace('<', "&lt;"),
        log = data_dir.join("desktop-shell.log").display()
    );
    let literal = serde_json::to_string(&html).unwrap_or_else(|_| "\"\"".into());
    let script = format!(
        "document.title='KenFutWork 启动失败';document.body.innerHTML={literal};"
    );
    for _ in 0..5 {
        if window.eval(&script).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
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
        // 单实例：第二个启动实例立即退出并唤起已有窗口——否则两个壳会竞态
        // initdb 同一个内嵌集群（密码文件错位 → auth 必败，2026-09-17 实测事故）
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![ping]);
    // 右栏浏览器的真内核嵌入（子 webview + WebView2 DevTools）——见 browser_embed.rs
    browser_embed::register_embed_commands(builder)
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // **服务端在后台线程里起**：这条路径上有两段慢活——内嵌 Postgres 首启动要
            // `initdb`、服务端 SEA 冷启动要几秒到几十秒。以前 `setup` 里同步等健康检查，
            // 主线程被占住，窗口连重绘都不做 → 用户看到的是一大片白屏。
            // 现在：先画启动中页面（打包态才画，dev 形态窗口归 devUrl），后台起服务，
            // 起来了再把它叫到主线程跳转。
            let packaged = bundled_server_exe(app.handle()).is_some();
            if packaged {
                show_startup_splash(app.handle());
            }
            let handle = app.handle().clone();
            let thread_data_dir = data_dir.clone();
            std::thread::spawn(move || {
                let outcome = start_server(&handle, &thread_data_dir);
                // 窗口操作要在主线程上做
                let ui_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || match outcome {
                    Ok((launch, port)) => {
                        let owned = match launch {
                            ServerLaunch::Spawned(handle) => Some(handle),
                            ServerLaunch::Reused => None,
                        };
                        if let Some(ref handle) = owned {
                            log_line(
                                &thread_data_dir,
                                &format!("服务端已拉起（pid {}）", handle.pid()),
                            );
                        }
                        ui_handle.manage(ServerState(std::sync::Mutex::new(owned)));
                        if let Some(port) = port {
                            navigate_main_window(&ui_handle, &format!("http://127.0.0.1:{port}/"));
                        }
                    }
                    Err(reason) => {
                        ui_handle.manage(ServerState(std::sync::Mutex::new(None)));
                        show_startup_error(&ui_handle, &thread_data_dir, &reason);
                    }
                });
            });
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
