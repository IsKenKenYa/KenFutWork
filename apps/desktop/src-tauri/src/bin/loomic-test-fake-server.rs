//! 测试替身：占住端口、对所有请求回 200，直到被杀。
//! 用法：loomic-test-fake-server <port> [--child-pid-file <path>]
//! 生命期为「被杀即退」——SIGTERM 默认终止、SIGKILL 强杀，正好用于
//! 验证 shutdown 的宽限与强杀语义（顽固子进程用例在测试里单独 trap）。
//!
//! `--child-pid-file` 会再拉起一个长命后代进程并把它的 pid 写进文件：用来验证
//! **收树**（服务端拉起内嵌 Postgres 的真实形状——壳只杀直接子进程就会留孤儿）。
fn main() {
    let mut args = std::env::args().skip(1);
    let port: u16 = args
        .next()
        .expect("用法：loomic-test-fake-server <port> [--child-pid-file <path>]")
        .parse()
        .expect("端口必须是数字");

    while let Some(flag) = args.next() {
        let path = args.next().expect("测试参数需要路径");
        match flag.as_str() {
            "--child-pid-file" => {
                let child = spawn_long_lived_child();
                std::fs::write(path, child.to_string()).expect("写后代 pid 失败");
            }
            "--startup-gate" => {
                while !std::path::Path::new(&path).exists() {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            _ => panic!("未知参数：{flag}"),
        }
    }

    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("绑定端口失败");
    eprintln!("fake-server listening on {port}");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { break };
        let body = "OK";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        use std::io::Write as _;
        let _ = stream.write_all(response.as_bytes());
    }
}

/// 起一个「至少活一分钟」的后代进程（与替身同生共死是**故意不做的**：测试要的就是孤儿）。
fn spawn_long_lived_child() -> u32 {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "ping", "-n", "60", "127.0.0.1"]);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别在测试机上弹黑框
        command
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new("sleep");

    #[cfg(not(windows))]
    command.arg("60");

    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("拉后代进程失败")
        .id()
}
