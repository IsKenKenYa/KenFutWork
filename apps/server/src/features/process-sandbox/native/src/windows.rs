//! Codex e53e932 mxc-sandbox native/policy 的 KFW 宿主适配。
//! Copyright OpenAI. Apache-2.0. 下层固定 Microsoft MXC 为 MIT，见 ../licenses。
//! Task-scoped Windows broker. User execution remains MXC/PSEC; private controllers
//! are assigned to strict outer Jobs before receiving any user argv or environment.
use crate::windows_output::{Emitter, emit};
use crate::windows_process::{NativeProcess, watch};
use crate::windows_protocol::{Launch, Request};
use anyhow::{Result, ensure};
use appcontainer_common::base_container_runner::BaseContainerRunner;
use learning_mode_windows::SecurityEnvironmentApi;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use wxc_common::cmdline::{CommandLineContext, cmdline_from_argv_for_context};
use wxc_common::filesystem_object::normalize_object_conflicts;
use wxc_common::logger::{Logger, Mode};
use wxc_common::models::{
    BaseProcessUiConfig, ContainerPolicy, ExecutionRequest, FallbackPolicy, NetworkAction,
    NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy, UiPolicy,
};
use wxc_common::sandbox_process::{SandboxBackend, SandboxProcess, StdioMode};
#[link(name = "advapi32")]
unsafe extern "system" {}

pub fn capability_probe() -> Result<()> {
    ensure!(
        BaseContainerRunner::is_process_security_environment_usable(),
        "此 Windows build 没有可用的原生 PSEC 读取域；拒绝不受约束执行"
    );
    ensure!(
        SecurityEnvironmentApi::load()?.supports_deny_paths()?,
        "此 Windows build 无法落实目录拒绝规则"
    );
    Ok(())
}

// 此 policy/launch 形状由 Codex mxc-sandbox 的一手实现改编，不含其 AgentLoop。
fn execution_request(input: &Launch) -> Result<ExecutionRequest> {
    ensure!(
        !input.task_id.is_empty() && input.generation > 0,
        "Task 执行身份或授权版本无效"
    );
    ensure!(
        !input.command.is_empty() && PathBuf::from(&input.cwd).is_absolute(),
        "命令或 cwd 无效"
    );
    ensure!(
        input.yield_ms > 0 && input.chunk_bytes > 0 && input.kill_grace_ms > 0,
        "进程限额无效"
    );
    for path in input
        .read_roots
        .iter()
        .chain(&input.write_roots)
        .chain(&input.deny_roots)
    {
        ensure!(PathBuf::from(path).is_absolute(), "目录授权必须是绝对路径");
    }
    let mut policy = ContainerPolicy {
        capabilities: vec!["registryRead".to_owned()],
        readwrite_paths: input.write_roots.clone(),
        readonly_paths: input.read_roots.clone(),
        denied_paths: input.deny_roots.clone(),
        fallback: FallbackPolicy {
            allow_dacl_mutation: false,
        },
        default_network_policy: NetworkPolicy::Block,
        allow_local_network: false,
        network_egress: Some(NetworkEgressPolicy {
            default: NetworkAction::Deny,
            ..Default::default()
        }),
        network_ingress: Some(NetworkIngressPolicy {
            default: NetworkAction::Deny,
            host_loopback: NetworkAction::Deny,
        }),
        network_specified: true,
        network_mode_specified: true,
        ui: UiPolicy {
            disable: false,
            ..Default::default()
        },
        base_process_ui: BaseProcessUiConfig {
            isolation: "desktop".to_owned(),
            ..Default::default()
        },
        ..Default::default()
    };
    if let Some(normalized) = normalize_object_conflicts(&policy, &mut Logger::new(Mode::Buffer))
        .map_err(|_| anyhow::anyhow!("原生目录 policy 无法规范化"))?
    {
        policy = normalized;
    }
    Ok(ExecutionRequest {
        container_id: format!("kfw-{}", input.process_id),
        script_code: cmdline_from_argv_for_context(
            &input.command,
            CommandLineContext::WindowsCreateProcess,
        )?,
        working_directory: input.cwd.clone(),
        env: input
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect(),
        // SDK 的 0 表示无 deadline；截止时间由 Node owner 的治理值管理。
        script_timeout: 0,
        policy,
        ..Default::default()
    })
}

pub fn spawn_workload(input: &Launch, mode: StdioMode) -> Result<Box<dyn SandboxProcess>> {
    capability_probe()?;
    let request = execution_request(input)?;
    ensure!(
        !request
            .policy
            .capabilities
            .iter()
            .any(|item| item == "permissiveLearningMode"),
        "不允许学习模式降级"
    );
    let child = BaseContainerRunner::new()
        .spawn(&request, &mut Logger::new(Mode::Buffer), mode)
        .map_err(|_| anyhow::anyhow!("原生 Windows sandbox 启动失败；拒绝未经约束执行"))?;
    ensure!(
        child.warnings().is_empty(),
        "后端报告降级 containment，拒绝执行"
    );
    Ok(child)
}

