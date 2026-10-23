use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn select_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    Ok(pick_directories(&app, &window, false)
        .await?
        .into_iter()
        .next())
}

#[tauri::command]
pub async fn select_directories(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    pick_directories(&app, &window, true).await
}

async fn pick_directories(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    multiple: bool,
) -> Result<Vec<String>, String> {
    crate::data_location::snapshot(app, window)?;
    let dialog = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title("选择文件夹")
        .set_can_create_directories(true);
    // 系统对话框等待用户操作，不能阻塞窗口事件处理。
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selected = if multiple {
            dialog.blocking_pick_folders()
        } else {
            dialog.blocking_pick_folder().map(|path| vec![path])
        };
        let Some(paths) = selected else {
            return Ok(Vec::new());
        };
        paths.into_iter().map(directory_path).collect()
    })
    .await
    .map_err(|_| "系统目录选择框未能完成，请重新选择。".to_string())?;
    // 等待期间窗口可能导航或关闭，返回路径前重新检查可信来源。
    crate::data_location::snapshot(app, window)?;
    result
}

fn directory_path(selected: FilePath) -> Result<String, String> {
    let path = selected
        .into_path()
        .map_err(|_| "所选目录不是本机路径，请重新选择。".to_string())?;
    if !path.is_absolute() {
        return Err("所选目录不是完整路径，请重新选择。".into());
    }
    let metadata =
        std::fs::metadata(&path).map_err(|_| "所选文件夹已不可用，请重新选择。".to_string())?;
    if !metadata.is_dir() {
        return Err("所选路径不是文件夹，请重新选择。".into());
    }
    // 路径中的空格属于名称；不能裁去空白或用替代字符改写路径。
    path.into_os_string()
        .into_string()
        .map_err(|_| "文件夹名称无法读取，请修改名称后重新选择。".to_string())
}
