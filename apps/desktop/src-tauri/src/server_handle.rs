//! 服务端生命周期管理（R4-Tauri 生命周期契约）。
//!
//! 职责：把「服务端进程」当作 Rust 侧的一个可管理资源——参数化配置拉起、
//! `/api/health` 探活等待、优雅退出、drop 即回收（孤儿防护）。
//!
//! 契约（2026-09-15 拍板，每条对应 tests/server_lifecycle.rs 一个用例）：
//!   1. 健康探活：GET /api/health 轮询直到 200，默认 90s 超时 fail loud；
//!   2. 端口占用复用：探活已健康则不 spawn，直接复用（尊重用户自己起的 dev）；
//!   3. 退出：SIGTERM → 宽限 10s → SIGKILL；handle drop 同样触发回收；
//!   4. 数据目录：由壳（tauri app_data_dir）解析后经 `KENFUTWORK_DATA_DIR` 注入子进程。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HEALTH_PATH: &str = "/api/health";
const PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// `CREATE_NO_WINDOW`：子进程不分配控制台（否则 GUI 壳拉起控制台程序会弹黑框）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/**
 * Windows 作业对象：把服务端进程绑进一个 job，后代（内嵌 Postgres 全家）自动同属其中。
 *
 * 为什么必须用 job 而不是 `taskkill /T`：`/T` 是**顺着父子链**找后代的，父进程一退链就断了——
 * 实测「先杀掉服务端再收树」时 `postgres.exe` 全家活得好好的（卸载删不掉文件、下次启动还会
 * 撞上残留实例）。job 由内核记账，不依赖进程是否还在，且 `KILL_ON_JOB_CLOSE` 让**壳被强杀**
 * （任务管理器 / 安装器杀进程）时也照样收干净。
 */
#[cfg(windows)]
mod job {
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct ProcessJob(HANDLE);

    // 句柄只是内核对象的引用，跨线程用（CloseHandle / TerminateJobObject）是安全的；
    // 不加这两行，`*mut c_void` 会让整个 ServerHandle 不能进 tauri 的托管状态（必须是 Send+Sync）。
    unsafe impl Send for ProcessJob {}
    unsafe impl Sync for ProcessJob {}

