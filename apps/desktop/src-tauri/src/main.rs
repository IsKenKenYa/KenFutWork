//! KenFutWork 桌面壳（多端计划 §4，FORM-2）。
//!
//! 职责边界（保持薄）：窗口/托盘/自更新/深链归这里；业务一律在服务端 sidecar
//! （同一份 apps/server 代码，桌面数据落本地数据目录）。当前是**探索期脚手架**：
//! devUrl 指向 web dev server（localhost:3000），服务端另行启动；
//! sidecar（内嵌服务端）与本地数据目录接线是下一步（见 README）。

#[tauri::command]
fn ping() -> String {
    "KenFutWork desktop shell".into()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
