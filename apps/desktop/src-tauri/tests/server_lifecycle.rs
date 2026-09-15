//! 集成测试：服务端生命周期管理（R4-Tauri 生命周期契约）。
//!
//! 替身服务 = `std::net::TcpListener` 手写 HTTP 200（零外部依赖，Windows/macOS 都能跑）；
//! 端口用内核分配的空闲端口，避免与本机 3001/3000 冲突。

use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use kenfutwork_desktop_lib::{probe_health, ServerSpawnConfig};

/// 在空闲端口上起一个「所有路径都回 200 OK」的假服务；返回 (端口, 守卫)。
/// 守卫当前是占位（accept 循环随测试进程退出回收）。
fn spawn_fake_server() -> (u16, FakeServerGuard) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind 空闲端口");
    let port = listener.local_addr().expect("local_addr").port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => break,
            };
            respond_ok(&mut stream);
        }
    });
    thread::sleep(Duration::from_millis(50)); // 监听就绪
    (port, FakeServerGuard)
}

fn respond_ok(stream: &mut TcpStream) {
    let body = "OK";
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
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
}