type Processes = HashMap<String, Arc<NativeProcess>>;
fn process(processes: &Processes, id: &str) -> Result<Arc<NativeProcess>> {
    processes
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("命令句柄不存在"))
}
fn reply_as(output: &Emitter, id: String, result: Result<Value>, code: &str) -> Result<()> {
    match result {
        Ok(value) => emit(output, json!({"id":id,"ok":true,"value":value})),
        Err(error) => emit(
            output,
            json!({"id":id,"ok":false,"error":{"code":code,"message":error.to_string()}}),
        ),
    }
}
fn reply(output: &Emitter, id: String, result: Result<Value>) -> Result<()> {
    reply_as(output, id, result, "enforcement_unavailable")
}
fn spawn(id: String, launch: Launch, processes: &mut Processes, output: &Emitter) -> Result<()> {
    capability_probe()?;
    execution_request(&launch)?;
    ensure!(!processes.contains_key(&launch.process_id), "命令身份重复");
    let (child, control, terminal) = NativeProcess::spawn(&launch)?;
    processes.insert(launch.process_id.clone(), Arc::clone(&child));
    watch(
        Arc::clone(&child),
        control,
        terminal,
        Arc::clone(output),
        launch.process_id.clone(),
        id.clone(),
    );
    if let Err(error) = child.forward(&Request::Spawn { id, launch }) {
        child.terminate()?;
        return Err(error);
    }
    Ok(())
}
fn stop_all(processes: &Processes) -> Result<()> {
    for process in processes.values() {
        process.terminate()?;
    }
    Ok(())
}
fn route(request: Request, processes: &mut Processes, output: &Emitter) -> Result<bool> {
    match request {
        Request::Probe { id } => reply(
            output,
            id,
            (|| -> Result<Value> {
                capability_probe()?;
                crate::windows_conpty::probe()?;
                ensure!(
                    crate::windows_handles::ProcessJob::new()?.active()? == 0,
                    "Job probe 未为空"
                );
                Ok(
                    json!({"filesystem":"enforced","processRange":"job-object","protocolVersion":2,"pty":"conpty","stdio":"ack-stream"}),
                )
            })(),
        )?,
        Request::Spawn { id, launch } => {
            let process_id = launch.process_id.clone();
            if let Err(error) = spawn(id.clone(), launch, processes, output) {
                let empty = processes
                    .get(&process_id)
                    .map(|child| child.scope_empty())
                    .unwrap_or(true);
                if !processes.contains_key(&process_id) {
                    emit(
                        output,
                        json!({"event":"exit","processId":process_id,"exitCode":null,
                        "rangeEmpty":true,"failure":error.to_string()}),
                    )?;
                }
                reply_as(
                    output,
                    id,
                    Err(error),
                    if empty {
                        "enforcement_unavailable"
                    } else {
                        "stop_unconfirmed"
                    },
                )?;
            }
        }
        Request::Stdin {
            id,
            process_id,
            data,
        } => {
            let child = process(processes, &process_id);
            let events = Arc::clone(output);
            thread::spawn(move || {
                let result = (|| -> Result<bool> {
                    let child = child?;
                    if child.is_pty() {
                        child.write_pty(&data)?;
                        Ok(true)
                    } else {
                        child.forward(&Request::Stdin {
                            id: id.clone(),
                            process_id,
                            data,
                        })?;
                        Ok(false)
                    }
                })();
                match result {
                    Ok(false) => {}
                    result => {
                        let _ = reply(&events, id, result.map(|_| Value::Null));
                    }
                }
            });
        }
        Request::Endstdin { id, process_id } => {
            let result = (|| -> Result<bool> {
                let child = process(processes, &process_id)?;
                ensure!(!child.is_pty(), "PTY 没有独立 stdin EOF");
                child.forward(&Request::Endstdin {
                    id: id.clone(),
                    process_id,
                })?;
                Ok(false)
            })();
            if result.is_err() {
                reply_as(output, id, result.map(|_| Value::Null), "process_closed")?;
            }
        }
        Request::Resize {
            id,
            process_id,
            cols,
            rows,
        } => reply(
            output,
            id,
            process(processes, &process_id)
                .and_then(|child| child.resize(cols, rows))
                .map(|_| Value::Null),
        )?,
        request @ Request::Outputack { .. } | request @ Request::Outputreader { .. } => {
            output_control(request, processes, output)?
        }
        request @ Request::Stop { .. } => {
            let Request::Stop { id, process_id } = &request else {
                unreachable!()
            };
            let result = process(processes, process_id).and_then(|child| child.stop(&request));
            match result {
                Ok(false) => {}
                result => reply_as(
                    output,
                    id.clone(),
                    result.map(|_| Value::Null),
                    "stop_unconfirmed",
                )?,
            }
        }
        Request::Close { id } => {
            reply_as(
                output,
                id,
                stop_all(processes).map(|_| Value::Null),
                "stop_unconfirmed",
            )?;
            return Ok(true);
        }
    }
    Ok(false)
}
fn output_control(request: Request, processes: &Processes, output: &Emitter) -> Result<()> {
    let (id, process_id, stream) = match &request {
        Request::Outputack {
            id,
            process_id,
            stream,
            ..
        }
        | Request::Outputreader {
            id,
            process_id,
            stream,
            ..
        } => (id, process_id, stream),
        _ => unreachable!(),
    };
    let child = process(processes, process_id)?;
    if !child.is_pty() {
        return child.forward(&request);
    }
    let result = (|| -> Result<()> {
        ensure!(stream == "stdout", "ConPTY 没有独立 stderr");
        match &request {
            Request::Outputack { sequence, .. } => child.acknowledge(*sequence),
            Request::Outputreader { active, .. } => child.reader(*active),
            _ => unreachable!(),
        }
    })();
    reply(output, id.clone(), result.map(|_| Value::Null))
}
pub fn serve() -> Result<()> {
    let output: Emitter = Arc::new(Mutex::new(Box::new(std::io::stdout())));
    let mut processes = Processes::new();
    let result = (|| -> Result<()> {
        for line in std::io::stdin().lock().lines() {
            let request = serde_json::from_str::<Request>(&line?)?;
            if route(request, &mut processes, &output)? {
                break;
            }
        }
        Ok(())
    })();
    // Parent IPC EOF or errors cannot leave any per-command controller/workload Job alive.
    let cleanup = stop_all(&processes);
    result.and(cleanup)
}
