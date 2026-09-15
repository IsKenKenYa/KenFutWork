//! 服务端生命周期管理（R4-Tauri 生命周期契约）。
//!
//! 职责：把「服务端进程」当作 Rust 侧的一个可管理资源——参数化配置拉起、
//! `/api/health` 探活等待、优雅退出、drop 即回收（孤儿防护）。
//!
//! 契约（2026-09-15 拍板，每条对应 tests/server_lifecycle.rs 一个用例）：
//!   1. 健康探活：GET /api/health 轮询直到 200，默认 90s 超时 fail loud；
//!   2. 端口占用复用：探活已健康则不 spawn，直接复用（尊重用户自己起的 dev）；
//!   3. 退出：SIGTERM → 宽限 10s → SIGKILL；handle drop 同样触发回收；
//!   4. 数据目录：由壳（tauri app_data_dir）解析后经 `LOOMIC_DATA_DIR` 注入子进程。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HEALTH_PATH: &str = "/api/health";
const PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// 服务端拉起配置：命令、参数、工作目录与端口全部显式，不硬编码在实现里。
pub struct ServerSpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// 注入子进程 `LOOMIC_DATA_DIR`（桌面数据与开发目录彻底分离）。
    pub data_dir: PathBuf,
    pub port: u16,
    /// 健康探活超时（dev 首次 tsx 编译慢，默认 90 秒）。
    pub health_timeout: Duration,
}

impl ServerSpawnConfig {
    pub fn new(command: &str, args: Vec<String>, data_dir: PathBuf, port: u16) -> Self {
        Self {
            command: command.to_string(),
            args,
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            data_dir,
            port,
            health_timeout: Duration::from_secs(90),
        }
    }
}

/// 探活结果（结构体而非裸 bool：后续可挂 version 等字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthStatus {
    pub healthy: bool,
}

#[derive(Debug)]
pub struct ProbeError {
    pub port: u16,
    pub timeout: Duration,
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "服务端健康探活超时（端口 {}，等待 {}s）：服务未在时限内就绪。",
            self.port,
            self.timeout.as_secs()
        )
    }
}

impl std::error::Error for ProbeError {}

/**
 * 轮询 `/api/health` 直到 200 或超时（fail loud，不静默降级）。
 * 单次探测 = TCP 连上后发一条 HTTP/1.0 GET，读状态行判 200——不引 HTTP 客户端依赖。
 */
pub fn probe_health(port: u16, timeout: Duration) -> Result<HealthStatus, ProbeError> {
    let deadline = Instant::now() + timeout;
    loop {
        if health_once(port) {
            return Ok(HealthStatus { healthy: true });
        }
        if Instant::now() >= deadline {
            return Err(ProbeError { port, timeout });
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

fn health_once(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET {HEALTH_PATH} HTTP/1.0\r\nhost: 127.0.0.1\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0u8; 128];
    let Ok(read) = stream.read(&mut buffer) else {
        return false;
    };
    // 状态行形如 "HTTP/1.1 200 OK"：找 " 200"（4 字节窗口）
    read > 0 && buffer[..read].windows(4).any(|w| w == b" 200")
}

// ── 生命周期：拉起 / 复用 / 优雅退出（契约 2/3/4） ──────────────────────────

/// 拉起结果：端口已健康 → `Reused`（尊重用户自己起的 dev）；否则 `Spawned` 持有句柄。
pub enum ServerLaunch {
    Reused,
    Spawned(ServerHandle),
}

#[derive(Debug)]
pub enum LifecycleError {
    Probe(ProbeError),
    Spawn(std::io::Error),
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LifecycleError::Probe(error) => write!(f, "{error}"),
            LifecycleError::Spawn(error) => {
                write!(f, "服务端进程拉起失败：{error}")
            }
        }
    }
}

impl std::error::Error for LifecycleError {}

/**
 * 确保服务端在 `config.port` 上健康：已健康 → 复用不 spawn；
 * 未健康 → spawn 子进程（注入 `LOOMIC_DATA_DIR`）并探活等待，失败即回收子进程。
 */
pub fn ensure_server_running(
    config: ServerSpawnConfig,
) -> Result<ServerLaunch, LifecycleError> {
    if health_once(config.port) {
        return Ok(ServerLaunch::Reused);
    }

    let mut child = Command::new(&config.command)
        .args(&config.args)
        .current_dir(&config.cwd)
        .env("LOOMIC_DATA_DIR", &config.data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(LifecycleError::Spawn)?;

    match probe_health(config.port, config.health_timeout) {
        Ok(_) => Ok(ServerLaunch::Spawned(ServerHandle { child })),
        Err(probe) => {
            // 探活失败不留半启动态：立刻回收子进程再报错
            let _ = child.kill();
            let _ = child.wait();
            Err(LifecycleError::Probe(probe))
        }
    }
}

/// 运行中的服务端子进程句柄：drop 即强杀（孤儿防护）；
/// 优雅退出走 `shutdown`（TERM → 宽限 → KILL）。
pub struct ServerHandle {
    child: Child,
}

impl ServerHandle {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /**
     * 优雅退出：先发优雅信号（Unix=SIGTERM / Windows=taskkill 不带 /F），
     * 在宽限期内轮询退出；超时升级 `kill`（SIGKILL）。幂等。
     */
    pub fn shutdown(&mut self, grace: Duration) {
        if self.try_wait_exited().unwrap_or(true) {
            return;
        }
        self.send_graceful_signal();
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if self.try_wait_exited().unwrap_or(true) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn try_wait_exited(&mut self) -> std::io::Result<bool> {
        Ok(self.child.try_wait()?.is_some())
    }

    fn send_graceful_signal(&self) {
        let pid = self.child.id();
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        #[cfg(windows)]
        {
            // taskkill 不带 /F = 温和请求关闭
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string()]).status();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        // 孤儿防护：句柄消失而子进程未退（panic/早退路径）→ 强杀，不留后台残留
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
