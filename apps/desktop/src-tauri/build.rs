fn main() {
    // 图标改了必须重跑本脚本，否则 exe 里嵌的还是上一版资源。
    //
    // 2026-09-19 踩过：`icons.mjs` 重出整套图标后连续两次 `tauri build`，安装包（NSIS 侧读文件）
    // 是新的，可**壳 exe 内嵌的图标仍是两版之前那张**（按字节核对 ICO 的 256 条目才看出来），
    // 因为 tauri-build 没声明对 icons/ 的依赖、cargo 认为产物是最新的。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=installer-header.bmp");
    println!("cargo:rerun-if-changed=installer-sidebar.bmp");
    tauri_build::build()
}
