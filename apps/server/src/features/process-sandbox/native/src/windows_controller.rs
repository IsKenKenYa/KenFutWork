use crate::windows_conpty::attach_standard_console;
use crate::windows_handles::{ProcessJob, inherited, own};
use crate::windows_output::{AckGate, Emitter, emit, stream_output};
use crate::windows_protocol::{Launch, Request};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;
use wxc_common::sandbox_process::{SandboxProcess, StdioMode};

type Child = Arc<Mutex<Box<dyn SandboxProcess>>>;
type Input = Arc<Mutex<Option<Box<dyn Write + Send>>>>;
type Gates = HashMap<&'static str, Arc<AckGate>>;
enum Command {
    Request(Request),
    Disconnected,
    Finished(Result<i32>),
}

fn response(output: &Emitter, id: String, result: Result<Value>) -> Result<()> {
    match result {
        Ok(value) => emit(output, json!({"id":id,"ok":true,"value":value})),
        Err(error) => emit(
            output,
            json!({"id":id,"ok":false,"error":{"code":"process_closed","message":error.to_string()}}),
        ),
    }
}
fn cancel(gates: &Gates) {
    for gate in gates.values() {
        gate.cancel();
    }
}
fn stream_gate(gates: &Gates, stream: &str) -> Result<Arc<AckGate>> {
    gates.get(stream).cloned().context("命令没有该 ACK 流")
}
fn input_command(id: String, data: Option<String>, stdin: Input, output: Emitter) {
    thread::spawn(move || {
        let result = (|| -> Result<Value> {
            let mut writer = stdin
                .lock()
                .map_err(|_| anyhow::anyhow!("stdin 锁不可用"))?;
            if let Some(data) = data {
                writer
                    .as_mut()
                    .context("stdin 已关闭")?
                    .write_all(data.as_bytes())?;
            } else {
                writer.take();
            }
            Ok(Value::Null)
        })();
        let _ = response(&output, id, result);
    });
}
fn stop_command(id: Option<String>, child: Child, gates: &Gates, output: Emitter) {
    cancel(gates);
    thread::spawn(move || {
        let result = child
            .lock()
            .map_err(|_| anyhow::anyhow!("命令锁不可用"))
            .and_then(|mut child| child.kill().map_err(Into::into))
            .map(|_| Value::Null);
        if let Some(id) = id {
            let _ = response(&output, id, result);
        }
    });
}
fn watch(
    child: Child,
    job: Arc<ProcessJob>,
    input: Input,
    launch: Launch,
    readers: Vec<thread::JoinHandle<Result<()>>>,
    output: Emitter,
    commands: mpsc::Sender<Command>,
) {
    thread::spawn(move || {
        let result = (|| -> Result<i32> {
            loop {
                let code = child
                    .lock()
                    .map_err(|_| anyhow::anyhow!("命令锁不可用"))?
                    .try_wait()?;
                if code.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(launch.yield_ms));
            }
            // MXC ordinary kill is best-effort. Kill first without teardown, then prove only
            // this trusted controller remains in the preassigned outer Job before SDK wait.
            child
                .lock()
                .map_err(|_| anyhow::anyhow!("命令锁不可用"))?
                .kill()?;
            job.wait_active(1, launch.kill_grace_ms, launch.yield_ms)?;
            let code = child
                .lock()
                .map_err(|_| anyhow::anyhow!("命令锁不可用"))?
                .wait()?;
            input
                .lock()
                .map_err(|_| anyhow::anyhow!("stdin 锁不可用"))?
                .take();
            emit(
                &output,
                json!({"event":"native-exit","processId":launch.process_id}),
            )?;
            // ACK dispatch stays on the controller's main loop while these readers join.
            for reader in readers {
                reader
                    .join()
                    .map_err(|_| anyhow::anyhow!("输出线程异常"))??;
            }
            Ok(code)
        })();
        let _ = commands.send(Command::Finished(result));
    });
}

