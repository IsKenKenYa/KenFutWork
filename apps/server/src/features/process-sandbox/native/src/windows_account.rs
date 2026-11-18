//! 显式账户级执行；进程仍继承预先绑定的外层 Job，不使用 PSEC，也不提升令牌。
use crate::windows_handles::ProcessJob;
use crate::windows_protocol::Launch;
use anyhow::{Result, ensure};
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use wxc_common::sandbox_process::{SandboxProcess, StdioMode, join_discard, spawn_discard};

struct AccountProcess {
    child: Option<Child>,
    pid: u32,
    code: Option<i32>,
    job: Arc<ProcessJob>,
    grace_ms: u64,
    yield_ms: u64,
}

impl SandboxProcess for AccountProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.child
            .as_mut()?
            .stdin
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Write + Send>)
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .as_mut()?
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .as_mut()?
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>)
    }
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if self.code.is_some() {
            return Ok(self.code);
        }
        let status = self.child.as_mut().expect("账户命令句柄").try_wait()?;
        if let Some(status) = status {
            self.code = Some(status.code().unwrap_or(1));
            self.child.take();
        }
        Ok(self.code)
    }
    fn id(&self) -> u32 {
        self.pid
    }
    fn kill(&mut self) -> std::io::Result<()> {
        let started = Instant::now();
        loop {
            self.try_wait()?;
            if self
                .job
                .terminate_workloads()
                .map_err(std::io::Error::other)?
                == 0
            {
                return Ok(());
            }
            if started.elapsed() >= Duration::from_millis(self.grace_ms) {
                return Err(std::io::Error::other("账户命令的 Job 工作负载尚未退出"));
            }
            thread::sleep(Duration::from_millis(self.yield_ms));
        }
    }
    fn wait(&mut self) -> std::io::Result<i32> {
        if let Some(code) = self.code {
            return Ok(code);
        }
        let mut child = self.child.take().expect("账户命令句柄");
        let stdout = spawn_discard(child.stdout.take());
        let stderr = spawn_discard(child.stderr.take());
        let status = child.wait()?;
        drop(child);
        join_discard(stdout);
        join_discard(stderr);
        let code = status.code().unwrap_or(1);
        self.code = Some(code);
        Ok(code)
    }
}

pub fn spawn_account(
    input: &Launch,
    mode: StdioMode,
    job: Arc<ProcessJob>,
) -> Result<Box<dyn SandboxProcess>> {
    ensure!(input.unrestricted, "账户执行必须显式授权");
    let executable = input
        .command
        .first()
        .ok_or_else(|| anyhow::anyhow!("账户命令为空"))?;
    let mut command = Command::new(executable);
    if crate::windows::is_cmd_exe(executable)
        && input.command.len() == 5
        && input.command[1..4] == ["/d", "/s", "/c"]
    {
        command.raw_arg(format!("/d /s /c \"{}\"", input.command[4]));
    } else {
        command.args(&input.command[1..]);
    }
    command.current_dir(&input.cwd).env_clear().envs(&input.env);
    match mode {
        StdioMode::Pipes => {
            command
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        }
        StdioMode::Inherit => {
            command
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
        }
    }
    let child = command.spawn()?;
    Ok(Box::new(AccountProcess {
        pid: child.id(),
        child: Some(child),
        code: None,
        job,
        grace_ms: input.kill_grace_ms,
        yield_ms: input.yield_ms,
    }))
}
