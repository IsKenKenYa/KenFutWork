//! 测试替身：占住端口、对所有请求回 200，直到被杀。
//! 用法：loomic-test-fake-server <port>
//! 生命期为「被杀即退」——SIGTERM 默认终止、SIGKILL 强杀，正好用于
//! 验证 shutdown 的宽限与强杀语义（顽固子进程用例在测试里单独 trap）。
fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .expect("用法：loomic-test-fake-server <port>")
        .parse()
        .expect("端口必须是数字");
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .expect("绑定端口失败");
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
