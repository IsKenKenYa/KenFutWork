// Windows GUI 子系统：不加这条，桌面壳会**带一个控制台窗口**启动（用户看到的黑框 cmd）。
// 只在 release 保留控制台（debug 下要能看 println 排障）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 桌面入口：实现在 lib.rs（Tauri 2 标准模板形态，保持 mobile_entry_point 可用）。
fn main() {
    kenfutwork_desktop_lib::run()
}
