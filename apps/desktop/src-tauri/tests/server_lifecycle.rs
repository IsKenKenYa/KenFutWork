//! 集成测试：服务端生命周期管理（R4-Tauri 生命周期契约）。
//!
//! 替身服务 = `std::net::TcpListener` 手写 HTTP 200（零外部依赖，Windows/macOS 都能跑）；
//! 端口用内核分配的空闲端口，避免与本机 3001/3000 冲突。
//!
//! 需要 `test-fixture` feature（提供 `loomic-test-fake-server` 子进程替身）：
//! `pnpm --filter @kenfutwork/desktop test` 已带上；默认构建不带，安装包就不会夹带替身 exe。
#![cfg(feature = "test-fixture")]

use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use kenfutwork_desktop_lib::{probe_health, ServerSpawnConfig};

/// 在空闲端口上起一个「所有路径都回 200 OK」的假服务；返回 (端口, 守卫)。
/// 守卫当前是占位（accept 循环随测试进程退出回收）。
fn spawn_fake_server() -> (u16, FakeServerGuard) {
    spawn_fake_server_with(200, "OK")
}

/// 起一个「固定回某个状态码与响应体」的假服务（用来分别扮演真 UI 与别人的服务）。
fn spawn_fake_server_with(status: u16, body: &'static str) -> (u16, FakeServerGuard) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind 空闲端口");
    let port = listener.local_addr().expect("local_addr").port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            respond(&mut stream, status, body);
        }
    });
    thread::sleep(Duration::from_millis(50)); // 监听就绪
    (port, FakeServerGuard)
}

fn respond_ok(stream: &mut TcpStream) {
    respond(stream, 200, "OK");
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let response = format!(
        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    use std::io::Write as _;
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// 占位守卫：假服务线程随测试进程退出回收（accept 循环 detached，不 join——
/// join 会永远阻塞在 accept 上）。保留命名类型以便未来加停机旗标。
struct FakeServerGuard;

mod health_probe {
    use super::*;

    #[test]
    fn 健康探活_假服务已监听时立即返回存活() {
        let (port, _guard) = spawn_fake_server();
        let status = probe_health(port, Duration::from_secs(2)).expect("应探活成功");
        assert!(status.healthy);
    }

    #[test]
    fn 探活超时_无人监听的端口在超时后报不可用() {
        // 抢占一个端口后立刻释放：该端口大概率无人监听
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("local_addr").port()
        };
        let result = probe_health(port, Duration::from_millis(500));
        assert!(result.is_err(), "无人监听的端口不应探活成功");
    }
}

mod spawn_config {
    use super::*;

    #[test]
    fn spawn配置携带数据目录与健康超时默认值() {
        let config = ServerSpawnConfig::new("echo", vec![], "/tmp/data".into(), 3001);
        assert_eq!(config.command, "echo");
        assert_eq!(config.data_dir, std::path::PathBuf::from("/tmp/data"));
        assert_eq!(config.port, 3001);
        // 默认健康超时 90 秒（dev 首次 tsx 编译慢）
        assert_eq!(config.health_timeout, Duration::from_secs(90));
    }
}

/**
 * 打包态窗口该指向谁：**只认托管着界面的自己人**。
 *
 * 实测事故（2026-09-17 真机安装包）：窗口跳到了 3001 上「探活 200 但没托管 UI」的
 * 服务（用户自己的 dev API），停在 `{"message":"Route GET:/ not found"}` ——
 * Design 模式的画布整块没了。这两条用例把它钉死。
 */
mod ui_probe {
    use super::*;

    use kenfutwork_desktop_lib::{port_is_free, probe_serves_ui};

    #[test]
    fn 托管界面的服务判为可用() {
        let (port, _guard) = spawn_fake_server_with(200, "<!DOCTYPE html><html><body>UI</body></html>");
        assert!(probe_serves_ui(port, Duration::from_secs(2)));
    }

    #[test]
    fn 只回200但没界面的服务判为不可用() {
        // 用户自己起的 dev API：健康检查过、首页是 404 JSON
        let (port, _guard) =
            spawn_fake_server_with(404, r#"{"message":"Route GET:/ not found","error":"Not Found"}"#);
        assert!(
            !probe_serves_ui(port, Duration::from_secs(1)),
            "没托管界面的服务不该被当成可用的 UI 来源"
        );
    }

    #[test]
    fn 无人监听的端口判为不可用() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("local_addr").port()
        };
        assert!(!probe_serves_ui(port, Duration::from_millis(500)));
    }

    #[test]
    fn 端口空闲判定区分有无监听() {
        let (port, _guard) = spawn_fake_server();
        assert!(!port_is_free(port), "有人在听的端口不算空闲");

        let free = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("local_addr").port()
        };
        assert!(port_is_free(free), "刚释放的端口应判为空闲");
    }
}

mod ensure_server_running {
    use super::*;

    use kenfutwork_desktop_lib::{ensure_server_running, ServerLaunch};
    use std::path::PathBuf;

    fn config_for(port: u16) -> kenfutwork_desktop_lib::ServerSpawnConfig {
        let mut config = ServerSpawnConfig::new(
            env!("CARGO_BIN_EXE_loomic-test-fake-server"),
            vec![port.to_string()],
            std::env::temp_dir().join("loomic-lifecycle-test"),
            port,
        );
        config.health_timeout = Duration::from_secs(5);
        config
    }

