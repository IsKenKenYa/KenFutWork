#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_conpty;
#[cfg(windows)]
mod windows_controller;
#[cfg(windows)]
mod windows_handles;
#[cfg(windows)]
mod windows_launch;
#[cfg(any(windows, test))]
mod windows_output;
#[cfg(windows)]
mod windows_process;
#[cfg(windows)]
mod windows_protocol;

fn main() {
    #[cfg(windows)]
    if let Err(error) = {
        let arguments: Vec<String> = std::env::args().skip(1).collect();
        if arguments.first().map(String::as_str) == Some("--kfw-task-controller") {
            windows_controller::serve(&arguments[1..])
        } else {
            windows::serve()
        }
    } {
        // 不打印 request/env/SDK 的诊断缓冲。
        eprintln!("原生 Windows 沙箱执行失败：{error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("此 broker 仅适用于原生 Windows。");
        std::process::exit(1);
    }
}