fn run(reader: BufReader<File>, output: Emitter, job: Arc<ProcessJob>) -> Result<()> {
    let mut lines = reader.lines();
    let first = lines.next().context("controller 缺少 launch")??;
    let Request::Spawn { id, launch } = serde_json::from_str::<Request>(&first)? else {
        bail!("controller 首请求必须是 launch");
    };
    let console = if launch.pty.is_some() {
        Some(attach_standard_console()?)
    } else {
        None
    };
    let mode = if launch.pty.is_some() {
        StdioMode::Inherit
    } else {
        StdioMode::Pipes
    };
    let mut child = match crate::windows::spawn_workload(&launch, mode) {
        Ok(child) => child,
        Err(error) => {
            response(&output, id, Err(error))?;
            return Ok(());
        }
    };
    let pid = child.id();
    let input: Input = Arc::new(Mutex::new(child.take_stdin()));
    let mut gates = Gates::new();
    let mut readers = Vec::new();
    if launch.pty.is_none() {
        for (name, stream) in [
            ("stdout", child.take_stdout()),
            ("stderr", child.take_stderr()),
        ] {
            let gate = launch.live_streams.then(|| Arc::new(AckGate::default()));
            if let Some(gate) = &gate {
                gates.insert(name, Arc::clone(gate));
            }
            readers.push(stream_output(
                stream.context("SDK pipe 未接通")?,
                Arc::clone(&output),
                launch.process_id.clone(),
                name,
                launch.chunk_bytes,
                gate,
            ));
        }
    }
    let child = Arc::new(Mutex::new(child));
    response(
        &output,
        id,
        Ok(json!({"pid":pid,"filesystem":"enforced","processRange":"job-object"})),
    )?;
    let (send, receive) = mpsc::channel();
    let incoming = send.clone();
    thread::spawn(move || {
        for line in lines {
            let request = line
                .ok()
                .and_then(|line| serde_json::from_str::<Request>(&line).ok());
            let Some(request) = request else {
                break;
            };
            if incoming.send(Command::Request(request)).is_err() {
                return;
            }
        }
        let _ = incoming.send(Command::Disconnected);
    });
    watch(
        Arc::clone(&child),
        job,
        Arc::clone(&input),
        launch,
        readers,
        Arc::clone(&output),
        send,
    );
    loop {
        match receive.recv()? {
            Command::Request(Request::Stdin { id, data, .. }) => {
                input_command(id, Some(data), Arc::clone(&input), Arc::clone(&output))
            }
            Command::Request(Request::Endstdin { id, .. }) => {
                input_command(id, None, Arc::clone(&input), Arc::clone(&output))
            }
            Command::Request(Request::Stop { id, .. }) => {
                stop_command(Some(id), Arc::clone(&child), &gates, Arc::clone(&output))
            }
            Command::Request(Request::Outputack {
                id,
                stream,
                sequence,
                ..
            }) => response(
                &output,
                id,
                stream_gate(&gates, &stream)
                    .and_then(|gate| gate.acknowledge(sequence))
                    .map(|_| Value::Null),
            )?,
            Command::Request(Request::Outputreader {
                id, stream, active, ..
            }) => response(
                &output,
                id,
                stream_gate(&gates, &stream)
                    .and_then(|gate| gate.reader(active))
                    .map(|_| Value::Null),
            )?,
            Command::Request(_) => bail!("controller 请求无效"),
            Command::Disconnected => {
                stop_command(None, Arc::clone(&child), &gates, Arc::clone(&output))
            }
            Command::Finished(result) => {
                drop(console);
                match result {
                    Ok(code) => emit(
                        &output,
                        json!({"event":"exit","exitCode":code,"rangeEmpty":true}),
                    )?,
                    Err(error) => {
                        cancel(&gates);
                        emit(
                            &output,
                            json!({"event":"failure","message":error.to_string()}),
                        )?;
                    }
                }
                return Ok(());
            }
        }
    }
}

pub fn serve(arguments: &[String]) -> Result<()> {
    ensure!(arguments.len() == 3, "controller 参数无效");
    let read = File::from(own(arguments[0].parse::<usize>()? as _)?);
    let write = File::from(own(arguments[1].parse::<usize>()? as _)?);
    inherited(read.as_raw_handle(), false)?;
    inherited(write.as_raw_handle(), false)?;
    let job = Arc::new(ProcessJob::from_query(own(
        arguments[2].parse::<usize>()? as _,
    )?)?);
    let output: Emitter = Arc::new(Mutex::new(Box::new(write)));
    run(BufReader::new(read), output, job)
}