    impl ProcessJob {
        /// 建一个「最后一个句柄关闭即杀光」的 job。
        pub fn create() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                unsafe { CloseHandle(handle) };
                return Err(error);
            }
            Ok(Self(handle))
        }

        pub fn assign(&self, process: HANDLE) -> io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, process) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// 立刻杀光 job 里的所有进程（`taskkill /T /F` 的可靠版本）。
        pub fn terminate(&self) {
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            // 关句柄 = 触发 KILL_ON_JOB_CLOSE（再上一道保险）
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// 服务端拉起配置：命令、参数、工作目录与端口全部显式，不硬编码在实现里。
pub struct ServerSpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// 注入子进程 `KENFUTWORK_DATA_DIR`（桌面数据与开发目录彻底分离）。
    pub data_dir: PathBuf,
    pub port: u16,
    /**
     * 额外注入子进程的环境变量（打包态用：内嵌 PG / 免登录 / 静态 UI 目录…）。
     * dev 形态留空——那时服务端读仓库的 `.env.local`。
     */
    pub env: Vec<(String, String)>,
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
            env: Vec::new(),
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

/// 端口当前是否**可被我们绑定**（无人监听才算空闲；别人绑了 0.0.0.0 也算占用）。
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/**
 * 「这个端口上坐的是不是**托管着界面的**自己人」：`GET /` 返回 200 且首块是 HTML。
 *
 * **为什么必须判它**：打包态的窗口要指向服务端托管的 UI（local-trust 只认回环来源，
 * 壳自带的 `tauri://localhost` 既不是回环、它的资源协议也解析不了 `/canvas` 这种
 * 无扩展名路由）。而 `probe_health` 只证明「有东西在听」——用户自己的 dev API、
 * 别的软件占着 3001 时照样 200，窗口就会停在 `{"message":"Route GET:/ not found"}` 上。
 * 2026-09-17 真机撞到过（截图即该 404 页面），此函数是那次事故的判据。
 */
pub fn probe_serves_ui(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ui_once(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

fn ui_once(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = "GET / HTTP/1.0\r\nhost: 127.0.0.1\r\naccept: text/html\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    // 响应可能分包到达（状态行/头/体）：累积到认出 HTML 或到量为止
    let mut body = Vec::new();
    let mut chunk = [0u8; 1024];
    while body.len() < 8192 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
        let text = String::from_utf8_lossy(&body).to_lowercase();
        if text.contains("<html") || text.contains("<!doctype") {
            break;
        }
    }
    if body.is_empty() {
        return false;
    }
    let text = String::from_utf8_lossy(&body).to_lowercase();
    let is_ok = text.contains(" 200");
    is_ok && (text.contains("<html") || text.contains("<!doctype"))
}

// ── 生命周期：拉起 / 复用 / 优雅退出（契约 2/3/4） ──────────────────────────

/**
 * 起一个**不弹控制台**的辅助命令。
 *
 * 桌面壳是 GUI 进程（`windows_subsystem = "windows"`，自己没有控制台），
 * 这种进程 spawn 一个控制台程序时 Windows 会**新开一个控制台窗口**——
 * 用户看到的「关闭应用时闪一个 cmd 黑框」就是退出路径上的 `taskkill` 干的
 * （2026-09-19 反馈）。所有辅助命令一律走这里。
 */
fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 拉起结果：端口已健康 → `Reused`（尊重用户自己起的 dev）；否则 `Spawned` 持有句柄。
pub enum ServerLaunch {
    Reused,
    Spawned(ServerHandle),
}

#[derive(Debug)]
pub enum LifecycleError {
    Probe(ProbeError),
    /// 探活超时，且已取得子进程退出状态——这是「spawn 后立刻死」的可诊断信号
    /// （包名拼错、依赖未构建等），与「还在启动中」的超时区分开（2026-09-17 事故）。
    ProbeChildExited {
        probe: ProbeError,
        child_status: String,
        log_path: PathBuf,
    },
    Spawn(std::io::Error),
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LifecycleError::Probe(error) => write!(f, "{error}"),
            LifecycleError::ProbeChildExited {
                probe,
                child_status,
                log_path,
            } => write!(
                f,
                "{probe}；子进程已提前退出（{child_status}）——服务端启动即失败，日志见 {log_path:?}"
            ),
            LifecycleError::Spawn(error) => {
                write!(f, "服务端进程拉起失败：{error}")
            }
        }
    }
}

impl std::error::Error for LifecycleError {}

/// 子进程 stdout/stderr 落盘（不吞）：`<data_dir>/logs/server-spawn.log`，
/// 打包态与 dev 态同一位置，是「spawn 即死」类故障的唯一诊断面。
fn open_spawn_log(data_dir: &std::path::Path) -> Option<std::fs::File> {
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("server-spawn.log"))
        .ok()
}

/**
 * 确保服务端在 `config.port` 上健康：已健康 → 复用不 spawn；
 * 未健康 → spawn 子进程（注入 `KENFUTWORK_DATA_DIR`）并探活等待，失败即回收子进程。
 */
