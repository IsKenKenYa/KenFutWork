use crate::windows_conpty::PseudoConsole;
use crate::windows_handles::{ProcessJob, pipe};
use crate::windows_launch::start_controller;
use crate::windows_output::{AckGate, Emitter, emit, stream_output};
use crate::windows_protocol::{Launch, Request};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

pub struct NativeProcess {
    job: Arc<ProcessJob>,
    process: OwnedHandle,
    control: Mutex<File>,
    input: Mutex<Option<File>>,
    console: Option<Arc<PseudoConsole>>,
    gate: Option<Arc<AckGate>>,
    initial: AtomicBool,
    terminal: AtomicBool,
    yield_ms: u64,
    grace_ms: u64,
    stops: Mutex<HashSet<String>>,
    chunk_bytes: usize,
}
impl NativeProcess {
    pub fn spawn(launch: &Launch) -> Result<(Arc<Self>, File, Option<File>)> {
        let job = Arc::new(ProcessJob::new()?);
        let (control_read, control_write) = pipe(true, false)?;
        let (events_read, events_write) = pipe(false, true)?;
        let (console, input, output) = if let Some(size) = &launch.pty {
            let (console, input, output) = PseudoConsole::create(size)?;
            (Some(console), Some(input), Some(output))
        } else {
            (None, None, None)
        };
        let (process, _) =
            start_controller(&job, &control_read, &events_write, console.as_deref())?;
        drop(control_read);
        drop(events_write);
        Ok((
            Arc::new(Self {
                job,
                process,
                control: Mutex::new(control_write),
                input: Mutex::new(input),
                console,
                gate: launch.pty.as_ref().map(|_| Arc::new(AckGate::default())),
                initial: AtomicBool::new(false),
                terminal: AtomicBool::new(false),
                yield_ms: launch.yield_ms,
                grace_ms: launch.kill_grace_ms,
                stops: Mutex::new(HashSet::new()),
                chunk_bytes: launch.chunk_bytes,
            }),
            events_read,
            output,
        ))
    }
    pub fn forward(&self, request: &Request) -> Result<()> {
        ensure!(
            !self.terminal.load(Ordering::Acquire),
            "命令 controller 已结束"
        );
        let mut input = self
            .control
            .lock()
            .map_err(|_| anyhow::anyhow!("controller IPC 锁不可用"))?;
        serde_json::to_writer(&mut *input, request)?;
        input.write_all(b"\n")?;
        input.flush()?;
        Ok(())
    }
    pub fn write_pty(&self, data: &str) -> Result<()> {
        self.input
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY stdin 锁不可用"))?
            .as_mut()
            .context("PTY 已关闭")?
            .write_all(data.as_bytes())?;
        Ok(())
    }
    fn chunk_bytes(&self) -> usize {
        self.chunk_bytes
    }
    pub fn scope_empty(&self) -> bool {
        self.job.active().ok() == Some(0)
    }
    pub fn is_pty(&self) -> bool {
        self.console.is_some()
    }
    pub fn resize(&self, cols: i16, rows: i16) -> Result<()> {
        self.console
            .as_ref()
            .context("命令没有 ConPTY")?
            .resize(cols, rows)
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<()> {
        self.gate
            .as_ref()
            .context("命令没有 ConPTY ACK")?
            .acknowledge(sequence)
    }
    pub fn reader(&self, active: bool) -> Result<()> {
        self.gate
            .as_ref()
            .context("命令没有 ConPTY reader")?
            .reader(active)
    }
    pub fn stop(&self, request: &Request) -> Result<bool> {
        if let Some(gate) = &self.gate {
            gate.cancel();
        }
        if self.terminal.load(Ordering::Acquire) {
            return Ok(true);
        }
        if !self.initial.load(Ordering::Acquire) {
            self.job.terminate()?;
            self.job.wait_active(0, self.grace_ms, self.yield_ms)?;
            Ok(true)
        } else {
            if let Request::Stop { id, .. } = request {
                self.stops
                    .lock()
                    .map_err(|_| anyhow::anyhow!("stop 锁不可用"))?
                    .insert(id.clone());
            }
            if self.forward(request).is_err() {
                self.terminate()?;
                return Ok(true);
            }
            Ok(false)
        }
    }
    pub fn terminate(&self) -> Result<()> {
        if let Some(gate) = &self.gate {
            gate.cancel();
        }
        self.job.terminate()?;
        self.job.wait_active(0, self.grace_ms, self.yield_ms)
    }
}

fn proxy_control(
    read: File,
    process: Arc<NativeProcess>,
    output: Emitter,
    process_id: String,
    spawn_id: String,
    outcome: Arc<Mutex<Option<Value>>>,
    initial_error: Arc<Mutex<Option<Value>>>,
) -> thread::JoinHandle<Result<()>> {
    thread::spawn(move || {
        for line in BufReader::new(read).lines() {
            let mut message: Value = serde_json::from_str(&line?)?;
            if let Some(id) = message["id"].as_str().map(str::to_owned) {
                let stopping = process
                    .stops
                    .lock()
                    .map_err(|_| anyhow::anyhow!("stop 锁不可用"))?
                    .remove(&id);
                if stopping && message["ok"] == false {
                    match process.terminate() {
                        Ok(()) => {
                            message = json!({"id":id,"ok":true,"value":null});
                        }
                        Err(error) => {
                            let _ = emit(
                                &output,
                                json!({"event":"failure","processId":process_id,"code":"stop_unconfirmed","message":error.to_string()}),
                            );
                            message = json!({"id":id,"ok":false,"error":{"code":"stop_unconfirmed","message":error.to_string()}});
                        }
                    }
                }
            }
            if message["id"].as_str() == Some(&spawn_id) {
                process.initial.store(true, Ordering::Release);
                if message["ok"] == false {
                    *initial_error
                        .lock()
                        .map_err(|_| anyhow::anyhow!("spawn 锁不可用"))? = Some(message);
                    continue;
                }
            }
            match message["event"].as_str() {
                Some("exit" | "failure") => {
                    *outcome
                        .lock()
                        .map_err(|_| anyhow::anyhow!("exit 锁不可用"))? = Some(message);
                }
                Some("native-exit") => {
                    // Send the reaper fact before unpausing a no-reader ConPTY capture stream.
                    emit(
                        &output,
                        json!({"event":"native-exit","processId":process_id}),
                    )?;
                    if let Some(gate) = &process.gate {
                        gate.natural_pty_exit()?;
                    }
                }
                _ => {
                    emit(&output, message)?;
                }
            }
        }
        Ok(())
    })
}

pub fn watch(
    process: Arc<NativeProcess>,
    read: File,
    pty_output: Option<File>,
    output: Emitter,
    process_id: String,
    spawn_id: String,
) {
    let outcome = Arc::new(Mutex::new(None));
    let initial_error = Arc::new(Mutex::new(None));
    let control = proxy_control(
        read,
        Arc::clone(&process),
        Arc::clone(&output),
        process_id.clone(),
        spawn_id.clone(),
        Arc::clone(&outcome),
        Arc::clone(&initial_error),
    );
    let terminal_reader = pty_output.map(|reader| {
        stream_output(
            Box::new(reader),
            Arc::clone(&output),
            process_id.clone(),
            "stdout",
            process.chunk_bytes(),
            process.gate.clone(),
        )
    });
    thread::spawn(move || {
        let result = (|| -> Result<Value> {
            loop {
                let status = unsafe { WaitForSingleObject(process.process.as_raw_handle(), 0) };
                if status == WAIT_OBJECT_0 {
                    break;
                }
                ensure!(status == WAIT_TIMEOUT, "controller wait 失败");
                thread::sleep(Duration::from_millis(process.yield_ms));
            }
            control
                .join()
                .map_err(|_| anyhow::anyhow!("controller IPC 线程异常"))??;
            let reported = outcome
                .lock()
                .map_err(|_| anyhow::anyhow!("exit 锁不可用"))?
                .take();
            if reported
                .as_ref()
                .and_then(|value| value["rangeEmpty"].as_bool())
                != Some(true)
            {
                process.terminate()?;
            }
            process
                .job
                .wait_active(0, process.grace_ms, process.yield_ms)?;
            if let Some(console) = &process.console {
                console.close()?;
            }
            if let Some(reader) = terminal_reader {
                reader
                    .join()
                    .map_err(|_| anyhow::anyhow!("ConPTY 输出线程异常"))??;
            }
            Ok(reported.unwrap_or_else(
                || json!({"event":"failure","message":"controller 未提供用户退出回执"}),
            ))
        })();
        let code = result
            .as_ref()
            .ok()
            .and_then(|value| value["exitCode"].as_i64());
        let failure = result
            .as_ref()
            .err()
            .map(|error| error.to_string())
            .or_else(|| {
                result
                    .as_ref()
                    .ok()
                    .and_then(|value| value["message"].as_str().map(str::to_owned))
            });
        if let Some(message) = &failure {
            if let Some(gate) = &process.gate {
                gate.cancel();
            }
            let _ = process.terminate();
            let _ = emit(
                &output,
                json!({"event":"failure","processId":process_id,"code":"output_failed","message":message}),
            );
            if let Some(console) = &process.console {
                let _ = console.close();
            }
        }
        process.terminal.store(true, Ordering::Release);
        let empty = process.scope_empty();
        let _ = emit(
            &output,
            json!({"event":"exit","processId":process_id,"exitCode":code,"rangeEmpty":empty,"failure":failure}),
        );
        if let Ok(mut initial) = initial_error.lock() {
            if let Some(mut error) = initial.take() {
                error["error"]["code"] = json!(if empty {
                    "enforcement_unavailable"
                } else {
                    "stop_unconfirmed"
                });
                let _ = emit(&output, error);
            } else if !process.initial.load(Ordering::Acquire) {
                let _ = emit(
                    &output,
                    json!({"id":spawn_id,"ok":false,"error":{"code":if empty { "enforcement_unavailable" } else { "stop_unconfirmed" },"message":"原生 controller 在启动回执前退出"}}),
                );
            }
        }
    });
}
