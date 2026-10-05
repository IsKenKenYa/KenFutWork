//! 本机凭据只由壳读取；前端与浏览器URL只获得一次性连接票据。
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;

pub fn local_request(
    data_dir: &Path,
    port: u16,
    path: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let token = std::fs::read_to_string(data_dir.join("local-access").join("desktop-token"))
        .map_err(|error| format!("读取本机连接凭据失败：{error}"))?;
    let token = token.trim();
    if token.len() != 43
        || !token
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
    {
        return Err("本机连接凭据文件格式无效。".into());
    }
    let body = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("连接本机服务失败：{error}"))?;
    let request = format!("POST {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送本机控制请求失败：{error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("读取本机控制响应失败：{error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("本机控制响应格式无效。")?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("本机控制响应状态无效。")?;
    let value: serde_json::Value = if body.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(body).map_err(|_| "本机控制响应不是合法JSON。")?
    };
    if !(200..300).contains(&status) {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or("本机服务拒绝控制请求。");
        return Err(message.into());
    }
    Ok(value)
}

pub fn connection_url(data_dir: &Path, port: u16, ui_base: &str) -> Result<String, String> {
    let response = local_request(
        data_dir,
        port,
        "/api/local-access/tickets",
        &serde_json::json!({}),
    )?;
    let ticket = response
        .get("ticket")
        .and_then(|ticket| ticket.as_str())
        .ok_or("本机服务未签发连接票据。")?;
    if ticket.len() != 43
        || !ticket
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
    {
        return Err("连接票据格式无效。".into());
    }
    let mut url = tauri::Url::parse(ui_base).map_err(|_| "桌面界面地址格式无效。")?;
    url.set_fragment(Some(&format!("connect={ticket}")));
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn data_dir() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("kfw-native-access-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(path.join("local-access")).unwrap();
        path
    }

    #[test]
    fn native_connection_uses_private_bearer_and_returns_only_one_time_fragment() {
        let directory = data_dir();
        let token = "A".repeat(43);
        let ticket = "B".repeat(43);
        std::fs::write(directory.join("local-access/desktop-token"), &token).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0u8; 1024];
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if request.ends_with(b"\r\n\r\n{}") {
                    break;
                }
                assert!(count > 0, "请求提前断开");
            }
            let text = String::from_utf8(request).unwrap();
            assert!(text.starts_with("POST /api/local-access/tickets "));
            assert!(text.contains(&format!("Authorization: Bearer {token}\r\n")));
            let body = serde_json::json!({ "ticket": ticket, "expiresAt": "2026-10-05T00:01:00Z" })
                .to_string();
            stream.write_all(format!("HTTP/1.0 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        });
        let url = connection_url(&directory, port, &format!("http://127.0.0.1:{port}/")).unwrap();
        assert!(url.ends_with(&format!("#connect={}", "B".repeat(43))));
        assert!(!url.contains(&"A".repeat(43)));
        worker.join().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_credential_is_rejected_without_disclosing_its_content() {
        let directory = data_dir();
        std::fs::write(
            directory.join("local-access/desktop-token"),
            "secret\r\ninjection",
        )
        .unwrap();
        let error = local_request(
            &directory,
            1,
            "/api/local-access/tickets",
            &serde_json::json!({}),
        )
        .unwrap_err();
        assert_eq!(error, "本机连接凭据文件格式无效。");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