    #[test]
    fn 端口无人监听时拉起子进程并探活成功() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener); // 释放端口给子进程

        let launch = ensure_server_running(config_for(port)).expect("拉起成功");
        let ServerLaunch::Spawned(mut handle) = launch else {
            panic!("无人监听时应 spawn 子进程，而不是复用");
        };
        assert!(handle.pid() > 0);
        handle.shutdown(Duration::from_secs(2));
    }

    #[test]
    fn 端口已健康时不spawn直接复用() {
        let (port, _guard) = spawn_fake_server();

        let launch = ensure_server_running(config_for(port)).expect("复用成功");
        assert!(
            matches!(launch, ServerLaunch::Reused),
            "已健康端口应复用而不是再拉一个子进程（尊重用户自己起的 dev）"
        );
    }

    #[test]
    fn 子进程在宽限期内响应SIGTERM并优雅退出() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);

        let kenfutwork_desktop_lib::ServerLaunch::Spawned(mut handle) =
            ensure_server_running(config_for(port)).expect("拉起成功")
        else {
            panic!("应 spawn");
        };
        let pid = handle.pid();
        handle.shutdown(Duration::from_secs(2));

        // 退出后端口应释放（短暂等待操作系统的 TIME_WAIT 之外的进程清理）
        thread::sleep(Duration::from_millis(200));
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "子进程 {pid} 退出后端口应释放"
        );
    }

    #[cfg(unix)]
    #[test]
    fn 忽略SIGTERM的顽固子进程在宽限超时后被强杀() {
        use kenfutwork_desktop_lib::ServerSpawnConfig;
        use std::process::Command;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);

        // 顽固子进程：`trap '' TERM` 忽略优雅信号，只能被 KILL 杀掉——
        // 验证 shutdown 的「宽限超时 → 升级强杀」语义
        let fake_server = env!("CARGO_BIN_EXE_loomic-test-fake-server");
        let mut config = ServerSpawnConfig::new(
            "bash",
            vec![
                "-c".into(),
                format!("trap '' TERM; exec '{fake_server}' {port}"),
            ],
            std::env::temp_dir().join("loomic-lifecycle-test"),
            port,
        );
        config.health_timeout = Duration::from_secs(5);

        let launch = ensure_server_running(config).expect("顽固子进程应探活成功");
        let kenfutwork_desktop_lib::ServerLaunch::Spawned(mut handle) = launch else {
            panic!("应 spawn");
        };
        let pid = handle.pid();

        let started = std::time::Instant::now();
        handle.shutdown(Duration::from_millis(500));
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(500),
            "应先等待宽限期再强杀（实际 {elapsed:?}）"
        );
        thread::sleep(Duration::from_millis(150));
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        assert!(!alive, "顽固子进程 {pid} 应在宽限超时后被强杀");
    }

    /**
     * 收树：服务端自己会拉起内嵌 Postgres，壳只杀直接子进程就会留孤儿。
     *
     * 真机事故（2026-09-19）：卸载后安装目录残留 51 MB、`app\pg\bin` 下 12 个
     * `postgres.exe` 还在跑（文件被占用删不掉）——因为 Windows 上 GUI 壳没法给控制台子进程
     * 送优雅信号，宽限一到就 `TerminateProcess`，后代全留下来了。
     */
    #[test]
    fn 宽限超时后连后代进程一起收掉() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);

        let pid_file = std::env::temp_dir().join(format!("kfw-child-{port}.pid"));
        let _ = std::fs::remove_file(&pid_file);

        let mut config = config_for(port);
        config.args = vec![
            port.to_string(),
            "--child-pid-file".into(),
            pid_file.to_string_lossy().to_string(),
        ];

        let kenfutwork_desktop_lib::ServerLaunch::Spawned(mut handle) =
            ensure_server_running(config).expect("拉起成功")
        else {
            panic!("应 spawn");
        };

        let grandchild = wait_for_pid(&pid_file);
        assert!(process_alive(grandchild), "后代进程 {grandchild} 应先活着");

        handle.shutdown(Duration::from_millis(400));
        // 容差给足：收树走的是内核（作业对象），但机器忙的时候（并行跑整个仓库测试、
        // 同时还有别的进程在起服务端）taskkill/进程回收会慢一拍——5 秒太紧会误报，
        // 实测在 turbo 并行那轮出现过一次假失败。
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < deadline && process_alive(grandchild) {
            thread::sleep(Duration::from_millis(150));
        }
        assert!(
            !process_alive(grandchild),
            "后代进程 {grandchild} 应随服务端一起收掉（否则内嵌 Postgres 会变成孤儿）"
        );
        let _ = std::fs::remove_file(&pid_file);
    }

    /// 等替身把后代 pid 写进文件（替身先写文件再监听，正常是即时的）。
    fn wait_for_pid(path: &std::path::Path) -> u32 {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("等后代 pid 超时：{}", path.display());
    }

    fn process_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            // tasklist 的输出无匹配时是本地化文案，故只认「出现了这个 pid」
            let output = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .expect("tasklist");
            String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        }
        #[cfg(unix)]
        {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        }
    }
}