pub fn ensure_server_running(
    config: ServerSpawnConfig,
) -> Result<ServerLaunch, LifecycleError> {
    if health_once(config.port) {
        return Ok(ServerLaunch::Reused);
    }

    let spawn_log = open_spawn_log(&config.data_dir);
    let stderr = match &spawn_log {
        Some(file) => Stdio::from(file.try_clone().map_err(LifecycleError::Spawn)?),
        None => Stdio::null(),
    };
    let stdout = match spawn_log {
        Some(file) => Stdio::from(file.try_clone().map_err(LifecycleError::Spawn)?),
        None => Stdio::null(),
    };

    let mut command = Command::new(&config.command);
    command
        .args(&config.args)
        .current_dir(&config.cwd)
        .env("KENFUTWORK_DATA_DIR", &config.data_dir)
        .envs(config.env.iter().map(|(key, value)| (key, value)))
        .stdout(stdout)
        .stderr(stderr);
    // Unix 收树的前提：子进程必须是**进程组组长**（pgid = 自己的 pid），
    // 否则 `kill -KILL -{pid}` 报「No such process」、后代（内嵌 Postgres）全部变孤儿。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // 桌面壳是 GUI 进程（`windows_subsystem = "windows"`，本身没有控制台）；不给子进程
    // 加这个标志，Windows 会**为子进程新开一个控制台窗口**——用户看到的就是那个一闪而过
    // 或常驻的黑框 cmd 提示符（2026-09-17 用户明确要求去掉）。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(LifecycleError::Spawn)?;

    // 立刻绑进 job：越早越好——绑上之后服务端再拉起的任何后代（内嵌 Postgres）都自动入 job
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle;
        match job::ProcessJob::create() {
            Ok(job) => match job.assign(child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE) {
                Ok(()) => Some(job),
                Err(error) => {
                    eprintln!("[desktop] 绑定作业对象失败（后代回收降级为 taskkill /T）：{error}");
                    None
                }
            },
            Err(error) => {
                eprintln!("[desktop] 创建作业对象失败（后代回收降级为 taskkill /T）：{error}");
                None
            }
        }
    };

    match probe_health(config.port, config.health_timeout) {
        Ok(_) => Ok(ServerLaunch::Spawned(ServerHandle {
            child,
            #[cfg(windows)]
            job,
        })),
        Err(probe) => {
            // 探活失败不留半启动态：回收子进程；若子进程早已退出，把退出状态
            // 写进错误（「包名拼错/依赖没建」这类秒死故障一眼可诊，不再干等盲猜）
            let child_status = child
                .try_wait()
                .map(|status| status.map_or("仍在运行".to_string(), |s| s.to_string()))
                .unwrap_or_else(|_| "未知（wait 失败）".to_string());
            let _ = child.kill();
            let _ = child.wait();
            Err(LifecycleError::ProbeChildExited {
                probe,
                child_status,
                log_path: config.data_dir.join("logs").join("server-spawn.log"),
            })
        }
    }
}

/// 运行中的服务端子进程句柄：drop 即强杀（孤儿防护）；
/// 优雅退出走 `shutdown`（TERM → 宽限 → KILL）。
pub struct ServerHandle {
    child: Child,
    /// Windows：把服务端与其后代绑在一起的作业对象（关闭即杀光）。
    #[cfg(windows)]
    job: Option<job::ProcessJob>,
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
        if !self.try_wait_exited().unwrap_or(true) {
            self.send_graceful_signal();
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                if self.try_wait_exited().unwrap_or(true) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        // **不论直接子进程是否已退都要收后代**：Windows 上父进程一退，父子链就断了，
        // `taskkill /T` 再也找不到它们（内嵌 Postgres 就是这么留下来的）
        self.reap_descendants();
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
            // taskkill 不带 /F = 温和请求关闭（对控制台程序常常无效，兜底见 reap_descendants）
            // 走 hidden_command：GUI 壳里直接 spawn taskkill 会弹一个 cmd 黑框（关闭应用时可见）
            let _ = hidden_command("taskkill")
                .args(["/PID", &pid.to_string()])
                .status();
        }
    }

    /**
     * 连**子进程的后代**一起收掉。
     *
     * 服务端自己会拉起内嵌 Postgres；Windows 上 GUI 壳**无法给控制台子进程送优雅信号**
     * （`taskkill` 不带 `/F` 只对带窗口的进程有效），所以这里必须收整棵树。
     * 首选作业对象（内核记账，父进程死活都能收）；没有 job 时退化成 `taskkill /T /F`
     * （只在父进程还活着时有效——所以 job 不可用是**降级**而不是等价）。
     * 2026-09-19 真机实测：收不干净时卸载残留 51 MB、`app\pg\bin` 下 12 个 `postgres.exe` 还在跑。
     */
    fn reap_descendants(&mut self) {
        #[cfg(windows)]
        {
            match &self.job {
                Some(job) => job.terminate(),
                None => {
                    let pid = self.child.id();
                    let _ = hidden_command("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
                }
            }
        }
        #[cfg(unix)]
        {
            // 子进程继承壳的进程组时 kill(-pid) 会连带收掉它的后代
            let pid = self.child.id();
            let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
        }
        let _ = self.child.kill();
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        // 孤儿防护：句柄消失而子进程未退（panic/早退路径）→ 连后代一起强杀
        self.reap_descendants();
        let _ = self.child.wait();
    }
}
